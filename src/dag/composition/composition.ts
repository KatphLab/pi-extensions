import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { join } from 'node:path'
import {
  type PlanRevision,
  parseReviewReport,
  type ReviewReport,
} from '@dag/definition/schema.js'
import { fileIdentity, verdictEnvelope } from '@dag/run/checkpoint.js'
import { managedDag } from '@dag/run/run.js'
import type { ManagedDag, RunResult } from '@dag/run/types.js'
import { ExecutionCapacity } from '@dag/scheduler.js'
import {
  atomicWrite,
  type DagRunOwner,
  RunOwner,
  type RunState,
  readRunState,
} from '@dag/state.js'
import { restoreWorkspace } from '@dag/workspace/checkpoint.js'
import type { AcceptedInput, Prerequisite } from '@dag/workspace/types.js'
import { authorizeTarget, captureTarget } from '@dag/workspace/workspace.js'
import { CompositionError, identity } from './evidence.js'
import { OverallReview } from './overall.js'
import type { PlanRunRequest } from './types.js'

type Managed = ManagedDag
/** A DAG id may prefix another id; only the longest matching entry owns the target. */
export function blockingEntry<T>(
  entries: readonly (readonly [string, T])[],
  assignment: string,
): readonly [string, T] | undefined {
  return entries
    .filter(([id]) => assignment.startsWith(`${id}.`))
    .sort(([left], [right]) => right.length - left.length)[0]
}
/** Route only the overall verdict that was accepted, not whatever sits at its path. */
export function assertOverallVerdict(
  state: { readonly snapshots: Readonly<Record<string, string>> },
  verdictPath: string,
): ReviewReport {
  const expected = state.snapshots['overallVerdictSha256']
  const saved = verdictEnvelope(fs.readFileSync(verdictPath, 'utf8'))
  if (
    !expected ||
    !saved ||
    fileIdentity(verdictPath).sha256 !== expected ||
    fileIdentity(saved.input.path).sha256 !== saved.input.sha256 ||
    fileIdentity(saved.report.path).sha256 !== saved.report.sha256
  )
    throw new CompositionError('changed-overall-verdict', verdictPath)
  return parseReviewReport(fs.readFileSync(saved.report.path, 'utf8'))
}
/** The parent is the sole state writer, target owner, capacity pool and cycle adjudicator. */
export async function runPlan(request: PlanRunRequest): Promise<RunResult> {
  const { revision } = request
  const target = captureTarget(revision.plan.projectRoot)
  const runDirectory = join(target.root, '.pi/dags/runs', request.runId)
  if (fs.existsSync(runDirectory))
    throw new CompositionError('existing-run', runDirectory)
  const owner = RunOwner.acquire({ runDirectory, target })
  const authority = authorizeTarget(
    target.root,
    () => readRunState(runDirectory).target,
  )
  try {
    const snapshot = join(runDirectory, 'plan-snapshot.json')
    atomicWrite(snapshot, revision)
    const frozen = identity(snapshot)
    owner.write({
      schema: 1,
      runId: request.runId,
      status: 'running',
      target,
      snapshots: { plan: snapshot, planSha256: frozen.sha256 },
      revisions: [
        {
          identity: revision.id,
          sha256: frozen.sha256,
          source: snapshot,
          expanded: snapshot,
          reason: 'initial admitted plan',
          review: revision.review.receipt.evidencePath,
        },
      ],
      assignments: {},
      repairRounds: {},
      cycle: null,
      needsAuthor: null,
      children: {},
    })
    return await drivePlan(request, owner)
  } finally {
    authority()
    owner.release()
  }
}

export function drivePlan(
  request: PlanRunRequest,
  owner: RunOwner,
  recovering = false,
): Promise<RunResult> {
  return new PlanCoordinator(request, owner).execute(recovering)
}

function orderedDagIds(plan: PlanRevision['plan']): readonly string[] {
  const visited = new Set<string>()
  const order: string[] = []
  const visit = (id: string) => {
    if (visited.has(id)) return
    for (const need of plan.dags[id]?.needs ?? []) visit(need)
    visited.add(id)
    order.push(id)
  }
  for (const id of Object.keys(plan.dags).sort((a, b) => a.localeCompare(b)))
    visit(id)
  return order
}
export function downstreamDags(
  plan: PlanRevision['plan'],
  root: string,
): readonly string[] {
  const descendants = new Set([root])
  for (const id of orderedDagIds(plan))
    if (plan.dags[id]?.needs.some((need) => descendants.has(need)))
      descendants.add(id)
  descendants.delete(root)
  return [...descendants]
}
/** The parent coordinates DAG engines; only those engines execute node and cycle work. */
class PlanCoordinator {
  private readonly entries: [string, PlanRevision['plan']['dags'][string]][]
  private readonly capacity: ExecutionCapacity
  private readonly instances = new Map<string, Managed>()
  private readonly reviewed = new Map<string, Prerequisite>()
  private readonly integrated = new Map<string, Prerequisite>()
  private readonly trusted = new Map<
    string,
    {
      readonly inputs: readonly AcceptedInput[]
      readonly merges: readonly string[]
    }
  >()
  private readonly executing = new Map<string, Promise<void>>()
  private readonly cycles: string[] = []
  private cycling: Promise<void> | undefined
  private stopped: Error | undefined
  private readonly authorBlocked = new Set<string>()
  constructor(
    private readonly request: PlanRunRequest,
    private readonly owner: RunOwner,
  ) {
    this.entries = Object.entries(request.revision.plan.dags)
    this.capacity = new ExecutionCapacity(
      request.revision.plan.limits.concurrency,
    )
  }

  private result(): RunResult {
    return {
      runDirectory: this.owner.runDirectory,
      state: readRunState(this.owner.runDirectory),
    }
  }
  private child(
    id: string,
    owner: DagRunOwner = this.owner.child(id),
    reviewed: ReadonlyMap<string, Prerequisite> = this.reviewed,
    integrated: ReadonlyMap<string, Prerequisite> = this.integrated,
    revision: PlanRevision = this.request.revision,
  ): Managed {
    const entry = revision.plan.dags[id]
    if (entry?.kind !== 'file') throw new CompositionError('missing-dag', id)
    const assignments = revision.assignments.dags[id]
    if (!assignments) throw new CompositionError('missing-assignment', id)
    return managedDag(
      {
        projectRoot: revision.plan.projectRoot,
        runId: `${this.request.runId}.${id}`,
        definition: entry.definition,
        assignments,
        source: Object.fromEntries(
          Object.values(revision.plan.documents).map((doc) => [
            doc.path,
            doc.content,
          ]),
        ),
        runtime: this.request.runtime,
        signal: this.request.signal,
      },
      owner,
      {
        capacity: this.capacity,
        prerequisites: entry.needs.map((need) => {
          const prerequisite = reviewed.get(need)
          if (!prerequisite)
            throw new CompositionError('unreviewed-input', need)
          return prerequisite
        }),
        integrated: () =>
          [...integrated.values()].filter((input) => input.write.length > 0),
        imports: () =>
          [...this.trusted.values()].flatMap((value) => value.inputs),
        importedMerges: () =>
          [...this.trusted.values()].flatMap((value) => value.merges),
      },
    )
  }
  private stop(error: unknown): void {
    this.stopped = error instanceof Error ? error : new Error(String(error))
  }
  private startWorkers(id: string, instance: Managed): void {
    const job = instance
      .executeWorkers()
      .then((result) => {
        if (result.state.status === 'running') this.cycles.push(id)
        else if (result.state.status === 'needs-author')
          this.authorBlocked.add(id)
        else if (result.state.status !== 'succeeded')
          this.stopped = new CompositionError(result.state.status, id)
      })
      .catch((error: unknown) => this.stop(error))
      .finally(() => {
        this.executing.delete(id)
      })
    this.executing.set(id, job)
  }
  private trust(
    id: string,
    evidence: Pick<Managed['managedResult'], 'inputs' | 'merges'>,
  ): void {
    const prior = this.trusted.get(id)
    const inputs = [...(prior?.inputs ?? []), ...evidence.inputs]
    this.trusted.set(id, {
      inputs: [
        ...new Map(
          inputs.map((input) => [input.contribution.receipt, input]),
        ).values(),
      ],
      merges: [...new Set([...(prior?.merges ?? []), ...evidence.merges])],
    })
  }
  private trustedRevision(revision: string): boolean {
    for (const evidence of this.trusted.values())
      if (
        evidence.merges.includes(revision) ||
        evidence.inputs.some(
          (input) => input.contribution.revision === revision,
        )
      )
        return true
    return false
  }
  /** Retained target ancestry supplies provenance, never a reviewed prerequisite. */
  private restoreLineage(
    state: RunState,
    tip: string,
    restored: Set<string>,
  ): void {
    for (const [id, saved] of Object.entries(state.children ?? {})) {
      const revision = saved.target.expectedRevision
      if (
        state.approved?.includes(id) ||
        restored.has(id) ||
        revision === tip ||
        this.trustedRevision(revision)
      )
        continue
      const ancestry = spawnSync(
        'git',
        ['-C', state.target.root, 'merge-base', '--is-ancestor', revision, tip],
        { env: { ...process.env, GIT_MASTER: '1' }, encoding: 'utf8' },
      )
      if (ancestry.status === 1) continue
      if (ancestry.status !== 0)
        throw new CompositionError('changed-target-history', revision)
      restored.add(id)
      this.restoreLineage(state, revision, restored)
      this.trust(
        id,
        restoreWorkspace(
          this.owner.child(id),
          [...this.trusted.values()].flatMap((value) => value.inputs),
          [...this.trusted.values()].flatMap((value) => value.merges),
        ),
      )
    }
  }
  private async restoreArchives(state: RunState): Promise<void> {
    const reviewed = new Map<string, Prerequisite>()
    const integrated = new Map<string, Prerequisite>()
    const lineage = new Set<string>()
    for (const [index, approval] of (state.approvals ?? []).entries()) {
      const owner = this.owner.archivedChild(index)
      const source = state.revisions.find(
        (item) =>
          item.identity === (approval.revision ?? state.revisions[0]?.identity),
      )
      if (!source)
        throw new CompositionError('missing-plan-revision', approval.dagId)
      const revision: PlanRevision = JSON.parse(
        fs.readFileSync(source.source, 'utf8'),
      )
      if (
        revision.id !== source.identity ||
        fs.realpathSync(source.source) !== source.source ||
        (source.sha256 && identity(source.source).sha256 !== source.sha256)
      )
        throw new CompositionError('changed-plan-snapshot', source.source)
      this.restoreLineage(
        state,
        approval.child.target.expectedRevision,
        lineage,
      )
      const instance = this.child(
        approval.dagId,
        owner,
        reviewed,
        integrated,
        revision,
      )
      await instance.restoreManaged(approval.child, true)
      const result = instance.reviewedResult(approval.dagId)
      reviewed.set(approval.dagId, result.handoff)
      integrated.set(approval.dagId, result.target)
      this.trust(approval.dagId, instance.managedResult)
    }
  }
  private async restoreApproved(state: RunState): Promise<void> {
    for (const id of orderedDagIds(this.request.revision.plan)) {
      if (!state.approved?.includes(id) || state.invalidated?.includes(id))
        continue
      const entry = this.request.revision.plan.dags[id]
      if (!entry?.needs.every((need) => this.reviewed.has(need))) continue
      const saved = state.children?.[id]
      if (saved?.status !== 'succeeded')
        throw new CompositionError('unreviewed-input', id)
      const instance = this.child(id)
      await instance.restoreManaged(saved, true)
      this.instances.set(id, instance)
      const result = instance.reviewedResult(id)
      this.reviewed.set(id, result.handoff)
      this.integrated.set(id, result.target)
      this.trust(id, instance.managedResult)
    }
  }
  private async restorePending(state: RunState): Promise<void> {
    for (const [id, saved] of Object.entries(state.children ?? {})) {
      if (this.instances.has(id)) continue
      const entry = this.request.revision.plan.dags[id]
      if (
        state.invalidated?.includes(id) &&
        !entry?.needs.every((need) => this.reviewed.has(need))
      )
        continue
      const instance = this.child(id)
      await instance.restoreManaged(
        saved,
        Boolean(state.invalidated?.includes(id)),
      )
      if (state.invalidated?.includes(id)) {
        instance.invalidateForUpstream(
          state.revisions.length > 1,
          state.affectedNodes?.[id],
        )
      }
      this.instances.set(id, instance)
      if (instance.managedResult.needsWorkers) this.startWorkers(id, instance)
      else this.cycles.push(id)
    }
  }
  private async restore(): Promise<void> {
    const previous = readRunState(this.owner.runDirectory)
    await this.restoreArchives(previous)
    await this.restoreApproved(previous)
    await this.restorePending(previous)
    const held = previous.cycle?.dagId
    if (held && !this.executing.has(held)) {
      const index = this.cycles.indexOf(held)
      if (index < 0) throw new CompositionError('missing-cycle', held)
      this.cycles.splice(index, 1)
      this.cycles.unshift(held)
    }
  }
  private launch(): void {
    if (this.stopped || this.request.signal.aborted) return
    for (const [id, entry] of this.entries) {
      if (
        entry.kind !== 'file' ||
        this.instances.has(id) ||
        readRunState(this.owner.runDirectory).invalidated?.includes(id)
      )
        continue
      if (!entry.needs.every((need) => this.reviewed.has(need))) continue
      const instance = this.child(id)
      this.instances.set(id, instance)
      this.startWorkers(id, instance)
    }
  }
  private startCycle(): void {
    if (this.cycling || this.cycles.length === 0 || this.stopped) return
    const held = readRunState(this.owner.runDirectory).cycle?.dagId
    const index = held ? this.cycles.indexOf(held) : 0
    if (index < 0) return // The held owner's repair worker is still running.
    const [id] = this.cycles.splice(index, 1)
    const instance = id ? this.instances.get(id) : undefined
    if (!id || !instance) throw new CompositionError('missing-dag', id ?? '')
    this.owner.claimCycle(id)
    this.cycling = instance
      .executeCycle()
      .then((result) => {
        if (result.state.status === 'succeeded') {
          const reviewed = instance.reviewedResult(id)
          this.reviewed.set(id, reviewed.handoff)
          this.integrated.set(id, reviewed.target)
          this.owner.approveCycle(id)
        } else if (result.state.status === 'needs-author')
          this.authorBlocked.add(id)
        else this.stopped = new CompositionError(result.state.status, id)
      })
      .catch((error: unknown) => this.stop(error))
      .finally(() => {
        this.cycling = undefined
      })
  }
  private async settle(): Promise<void> {
    while (!this.request.signal.aborted) {
      this.launch()
      this.startCycle()
      const active = [
        ...this.executing.values(),
        ...(this.cycling !== undefined ? [this.cycling] : []),
      ]
      if (active.length === 0) break
      await Promise.race(active)
      if (this.stopped) break
    }
    if (this.request.signal.aborted || this.stopped)
      await Promise.all([
        ...this.executing.values(),
        ...(this.cycling !== undefined ? [this.cycling] : []),
      ])
  }
  private stoppedResult(): RunResult | undefined {
    const current = readRunState(this.owner.runDirectory)
    if (this.request.signal.aborted) {
      this.owner.write({ ...current, status: 'paused' })
      return this.result()
    }
    if (!this.stopped && this.authorBlocked.size === 0) return undefined
    const failure = join(this.owner.runDirectory, 'failure.json')
    if (this.stopped)
      atomicWrite(failure, {
        name: this.stopped.name,
        message: this.stopped.message,
        cause:
          this.stopped.cause instanceof Error
            ? this.stopped.cause.message
            : null,
      })
    const status =
      this.authorBlocked.size > 0 ||
      (this.stopped instanceof CompositionError &&
        ['needs-author', 'failed'].includes(this.stopped.code))
        ? 'needs-author'
        : 'paused'
    const child =
      this.authorBlocked.values().next().value ??
      (this.stopped instanceof CompositionError ? this.stopped.resource : '')
    this.owner.write({
      ...current,
      status,
      needsAuthor:
        current.children?.[child]?.needsAuthor ?? current.needsAuthor,
    })
    return this.result()
  }
  private deferredResult(): RunResult | undefined {
    const deferred = this.entries.find(
      ([, entry]) =>
        entry.kind === 'deferred' &&
        entry.needs.every((need) => this.reviewed.has(need)),
    )
    if (!deferred) return undefined
    const [id, entry] = deferred
    if (entry.kind !== 'deferred')
      throw new CompositionError('invalid-deferred', id)
    const path = join(this.owner.runDirectory, 'needs-author.json')
    atomicWrite(path, {
      dag: id,
      objective: entry.deferred.objective,
      decisionNeeded: entry.deferred.decisionNeeded,
      affectedAssignments: [
        id,
        ...downstreamDags(this.request.revision.plan, id),
      ],
      findings: [
        {
          assignment: id,
          reason: 'deferred-author-decision',
          evidence: [...this.reviewed.values()]
            .map((value) => value.reviewVerdict?.path)
            .filter((path): path is string => Boolean(path)),
        },
      ],
      reviewed: [...this.reviewed.keys()],
    })
    this.owner.write({
      ...this.result().state,
      status: 'needs-author',
      needsAuthor: path,
    })
    return this.result()
  }
  private async routeOverall(outcome: RunResult): Promise<boolean> {
    const verdictPath = outcome.state.snapshots['overallVerdict']
    if (!verdictPath) return false
    const report = assertOverallVerdict(outcome.state, verdictPath)
    const blocker = report.findings.find(
      (finding) => finding.severity === 'blocker',
    )
    if (!blocker || report.verdict === 'needs-author') return false
    const match = blockingEntry(this.entries, blocker.assignment)
    if (match?.[1].kind !== 'file') return false
    const [id, entry] = match
    const assignment = blocker.assignment.slice(id.length + 1)
    const instance = this.instances.get(id)
    const keys = Object.keys(entry.definition.criteria)
    const criterion = Object.hasOwn(
      entry.definition.criteria,
      blocker.criterion,
    )
      ? blocker.criterion
      : keys.length === 1
        ? keys[0]
        : undefined
    if (
      !instance ||
      !criterion ||
      !Object.hasOwn(entry.definition.nodes, assignment)
    )
      return false
    const dependents = downstreamDags(this.request.revision.plan, id).filter(
      (child) => outcome.state.approved?.includes(child),
    )
    this.owner.reopenCycle(id, dependents)
    await instance.repairFromOverall({
      ...report,
      verdict: 'changes-requested',
      findings: [{ ...blocker, assignment, criterion }],
    })
    return true
  }
  private async overallOutcome(): Promise<RunResult> {
    try {
      return await new OverallReview(
        this.request,
        this.owner,
        this.capacity,
        this.reviewed,
      ).execute()
    } catch (error) {
      if (
        error instanceof CompositionError &&
        error.code === 'overall-check-interrupted'
      )
        return this.result()
      if (
        !(error instanceof CompositionError) ||
        error.code !== 'overall-check-failed'
      )
        throw error
      const path = join(this.owner.runDirectory, 'needs-author.json')
      atomicWrite(path, {
        reason: error.code,
        receipt: error.resource,
        reviewed: [...this.reviewed.keys()],
      })
      this.owner.write({
        ...this.result().state,
        status: 'needs-author',
        needsAuthor: path,
      })
      return this.result()
    }
  }
  private async finish(): Promise<RunResult> {
    const stopped = this.stoppedResult()
    if (stopped) return stopped
    if (
      this.result().state.invalidated?.some((id) =>
        this.request.revision.plan.dags[id]?.needs.every((need) =>
          this.reviewed.has(need),
        ),
      )
    )
      return drivePlan(this.request, this.owner, true)
    const deferred = this.deferredResult()
    if (deferred) return deferred
    if (this.reviewed.size !== this.entries.length) {
      this.owner.write({ ...this.result().state, status: 'needs-author' })
      return this.result()
    }
    const outcome = await this.overallOutcome()
    if (
      outcome.state.status !== 'needs-author' ||
      !(await this.routeOverall(outcome))
    )
      return outcome
    const repaired = this.result().state
    const held = repaired.cycle?.dagId
    if (held && repaired.children?.[held]?.status === 'needs-author') {
      this.owner.write({
        ...repaired,
        status: 'needs-author',
        needsAuthor: repaired.children[held]?.needsAuthor ?? null,
      })
      return this.result()
    }
    return drivePlan(this.request, this.owner, true)
  }
  async execute(recovering: boolean): Promise<RunResult> {
    try {
      if (recovering) await this.restore()
      await this.settle()
      return await this.finish()
    } catch (error) {
      const current = readRunState(this.owner.runDirectory)
      this.owner.write({
        ...current,
        status: 'paused',
        assignments: Object.fromEntries(
          Object.entries(current.assignments).map(([id, assignment]) => [
            id,
            ['running', 'checking'].includes(assignment.stage)
              ? { ...assignment, stage: 'interrupted' }
              : assignment,
          ]),
        ),
      })
      throw error
    }
  }
}
