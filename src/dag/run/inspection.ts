import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { parseDag } from '@dag/definition/definition.js'
import type {
  AssignmentSnapshots,
  DagDefinition,
  DagNode,
  EffectiveAssignment,
  Profile,
  SkillSnapshot,
} from '@dag/definition/schema.js'
import { parseProfiles } from '@dag/definition/schema.js'
import type { AssignmentState } from '@dag/state.js'
import {
  type AttemptState,
  RunOwner,
  type RunState,
  readRunState,
} from '@dag/state.js'
import {
  preflightSession,
  type SessionIdentity,
  WorkerError,
} from '@dag/worker.js'
import { assertTarget, WorkspaceError } from '@dag/workspace/workspace.js'
import { arr, compile, map, obj, str } from '@earendil-works/pi-schema'
import { type Checkpoint, fileIdentity, readBound } from './checkpoint.js'
import {
  assertRunOwnership,
  automaticStageId,
  normalize,
  pendingRestart,
} from './context.js'
import { RunError } from './error.js'

const text = str({ minLength: 1 })
const snapshotSchema = compile(
  obj({
    source: map(str()),
    definition: text,
    profiles: text,
    resources: map(
      obj({
        skills: arr(
          obj({ name: text, filePath: text, baseDir: text, content: str() }),
        ),
        instructions: arr(obj({ path: text, content: str() })),
      }),
    ),
  }),
)
function requiredProfile(
  profiles: AssignmentSnapshots['profiles'],
  name: string | undefined,
): Profile {
  const profile = name ? profiles[name] : undefined
  if (!profile)
    throw new RunError('invalid-snapshot-profile', name ?? '(missing)')
  return profile
}
/** Policy is rebuilt from frozen bytes, not edited author files or environment skills. */
export function frozenRun(runDirectory: string) {
  const state = readRunState(runDirectory)
  const value = readBound(state, 'effective')
  if (!snapshotSchema.check(value))
    throw new RunError('invalid-snapshot', runDirectory)
  const definition = parseDag(value.definition, {
    projectRoot: state.target.root,
    definitionPath: join(state.target.root, '.pi/dags/plans/frozen.yaml'),
    profilesPath: join(
      state.target.root,
      '.pi/dags/plans/frozen-profiles.yaml',
    ),
  })
  const profiles = parseProfiles(value.profiles)
  const nodes: Record<string, EffectiveAssignment> = {}
  for (const [id, node] of Object.entries(definition.nodes)) {
    const resources = value.resources[id]
    let profile: Profile | undefined
    switch (node.kind) {
      case 'agent':
        profile = requiredProfile(
          profiles,
          node.profile ?? definition.defaults?.profile,
        )
        break
      case 'command':
        profile = undefined
        break
      default:
        throw new RunError('invalid-node', node satisfies never)
    }
    if (!resources) throw new RunError('invalid-snapshot', id)
    nodes[id] = {
      id,
      node,
      goal: definition.goal,
      criteria: definition.criteria,
      context: definition.context ?? '',
      profile,
      ...resources,
      skills: resources.skills satisfies readonly SkillSnapshot[],
    }
  }
  const review = requiredProfile(profiles, definition.review.profile)
  const integration = definition.integration
    ? requiredProfile(profiles, definition.integration.profile)
    : undefined
  if (review.size !== 'large')
    throw new RunError('invalid-snapshot', runDirectory)
  const assignments: AssignmentSnapshots = {
    nodes,
    review,
    integration,
    profiles,
  }
  assertRunOwnership(definition, state.ownership)
  return { state, definition, assignments, source: value.source }
}
function inspectWorktree(
  state: RunState,
  attempt: AttemptState,
  reconciling = false,
): void {
  if (
    !fs.existsSync(attempt.worktree) ||
    fs.realpathSync(attempt.worktree) !== attempt.worktree
  )
    throw new RunError('missing-worktree', attempt.worktree)
  const result = spawnSync(
    'git',
    [
      '-C',
      attempt.worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
      '--absolute-git-dir',
      '--show-toplevel',
    ],
    { env: { ...process.env, GIT_MASTER: '1' }, encoding: 'utf8' },
  )
  const [common, directory, root] = result.stdout.trim().split('\n')
  if (
    result.status !== 0 ||
    common !== state.target.commonDirectory ||
    root !== attempt.worktree ||
    !directory
  )
    throw new RunError('changed-worktree', attempt.worktree)
  for (const name of [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
    'index.lock',
  ])
    if (
      (!reconciling || name !== 'MERGE_HEAD') &&
      fs.existsSync(join(directory, name))
    )
      throw new RunError('ambiguous-git', join(directory, name))
}
export function sessionIdentity(
  state: RunState,
  id: string,
): SessionIdentity | undefined {
  const attempts = state.assignments[id]?.attempts ?? []
  const last = attempts.at(-1)
  const header = attempts.find((item) => item.sessionId === last?.sessionId)
  return last?.sessionId && last.sessionPath && header
    ? { id: last.sessionId, path: last.sessionPath, cwd: header.worktree }
    : undefined
}
export function usesSession(node: DagNode | undefined): boolean {
  if (!node) return true
  switch (node.kind) {
    case 'agent':
      return true
    case 'command':
      return false
    default:
      throw new RunError('invalid-node', node satisfies never)
  }
}
export function acquireRecoveryOwner(
  runDirectory: string,
  state: RunState,
): RunOwner {
  const owner = RunOwner.acquire({
    runDirectory,
    target: state.target,
    ownership: state.ownership,
  })
  try {
    if (JSON.stringify(readRunState(runDirectory)) !== JSON.stringify(state))
      throw new RunError('stale-state', runDirectory)
    return owner
  } catch (error) {
    owner.release()
    throw error
  }
}
async function inspectResources(
  state: RunState,
  id: string,
  agent: boolean,
  reconciling = false,
): Promise<void> {
  const attempt = state.assignments[id]?.attempts.at(-1)
  if (!attempt) throw new RunError('missing-attempt', id)
  inspectWorktree(state, attempt, reconciling)
  const identity = sessionIdentity(state, id)
  if (!identity && agent) throw new RunError('missing-session', id)
  if (identity) {
    try {
      await preflightSession(identity)
    } catch (error) {
      throw new RunError('unusable-session', `${id}: ${identity.path}`, {
        cause: normalize(error),
      })
    }
  }
}
export function restartTarget(state: RunState, target: string, name: string) {
  const [dag, id, extra] = target.split('/')
  if (dag !== name || extra !== undefined || !id)
    throw new RunError('restart-not-admissible', target)
  const current = state.assignments[id]
  const attempt = current?.attempts.at(-1)
  if (!current || !attempt) throw new RunError('missing-attempt', target)
  if (state.status !== 'paused' || current.stage !== 'interrupted')
    throw new RunError('restart-not-admissible', target)
  return { id, attempt }
}
export async function missingResources(
  state: RunState,
  id: string,
  agent: boolean,
  reconciling = false,
): Promise<boolean> {
  try {
    await inspectResources(state, id, agent, reconciling)
    return false
  } catch (error) {
    if (error instanceof WorkerError && error.code === 'session') return true
    if (
      error instanceof RunError &&
      ['missing-worktree', 'missing-session', 'unusable-session'].includes(
        error.code,
      )
    )
      return true
    throw error
  }
}
export function inspectRecoveryTarget(
  state: RunState,
  checkpoint: Checkpoint,
): void {
  try {
    assertTarget(state.target)
  } catch (error) {
    if (
      !(error instanceof WorkspaceError) ||
      error.code !== 'target-identity' ||
      checkpoint.phase !== 'apply' ||
      !checkpoint.accepted ||
      state.cycle?.reviewInputs['intendedRevision'] !==
        checkpoint.accepted.revision ||
      state.cycle.reviewInputs['intendedTree'] !== checkpoint.accepted.tree
    )
      throw error
    assertTarget({
      ...state.target,
      expectedRevision: checkpoint.accepted.revision,
    })
  }
}
export function inspectRecoveryReview(
  state: RunState,
  checkpoint: Checkpoint,
): void {
  if (checkpoint.phase === 'review' && state.cycle?.stage === 'review') {
    const inputs = state.cycle.reviewInputs
    const path = inputs['path']
    if (
      !path ||
      fileIdentity(path)['sha256'] !== inputs['sha256'] ||
      inputs['revision'] !== state.target.expectedRevision
    )
      throw new RunError('changed-review-inputs', path ?? state.runId)
  }
}
export function pendingPreparation(checkpoint: Checkpoint, id: string) {
  return Object.values(checkpoint.pendingPreparations ?? {}).find((item) =>
    item.reconciliations.includes(id),
  )
}
export async function inspectRecoveryAttempts(
  saved: { readonly state: RunState; readonly definition: DagDefinition },
  checkpoint: Checkpoint,
): Promise<void> {
  // A staged amendment invalidates its affected closure before any work runs;
  // demanding that closure's resources under the new node kind would block the
  // very transition the amendment exists to make.
  const invalidated = new Set(
    saved.state.revisionPending
      ? (saved.state.revisionAffectedNodes ?? [])
      : [],
  )
  for (const [id, assignment] of Object.entries(saved.state.assignments)) {
    if (assignment.attempts.length === 0 || invalidated.has(id)) continue
    await inspectAttempt(saved, checkpoint, id, assignment)
  }
}
async function inspectAttempt(
  saved: { readonly state: RunState; readonly definition: DagDefinition },
  checkpoint: Checkpoint,
  id: string,
  assignment: AssignmentState,
): Promise<void> {
  const authorization = pendingRestart(saved.state, id)
  const reconciling = pendingPreparation(checkpoint, id) !== undefined
  const reviewedHandoff = automaticStageId(
    saved.definition.nodes,
    'reviewed-handoff',
  )
  if (authorization?.effect !== 'replace-resources' && id !== reviewedHandoff)
    await inspectResources(
      saved.state,
      id,
      id === automaticStageId(saved.definition.nodes, 'combined-checks')
        ? false
        : usesSession(saved.definition.nodes[id]),
      reconciling,
    )
  if (
    assignment.stage === 'interrupted' &&
    saved.definition.nodes[id]?.kind === 'command' &&
    !checkpoint.acceptances?.[id]?.progress.candidate &&
    !authorization
  )
    throw new RunError('uncertain-command-requires-restart', id)
}
