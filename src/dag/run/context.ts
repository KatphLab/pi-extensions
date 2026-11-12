import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { type ArtifactIdentity, CommandError } from '@dag/command.js'
import type {
  DagDefinition,
  EffectiveAssignment,
  Profile,
} from '@dag/definition/schema.js'
import { ExecutionCapacity } from '@dag/scheduler.js'
import {
  type AssignmentState,
  type AttemptState,
  atomicWrite,
  type DagRunOwner,
  type RunState,
} from '@dag/state.js'
import { type SessionIdentity, WorkerError } from '@dag/worker.js'
import { checkpointWorkspace } from '@dag/workspace/checkpoint.js'
import type {
  AcceptedContribution,
  AcceptedInput,
  IntegrationAuthorization,
  Prerequisite,
  PrerequisiteBaseline,
} from '@dag/workspace/types.js'
import { WorkspaceError } from '@dag/workspace/workspace.js'
import { type Checkpoint, fileIdentity } from './checkpoint.js'
import { RunError } from './error.js'
import type { ManagedBindings, RunRequest } from './types.js'

/** Run-only ownership never authorizes changes to project files. */
export function assertRunOwnership(
  definition: DagDefinition,
  ownership: RunState['ownership'],
): void {
  if (
    ownership === 'run' &&
    Object.values(definition.nodes).some((node) => node.write.length > 0)
  )
    throw new RunError('read-only-required', definition.name)
}
export function hash(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
export function automatic(
  base: EffectiveAssignment,
  role: {
    readonly id: string
    readonly profile: Profile
    readonly write: readonly string[]
  },
): EffectiveAssignment {
  return {
    ...base,
    id: role.id,
    profile: role.profile,
    skills: [],
    node: {
      kind: 'agent',
      task:
        role.write.length > 0
          ? 'Reconcile the staged runner-accepted contribution and its handoff against the goal within the supplied write scope. Preserve accepted artifacts and cite integration decisions in your handoff. Control-report findings are workflow decisions: use needsAuthor only when authority, a required input, or scope must change. Put substantive findings in the declared findings artifact.'
          : 'Independently review the supplied exact revision, artifact identities, integration decisions and runner receipts against the original goal and every criterion. Notes permit approval; blockers must cite an agreed criterion or concrete regression. New scope/contracts/assignments require needs-author. Never override failed checks.',
      needs: [],
      references: [],
      satisfies: Object.keys(base.criteria),
      write: role.write,
      outputs: [],
      verify: [],
    },
  }
}
export function normalize(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error(typeof value === 'string' ? value : JSON.stringify(value))
}
export function diagnostic(error: Error) {
  return {
    name: error.name,
    message: error.message,
    cause: error.cause instanceof Error ? error.cause.message : null,
    code: 'code' in error && typeof error.code === 'string' ? error.code : null,
    field:
      'field' in error && typeof error.field === 'string' ? error.field : null,
  }
}
export function pause(error: Error): boolean {
  return (
    error instanceof RunError ||
    (error instanceof CommandError &&
      ['unobserved-receipt', 'stale-receipt', 'stale-artifact'].includes(
        error.code,
      )) ||
    (error instanceof WorkerError && error.code === 'session') ||
    (error instanceof WorkspaceError &&
      [
        'target-identity',
        'dirty-target',
        'pending-git-operation',
        'missing-worktree',
        'missing-candidate',
        'changed-worktree',
        'changed-candidate',
        'uncertain-candidate',
        'changed-check',
        'uncertain-check',
        'changed-acceptance',
        'incomplete-publication',
      ].includes(error.code))
  )
}
export function automaticStageId(
  nodes: Readonly<Record<string, unknown>>,
  name: string,
): string {
  let id = name
  while (Object.hasOwn(nodes, id)) id = `automatic.${id}`
  return id
}
export function pendingRestart(state: RunState, id: string) {
  const number = state.assignments[id]?.attempts.at(-1)?.number
  return state.restarts?.find(
    (item) =>
      item.assignment === id && item.attempt === number && !item.consumedAt,
  )
}
export class RunContext {
  checkpoint: Checkpoint = {
    phase: 'worker',
    contributions: [],
    controls: [],
  }
  recovering: boolean = false
  readonly resumedAssignments = new Set<string>()
  readonly retainedAssignments = new Set<string>()
  readonly stopController = new AbortController()
  readonly request: RunRequest
  readonly externalSignal: AbortSignal
  state: RunState
  readonly directory: string
  readonly integrationId: string
  readonly branchPreparationId: string
  readonly reviewId: string
  readonly sessions = new Map<string, SessionIdentity>()
  readonly capacity: Pick<ExecutionCapacity, 'run'>
  readonly acceptedNodes = new Map<string, Prerequisite>()
  readonly preparations = new Map<string, PrerequisiteBaseline>()
  readonly preparationRecords = new Map<string, ArtifactIdentity>()
  finalPreparation: PrerequisiteBaseline | undefined
  preparationNumber = 0
  restoredInputs: readonly AcceptedInput[] = []
  restoredMerges: readonly string[] = []
  readonly contributions: AcceptedContribution[] = []
  readonly controls: ArtifactIdentity[] = []
  constructor(
    request: RunRequest,
    readonly owner: DagRunOwner,
    readonly base: EffectiveAssignment,
    readonly managed?: ManagedBindings,
  ) {
    this.externalSignal = request.signal
    this.request = {
      ...request,
      signal: AbortSignal.any([request.signal, this.stopController.signal]),
    }
    const local = new ExecutionCapacity(request.definition.limits.concurrency)
    this.capacity = managed
      ? {
          run: <T>(execute: () => Promise<T>) =>
            local.run(() => managed.capacity.run(execute)),
        }
      : local
    this.directory = owner.runDirectory
    this.integrationId = this.automaticId('integration')
    this.branchPreparationId = this.automaticId('branch')
    this.reviewId = this.automaticId('review')
    if (managed)
      this.contributions.push(
        ...managed.prerequisites.map((input) => input.input.contribution),
      )
    this.state = {
      schema: 1,
      runId: request.runId,
      status: 'running',
      target: owner.target,
      snapshots: {},
      revisions: [],
      assignments: {},
      repairRounds: { [request.definition.name]: 0 },
      cycle: null,
      needsAuthor: null,
    }
  }
  automaticId(name: string): string {
    return automaticStageId(this.request.definition.nodes, name)
  }
  save(update: Partial<RunState> = {}): void {
    this.state = { ...this.state, ...update }
    const path = join(this.directory, `recovery-${Bun.randomUUIDv7()}.json`)
    atomicWrite(path, {
      ...this.checkpoint,
      contributions: this.contributions,
      controls: this.controls,
      workspace: checkpointWorkspace(this.state.target, {
        contributions: this.contributions,
        preparations: this.preparations,
      }),
      preparationNumber: this.preparationNumber,
      preparationRecords: Object.fromEntries(this.preparationRecords),
      acceptedNodes: Object.fromEntries(
        [...this.acceptedNodes].map(([id, node]) => [
          id,
          {
            receipt: node.input.contribution.receipt,
            ...(node.preparation ? { preparation: id } : {}),
          },
        ]),
      ),
      finalPreparation: this.finalPreparation ? this.integrationId : undefined,
    })
    this.state = {
      ...this.state,
      snapshots: {
        ...this.state.snapshots,
        recovery: path,
        recoverySha256: fileIdentity(path).sha256,
      },
    }
    this.state = this.owner.write(this.state)
  }
  assignment(id: string, value: AssignmentState): void {
    this.save({ assignments: { ...this.state.assignments, [id]: value } })
  }
  stage(
    id: string,
    stage: AssignmentState['stage'],
    update: Partial<AttemptState> = {},
  ): void {
    const current = this.state.assignments[id]
    const attempt = current?.attempts.at(-1)
    if (!current || !attempt) throw new RunError('missing-attempt', id)
    this.assignment(id, {
      ...current,
      stage,
      attempts: [...current.attempts.slice(0, -1), { ...attempt, ...update }],
    })
  }
  cycle(
    stage: NonNullable<RunState['cycle']>['stage'],
    reviewInputs: Readonly<Record<string, string>> = {},
  ): void {
    this.save({
      cycle: {
        dagId: this.request.definition.name,
        stage,
        revision: this.state.target.expectedRevision,
        reviewInputs: { ...reviewInputs },
      },
    })
  }
  needsAuthor(reason: string, evidence: unknown): void {
    const path = join(this.directory, 'needs-author.json')
    atomicWrite(path, {
      reason,
      evidence,
      assignments: Object.keys(this.request.definition.nodes),
      decisionNeeded:
        'Amend the existing authored scope/contracts or resolve the recorded failure; no new assignment was admitted.',
    })
    this.save({ status: 'needs-author', needsAuthor: path })
  }
  clearAcceptance(id: string): void {
    const { [id]: _previous, ...acceptances } =
      this.checkpoint.acceptances ?? {}
    this.checkpoint = { ...this.checkpoint, acceptances }
  }
  consumeRestart(decision: NonNullable<RunState['restarts']>[number]): void {
    this.save({
      restarts: (this.state.restarts ?? []).map((item) =>
        item === decision
          ? { ...item, consumedAt: new Date().toISOString() }
          : item,
      ),
    })
  }
  revisionTree(revision: string): string {
    const result = spawnSync(
      'git',
      ['-C', this.state.target.root, 'rev-parse', `${revision}^{tree}`],
      { encoding: 'utf8' },
    )
    if (result.status !== 0)
      throw new RunError('revision-tree', revision, {
        cause: result.error ?? new Error(result.stderr),
      })
    return result.stdout.trim()
  }
  currentContributions(): readonly AcceptedContribution[] {
    const revisions = new Set(
      Object.values(this.state.assignments)
        .filter((assignment) => assignment.stage === 'accepted')
        .map((assignment) => assignment.attempts.at(-1)?.acceptedRevision),
    )
    return this.contributions.filter((entry) => revisions.has(entry.revision))
  }
  reviewRound(): number {
    const repairRound =
      this.state.repairRounds[this.request.definition.name] ?? 0
    const previous = this.state.assignments[this.reviewId]
    return previous?.stage === 'interrupted'
      ? (previous.attempts.at(-1)?.number ?? repairRound)
      : Math.max(repairRound, previous?.attempts.length ?? 0)
  }
  move(phase: Checkpoint['phase'], update: Partial<Checkpoint> = {}): void {
    this.checkpoint = { ...this.checkpoint, ...update, phase }
    this.save()
  }
  get managedResult() {
    return {
      state: this.state,
      needsWorkers: this.checkpoint.phase === 'worker',
      inputs: this.restoredInputs,
      merges: this.restoredMerges,
    }
  }
  get parallel(): boolean {
    return (
      Boolean(this.managed) ||
      Object.keys(this.request.definition.nodes).length > 1
    )
  }
  get writeScope(): readonly string[] {
    return [
      ...new Set(
        Object.values(this.request.definition.nodes).flatMap(
          (node) => node.write,
        ),
      ),
    ]
  }
  authorization(): IntegrationAuthorization | undefined {
    return this.finalPreparation
      ? { prerequisites: this.finalPreparation, write: this.writeScope }
      : undefined
  }
}
