import * as fs from 'node:fs'
import { join } from 'node:path'
import { freezePlanRevision } from '@dag/definition/plan.js'
import type {
  Amendment,
  PlanDefinition,
  PlanRevision,
} from '@dag/definition/schema.js'
import { executableNodes } from '@dag/policy.js'
import { affectedDagNodes } from '@dag/run/amendment.js'
import { stageManagedRestart } from '@dag/run/recovery.js'
import type { RunResult } from '@dag/run/types.js'
import {
  atomicWrite,
  RunOwner,
  type RunState,
  readRunState,
} from '@dag/state.js'
import { assertTarget, authorizeTarget } from '@dag/workspace/workspace.js'
import type {
  ModelRuntime,
  ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import { downstreamDags, drivePlan } from './composition.js'
import { CompositionError, identity } from './evidence.js'
import {
  assertOverallCheckEvidence,
  interruptedOverallCheck,
  pendingOverallRestart,
  stageOverallRestart,
} from './overall.js'

function frozenPlanRevision(state: RunState, directory: string): PlanRevision {
  const path = state.snapshots['plan']
  if (!path || identity(path).sha256 !== state.snapshots['planSha256'])
    throw new CompositionError('changed-plan-snapshot', path ?? directory)
  const revision: PlanRevision = JSON.parse(fs.readFileSync(path, 'utf8'))
  if (
    revision.id !== state.revisions.at(-1)?.identity ||
    revision.plan.projectRoot !== state.target.root
  )
    throw new CompositionError('changed-plan-snapshot', path)
  return revision
}
function reviewedOverallInput(state: RunState): void {
  const overall = state.snapshots['overallInput']
  if (
    overall &&
    (identity(overall).sha256 !== state.snapshots['overallInputSha256'] ||
      state.assignments['overall-review']?.attempts.at(-1)?.baseline !==
        state.target.expectedRevision)
  )
    throw new CompositionError('changed-overall-inputs', overall)
}
function executableEntry(
  entry: PlanDefinition['dags'][string],
  classification: Amendment['classification'],
): string {
  if (entry.kind === 'deferred')
    return JSON.stringify({
      kind: entry.kind,
      needs: entry.needs,
      satisfies: entry.satisfies,
    })
  const definition = entry.definition
  if (classification === 'material')
    return JSON.stringify({
      kind: entry.kind,
      needs: entry.needs,
      satisfies: entry.satisfies,
      definition,
    })
  return JSON.stringify({
    kind: entry.kind,
    needs: entry.needs,
    satisfies: entry.satisfies,
    definition: {
      ...definition,
      context: undefined,
      goal: undefined,
      criteria: Object.keys(definition.criteria),
      nodes: executableNodes(definition.nodes),
    },
  })
}
function assertStableDagIdentity(
  id: string,
  prior: PlanDefinition['dags'][string],
  next: PlanDefinition['dags'][string] | undefined,
  saved: NonNullable<RunState['children']>[string] | undefined,
): void {
  const attempted = Boolean(
    saved &&
      Object.values(saved.assignments).some(
        (assignment) => assignment.attempts.length > 0,
      ),
  )
  if (
    attempted &&
    (prior.kind !== 'file' ||
      next?.kind !== 'file' ||
      prior.definition.name !== next.definition.name ||
      Object.keys(saved?.assignments ?? {}).some(
        (node) =>
          Object.hasOwn(prior.definition.nodes, node) &&
          !Object.hasOwn(next.definition.nodes, node),
      ))
  )
    throw new CompositionError('attempted-identity-change', id)
}
function affectedDags(
  previous: PlanRevision,
  revision: PlanRevision,
  state: RunState,
): ReadonlySet<string> {
  const classification = revision.amendment?.classification ?? 'material'
  const changed = new Set<string>()
  for (const [id, prior] of Object.entries(previous.plan.dags)) {
    const next = revision.plan.dags[id]
    const oldAssignments = previous.assignments.dags[id]
    const nextAssignments = revision.assignments.dags[id]
    assertStableDagIdentity(id, prior, next, state.children?.[id])
    if (
      !next ||
      executableEntry(prior, classification) !==
        executableEntry(next, classification) ||
      JSON.stringify(previous.assignments.dags[id]?.profiles) !==
        JSON.stringify(revision.assignments.dags[id]?.profiles) ||
      (prior.kind === 'file' &&
        next.kind === 'file' &&
        oldAssignments &&
        nextAssignments &&
        affectedDagNodes(
          { definition: prior.definition, assignments: oldAssignments },
          { definition: next.definition, assignments: nextAssignments },
          classification,
        ).length > 0)
    )
      changed.add(id)
  }
  for (const id of Object.keys(revision.plan.dags))
    if (!previous.plan.dags[id]) changed.add(id)
  const affected = new Set(changed)
  for (const id of changed)
    for (const child of downstreamDags(revision.plan, id)) affected.add(child)
  return affected
}
function pendingAffectedNodes(
  state: RunState,
  previous: PlanRevision,
  revision: PlanRevision,
  affected: ReadonlySet<string>,
) {
  const classification = revision.amendment?.classification ?? 'material'
  const affectedNodes = { ...state.affectedNodes }
  for (const id of affected) {
    const prior = previous.plan.dags[id]
    const next = revision.plan.dags[id]
    const oldAssignments = previous.assignments.dags[id]
    const nextAssignments = revision.assignments.dags[id]
    if (
      prior?.kind !== 'file' ||
      next?.kind !== 'file' ||
      !oldAssignments ||
      !nextAssignments ||
      JSON.stringify(prior.needs) !== JSON.stringify(next.needs)
    ) {
      delete affectedNodes[id]
      continue
    }
    const nodes = affectedDagNodes(
      { definition: prior.definition, assignments: oldAssignments },
      { definition: next.definition, assignments: nextAssignments },
      classification,
    )
    if (
      (executableEntry(prior, classification) ===
        executableEntry(next, classification) &&
        nodes.length === 0 &&
        JSON.stringify(oldAssignments.profiles) ===
          JSON.stringify(nextAssignments.profiles)) ||
      (state.invalidated?.includes(id) && !state.affectedNodes?.[id])
    ) {
      delete affectedNodes[id]
      continue
    }
    affectedNodes[id] = [
      ...new Set([...(state.affectedNodes?.[id] ?? []), ...nodes]),
    ]
  }
  return affectedNodes
}
function stagePlanRevision(
  directory: string,
  state: RunState,
  revision: PlanRevision,
  affected: ReadonlySet<string>,
  previous: PlanRevision,
  reason: string,
): RunState {
  const owner = RunOwner.acquire({
    runDirectory: directory,
    target: state.target,
  })
  try {
    if (JSON.stringify(readRunState(directory)) !== JSON.stringify(state))
      throw new CompositionError('stale-state', directory)
    const snapshot = join(
      owner.runDirectory,
      `plan-revision-${state.revisions.length}.json`,
    )
    atomicWrite(snapshot, revision)
    const frozen = identity(snapshot)
    const {
      overallInput: _input,
      overallInputSha256: _sha,
      overallVerdict: _verdict,
      ...snapshots
    } = state.snapshots
    const overall = state.assignments['overall-review']
    const updated: RunState = {
      ...state,
      revisionPending: true,
      snapshots: { ...snapshots, plan: snapshot, planSha256: frozen.sha256 },
      assignments:
        overall?.stage === 'interrupted' && overall.attempts.at(-1)?.sessionId
          ? {
              ...state.assignments,
              'overall-review': { ...overall, stage: 'ready' },
            }
          : state.assignments,
      cycle:
        state.cycle && affected.has(state.cycle.dagId) ? null : state.cycle,
      revisions: [
        ...state.revisions.map((entry) => ({
          ...entry,
          sha256: entry.sha256 ?? identity(entry.source).sha256,
        })),
        {
          identity: revision.id,
          sha256: frozen.sha256,
          source: snapshot,
          expanded: snapshot,
          reason,
          review: revision.review.receipt.evidencePath,
        },
      ],
      approved: (state.approved ?? []).filter((id) => !affected.has(id)),
      affectedNodes: pendingAffectedNodes(state, previous, revision, affected),
      invalidated: [
        ...new Set([
          ...(state.invalidated ?? []),
          ...[...affected].filter((id) => Boolean(state.children?.[id])),
        ]),
      ],
      needsAuthor: state.needsAuthor,
    }
    owner.write(updated)
    return updated
  } finally {
    owner.release()
  }
}

/** Recovery is explicit: restore the frozen revision and exact saved resources under one live owner. */
export async function resumePlan(options: {
  readonly runDirectory: string
  readonly runtime: ModelRuntime
  readonly signal: AbortSignal
}): Promise<RunResult> {
  const state = readRunState(options.runDirectory)
  if (state.status === 'succeeded')
    return { runDirectory: options.runDirectory, state }
  if (
    state.status !== 'paused' &&
    !(state.status === 'needs-author' && state.revisionPending)
  )
    throw new CompositionError('not-paused', options.runDirectory)
  assertTarget(state.target)
  reviewedOverallInput(state)
  const interrupted = interruptedOverallCheck(state)
  if (interrupted) {
    assertOverallCheckEvidence(interrupted)
    if (
      interrupted.inputs['startedCheck'] !== undefined &&
      !pendingOverallRestart(state, interrupted)
    )
      throw new CompositionError(
        'uncertain-command-requires-restart',
        'overall-review',
      )
  }
  const revision = frozenPlanRevision(state, options.runDirectory)
  const owner = RunOwner.acquire({
    runDirectory: options.runDirectory,
    target: state.target,
  })
  const authority = authorizeTarget(
    state.target.root,
    () => readRunState(options.runDirectory).target,
  )
  try {
    if (
      JSON.stringify(readRunState(options.runDirectory)) !==
      JSON.stringify(state)
    )
      throw new CompositionError('stale-state', options.runDirectory)
    owner.write({
      ...state,
      status: 'running',
      ...(state.revisionPending
        ? { revisionPending: false, needsAuthor: null }
        : {}),
    })
    return await drivePlan(
      {
        revision,
        runId: state.runId,
        runtime: options.runtime,
        signal: options.signal,
      },
      owner,
      true,
    )
  } finally {
    authority()
    owner.release()
  }
}
/** Review and freeze the next authored revision. Execution is exclusively a later resume. */
export async function amendPlan(options: {
  readonly runDirectory: string
  readonly plan: PlanDefinition
  readonly amendment: Amendment
  readonly reviewSource?: string
  readonly runtime: ModelRuntime
  readonly resources: ResourceLoader
  readonly onPreview?: (preview: {
    readonly affectedTasks: readonly string[]
    readonly budgets: {
      readonly before: Readonly<Record<string, PlanDefinition['limits']>>
      readonly after: Readonly<Record<string, PlanDefinition['limits']>>
    }
  }) => void
}): Promise<RunState> {
  const state = readRunState(options.runDirectory)
  if (
    !['paused', 'needs-author'].includes(state.status) ||
    state.revisionPending
  )
    throw new CompositionError('amend-not-admissible', options.runDirectory)
  assertTarget(state.target)
  const previous = frozenPlanRevision(state, options.runDirectory)
  if (
    options.plan.projectRoot !== state.target.root ||
    options.plan.profilesPath !== previous.plan.profilesPath
  )
    throw new CompositionError('changed-plan-snapshot', options.runDirectory)
  const revision = await freezePlanRevision(options.plan, {
    modelRuntime: options.runtime,
    resources: options.resources,
    previous,
    amendment: options.amendment,
    ...(options.reviewSource ? { reviewSource: options.reviewSource } : {}),
  })
  const affected = affectedDags(previous, revision, state)
  const budgets = (plan: PlanDefinition) => ({
    [plan.name]: plan.limits,
    ...Object.fromEntries(
      Object.entries(plan.dags).flatMap(([id, entry]) =>
        entry.kind === 'file' ? [[`dag/${id}`, entry.definition.limits]] : [],
      ),
    ),
  })
  const nodes = pendingAffectedNodes(state, previous, revision, affected)
  options.onPreview?.({
    affectedTasks: [...affected].flatMap((id) =>
      nodes[id]?.length ? nodes[id].map((node) => `${id}/${node}`) : [id],
    ),
    budgets: { before: budgets(previous.plan), after: budgets(revision.plan) },
  })
  return stagePlanRevision(
    options.runDirectory,
    state,
    revision,
    affected,
    previous,
    options.amendment.reason,
  )
}
async function stageChildRestart(
  state: RunState,
  revision: PlanRevision,
  assignment: string,
  reason: string,
) {
  const [dagId, nodeId, extra] = assignment.split('/')
  const entry = dagId ? revision.plan.dags[dagId] : undefined
  const child = dagId ? state.children?.[dagId] : undefined
  if (!dagId || !nodeId || extra || entry?.kind !== 'file' || !child)
    throw new CompositionError('restart-not-admissible', assignment)
  return {
    dagId,
    state: await stageManagedRestart(child, entry.definition, nodeId, reason),
  }
}
/** Stage an explicit saved child restart or uncertain overall-command repeat. */
export async function restartPlan(options: {
  readonly runDirectory: string
  readonly assignment: string
  readonly reason: string
}): Promise<RunState> {
  const state = readRunState(options.runDirectory)
  if (
    state.status !== 'paused' ||
    (state.revisionPending && options.assignment !== 'overall-review')
  )
    throw new CompositionError('restart-not-admissible', options.assignment)
  assertTarget(state.target)
  const revision = frozenPlanRevision(state, options.runDirectory)
  const updated =
    options.assignment === 'overall-review'
      ? { dagId: undefined, state: stageOverallRestart(state, options.reason) }
      : await stageChildRestart(
          state,
          revision,
          options.assignment,
          options.reason,
        )
  const owner = RunOwner.acquire({
    runDirectory: options.runDirectory,
    target: state.target,
  })
  try {
    if (
      JSON.stringify(readRunState(options.runDirectory)) !==
      JSON.stringify(state)
    )
      throw new CompositionError('stale-state', options.runDirectory)
    if (updated.dagId) owner.child(updated.dagId).write(updated.state)
    else owner.write(updated.state)
    return readRunState(options.runDirectory)
  } finally {
    owner.release()
  }
}
