import { join } from 'node:path'
import type {
  AssignmentSnapshots,
  DagDefinition,
} from '@dag/definition/schema.js'
import { executableNodes } from '@dag/policy.js'
import { atomicWrite, type RunState } from '@dag/state.js'
import { assertTarget } from '@dag/workspace/workspace.js'
import { fileIdentity } from './checkpoint.js'
import { assertRunOwnership } from './context.js'
import { RunError } from './error.js'
import { acquireRecoveryOwner, frozenRun } from './inspection.js'

function standalonePolicy(
  definition: DagDefinition,
  assignments: AssignmentSnapshots,
): string {
  return JSON.stringify({
    nodes: executableNodes(definition.nodes),
    criteria: Object.keys(definition.criteria),
    limits: definition.limits,
    verify: definition.verify,
    integration: definition.integration,
    review: definition.review,
    nodeProfiles: Object.fromEntries(
      Object.entries(assignments.nodes).map(([id, assignment]) => [
        id,
        assignment.profile,
      ]),
    ),
    profiles: assignments.profiles,
  })
}

/** The persisted closure identifies only authored contracts whose accepted inputs changed. */
export function affectedDagNodes(
  previous: {
    readonly definition: DagDefinition
    readonly assignments: AssignmentSnapshots
  },
  next: {
    readonly definition: DagDefinition
    readonly assignments: AssignmentSnapshots
  },
  classification: 'minor' | 'material' = 'material',
): readonly string[] {
  const policy = (id: string, source: typeof previous) => {
    const node = source.definition.nodes[id]
    const assignment = source.assignments.nodes[id]
    if (!node || !assignment) return
    if (classification === 'material')
      return JSON.stringify({
        id: assignment.id,
        node,
        goal: assignment.goal,
        criteria: assignment.criteria,
        context: assignment.context,
        profile: assignment.profile,
        skills: assignment.skills,
        instructions: assignment.instructions,
      })
    return JSON.stringify({
      node: {
        ...node,
        ...('task' in node ? { task: undefined } : {}),
        references: undefined,
      },
      profile: assignment.profile,
      skills: assignment.skills,
      instructions: assignment.instructions,
      criteria: Object.keys(assignment.criteria),
    })
  }
  const changed = new Set(
    Object.keys(next.definition.nodes).filter(
      (id) => policy(id, previous) !== policy(id, next),
    ),
  )
  let added = true
  while (added) {
    added = false
    for (const [id, node] of Object.entries(next.definition.nodes)) {
      if (!changed.has(id) && node.needs.some((need) => changed.has(need))) {
        changed.add(id)
        added = true
      }
    }
  }
  return [...changed]
}

/** Stage a reviewed standalone definition under the existing run identity and budgets. */
export function amendDag(options: {
  readonly runDirectory: string
  readonly definition: DagDefinition
  readonly assignments: AssignmentSnapshots
  readonly source: Readonly<Record<string, string>>
  readonly classification: 'minor' | 'material'
  readonly reason: string
  readonly reviewPath?: string
  readonly onPreview?: (preview: {
    readonly affectedTasks: readonly string[]
    readonly budgets: {
      readonly before: Readonly<Record<string, DagDefinition['limits']>>
      readonly after: Readonly<Record<string, DagDefinition['limits']>>
    }
  }) => void
}): RunState {
  const saved = frozenRun(options.runDirectory)
  const state = saved.state
  if (
    !['paused', 'needs-author'].includes(state.status) ||
    state.revisionPending
  )
    throw new RunError('amend-not-admissible', options.runDirectory)
  assertRunOwnership(options.definition, state.ownership)
  assertTarget(state.target)
  if (!options.reason.trim())
    throw new RunError('amend-reason-required', options.runDirectory)
  if (
    options.definition.name !== saved.definition.name ||
    Object.keys(state.assignments).some(
      (id) =>
        Object.hasOwn(saved.definition.nodes, id) &&
        state.assignments[id]?.attempts.length &&
        !Object.hasOwn(options.definition.nodes, id),
    )
  )
    throw new RunError('attempted-identity-change', options.runDirectory)
  if (
    options.classification === 'minor' &&
    standalonePolicy(saved.definition, saved.assignments) !==
      standalonePolicy(options.definition, options.assignments)
  )
    throw new RunError('material-amendment', options.runDirectory)
  if (options.classification === 'material' && !options.reviewPath)
    throw new RunError('review-required', options.runDirectory)
  const affectedTasks = affectedDagNodes(saved, options, options.classification)
  options.onPreview?.({
    affectedTasks,
    budgets: {
      before: { [saved.definition.name]: saved.definition.limits },
      after: { [options.definition.name]: options.definition.limits },
    },
  })
  const owner = acquireRecoveryOwner(options.runDirectory, state)
  try {
    const path = join(
      options.runDirectory,
      `snapshot-revision-${state.revisions.length}.json`,
    )
    atomicWrite(path, {
      source: options.source,
      definition: JSON.stringify(
        (({ stages: _stages, ...body }) => body)(options.definition),
      ),
      profiles: JSON.stringify({ profiles: options.assignments.profiles }),
      resources: Object.fromEntries(
        Object.entries(options.assignments.nodes).map(([id, item]) => [
          id,
          { skills: item.skills, instructions: item.instructions },
        ]),
      ),
    })
    const sha256 = fileIdentity(path).sha256
    const updated: RunState = {
      ...state,
      revisionPending: true,
      // Consume the computed closure: resource-only edits change no executable
      // policy but still change what accepted producers were written against.
      revisionAffected: affectedTasks.length > 0,
      revisionAffectedNodes: [...affectedTasks],
      snapshots: {
        ...state.snapshots,
        effective: path,
        effectiveSha256: sha256,
      },
      revisions: [
        ...state.revisions,
        {
          identity: sha256,
          source: path,
          expanded: path,
          reason: options.reason,
          review: options.reviewPath ?? null,
        },
      ],
    }
    owner.write(updated)
    return updated
  } finally {
    owner.release()
  }
}
