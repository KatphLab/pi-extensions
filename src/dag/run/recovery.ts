import type { DagDefinition } from '@dag/definition/schema.js'
import type { RunState } from '@dag/state.js'
import { assertTarget } from '@dag/workspace/workspace.js'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { assertEvidence, checkpointSchema, readBound } from './checkpoint.js'
import { automaticStageId, RunContext } from './context.js'
import { RunError } from './error.js'
import {
  acquireRecoveryOwner,
  frozenRun,
  inspectRecoveryAttempts,
  inspectRecoveryReview,
  inspectRecoveryTarget,
  missingResources,
  pendingPreparation,
  restartTarget,
  usesSession,
} from './inspection.js'
import { RunLifecycle } from './lifecycle.js'
import type { RunResult } from './types.js'

/** This operation authorizes one inspected effect but never starts execution. */
export async function restartDag(options: {
  readonly runDirectory: string
  readonly assignment: string
  readonly reason: string
}): Promise<RunState> {
  const saved = frozenRun(options.runDirectory)
  const state = saved.state
  assertTarget(state.target)
  const updated = await stageManagedRestart(
    state,
    saved.definition,
    options.assignment,
    options.reason,
  )
  const owner = acquireRecoveryOwner(options.runDirectory, state)
  try {
    owner.write(updated)
    return updated
  } finally {
    owner.release()
  }
}
/** Validate the exact saved child and return a staged, non-executing authorization. */
export async function stageManagedRestart(
  state: RunState,
  definition: DagDefinition,
  assignment: string,
  reason: string,
): Promise<RunState> {
  const id = assignment.includes('/')
    ? assignment
    : `${definition.name}/${assignment}`
  const target = restartTarget(state, id, definition.name)
  if (!reason.trim()) throw new RunError('restart-reason-required', assignment)
  if (
    state.restarts?.some(
      (item) => item.assignment === target.id && !item.consumedAt,
    )
  )
    throw new RunError('restart-already-staged', assignment)
  const checkpoint = readBound(state, 'recovery')
  if (!checkpointSchema.check(checkpoint))
    throw new RunError('invalid-checkpoint', state.runId)
  const preparation = pendingPreparation(checkpoint, target.id)
  const checking =
    checkpoint.acceptances?.[target.id]?.number === target.attempt.number ||
    target.id === automaticStageId(definition.nodes, 'combined-checks') ||
    target.id === automaticStageId(definition.nodes, 'reviewed-handoff') ||
    preparation?.progress?.phase === 'checks'
  const missing = await missingResources(
    state,
    target.id,
    checking ? false : usesSession(definition.nodes[target.id]),
    preparation !== undefined,
  )
  if (!missing && !checking && usesSession(definition.nodes[target.id]))
    throw new RunError('restart-not-required', assignment)
  return {
    ...state,
    restarts: [
      ...(state.restarts ?? []),
      {
        assignment: target.id,
        attempt: target.attempt.number,
        effect: missing ? 'replace-resources' : 'repeat-command',
        reason,
        stagedAt: new Date().toISOString(),
        previousWorktree: target.attempt.worktree,
        ...(target.attempt.sessionPath
          ? { previousSessionPath: target.attempt.sessionPath }
          : {}),
        ...(target.attempt.sessionId
          ? { previousSessionId: target.attempt.sessionId }
          : {}),
      },
    ],
  }
}
export async function resumeDag(options: {
  readonly runDirectory: string
  readonly runtime: ModelRuntime
  readonly signal: AbortSignal
}): Promise<RunResult> {
  const saved = frozenRun(options.runDirectory)
  if (saved.state.status === 'succeeded')
    return { runDirectory: options.runDirectory, state: saved.state }
  if (
    saved.state.status !== 'paused' &&
    !(saved.state.status === 'needs-author' && saved.state.revisionPending)
  )
    throw new RunError('not-paused', options.runDirectory)
  const checkpoint = readBound(saved.state, 'recovery')
  if (!checkpointSchema.check(checkpoint))
    throw new RunError('invalid-checkpoint', options.runDirectory)
  inspectRecoveryTarget(saved.state, checkpoint)
  await inspectRecoveryAttempts(saved, checkpoint)
  inspectRecoveryReview(saved.state, checkpoint)
  assertEvidence(checkpoint.controls)
  assertEvidence(checkpoint.contributions.flatMap((item) => item.artifacts))
  const owner = acquireRecoveryOwner(options.runDirectory, saved.state)
  const base = Object.values(saved.assignments.nodes)[0]
  if (!base) {
    owner.release()
    throw new RunError('missing-assignment', options.runDirectory)
  }
  const coordinator = new RunContext(
    {
      ...saved,
      projectRoot: saved.state.target.root,
      runId: saved.state.runId,
      runtime: options.runtime,
      signal: options.signal,
    },
    owner,
    base,
  )
  try {
    return await new RunLifecycle(coordinator).resume(saved.state, checkpoint)
  } finally {
    owner.release()
  }
}
