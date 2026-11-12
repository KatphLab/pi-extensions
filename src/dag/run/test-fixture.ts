import type { spyOn as testSpyOn } from 'bun:test'
import * as childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ArtifactIdentity } from '@dag/command.js'
import type {
  AssignmentSnapshots,
  DagDefinition,
  DagNode,
  EffectiveAssignment,
  ReviewReport,
  WorkerReport,
} from '@dag/definition/schema.js'
import { ExecutionCapacity } from '@dag/scheduler.js'
import {
  type AssignmentState,
  type AttemptState,
  atomicWrite,
  attemptLayout,
  type DagRunOwner,
  type RunState,
  readRunState,
  type TargetIdentity,
} from '@dag/state.js'
import * as worker from '@dag/worker.js'
import * as workspaceCapabilities from '@dag/workspace/capabilities.js'
import * as workspaceCheckpoint from '@dag/workspace/checkpoint.js'
import * as workspaceChecks from '@dag/workspace/checks.js'
import * as workspaceContribution from '@dag/workspace/contribution.js'
import * as workspacePrerequisites from '@dag/workspace/prerequisites.js'
import type * as workspaceTypes from '@dag/workspace/types.js'
import * as workspace from '@dag/workspace/workspace.js'
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import type { Checkpoint } from './checkpoint.js'
import { managedDag } from './run.js'
import type { RunRequest } from './types.js'

const restores: { mockRestore(): void }[] = []
export const directories: string[] = []
export function cleanupRunTests(): void {
  for (const spy of restores.splice(0).reverse()) spy.mockRestore()
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
}
export function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(spy)
  return spy
}
export function text(path: string, content: string): string {
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, content)
  return path
}
export function identity(path: string): ArtifactIdentity {
  const bytes = fs.readFileSync(path)
  return {
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
export function node(
  needs: readonly string[] = [],
  write: readonly string[] = [],
): DagNode {
  return {
    kind: 'agent',
    task: 'Deliver the agreed answer',
    needs,
    references: [],
    write,
    satisfies: ['answer'],
    outputs: ['proof.txt'],
    verify: [{ id: 'proof', argv: ['unit-check'] }],
  }
}
export function assignments(definition: DagDefinition): AssignmentSnapshots {
  const small = { model: 'unit/model', size: 'small' } as const
  const large = { ...small, size: 'large' } as const
  return {
    nodes: Object.fromEntries(
      Object.entries(definition.nodes).map(([id, value]) => [
        id,
        {
          id,
          node: value,
          goal: definition.goal,
          criteria: definition.criteria,
          context: definition.context ?? '',
          profile: value.kind === 'agent' ? small : undefined,
          instructions: [],
          skills: [],
        } satisfies EffectiveAssignment,
      ]),
    ),
    integration: definition.integration ? small : undefined,
    review: large,
    profiles: { small, large },
  }
}
export const approved: ReviewReport = {
  verdict: 'approved',
  summary: 'The exact result meets the agreed criterion',
  findings: [
    {
      id: 'style',
      severity: 'note',
      criterion: 'answer',
      assignment: 'maker',
      evidence: [],
      requestedChange: 'Optional wording improvement',
    },
  ],
}
export function blocker(assignment = 'maker'): ReviewReport {
  return {
    verdict: 'changes-requested',
    summary: 'Repair the existing agreed answer',
    findings: [
      {
        id: 'answer',
        severity: 'blocker',
        criterion: 'answer',
        assignment,
        evidence: ['proof.txt'],
        requestedChange: 'Correct the answer evidence',
      },
    ],
  }
}
export const completed: WorkerReport = {
  outcome: 'claimed-complete',
  summary: 'The agreed answer is ready for runner acceptance',
  deliverables: ['proof.txt'],
  evidence: [{ criterion: 'answer', paths: ['proof.txt'] }],
  findings: [],
}
type Claim = {
  readonly kind: 'claimed'
  readonly reportPath: string
} & (
  | {
      readonly role: 'worker'
      readonly report: WorkerReport
      readonly handoffPath: string
    }
  | { readonly role: 'reviewer'; readonly report: ReviewReport }
)
type SavedCheckpoint = Checkpoint & {
  workspace: {
    readonly accepted: readonly {
      readonly input: workspaceTypes.AcceptedInput
      readonly write: readonly string[]
    }[]
    readonly preparations: Readonly<
      Record<
        string,
        {
          readonly baseline: workspaceTypes.PrerequisiteBaseline
          readonly targetRevision: string
        }
      >
    >
    readonly merges: readonly {
      readonly revision: string
      readonly tree: string
      readonly parents: readonly string[]
      readonly scopeBase: string
      readonly write: readonly string[]
    }[]
  }
  preparationNumber: number
  preparationRecords: Record<string, ArtifactIdentity>
  acceptedNodes: Record<string, { receipt: string; preparation?: string }>
  finalPreparation?: string
}
export interface FixtureOptions {
  nodes?: Readonly<Record<string, DagNode>>
  write?: boolean
  limits?: Partial<DagDefinition['limits']>
}
interface FixtureResources {
  root: string
  target: TargetIdentity
  request: RunRequest
  runDirectory: string
  owner: DagRunOwner
  worktree(id: string, number: number, baseline: string): string
  contribution(
    id: string,
    number?: number,
    baseline?: string,
  ): workspaceTypes.AcceptedContribution
  claim(
    options: worker.WorkerOptions,
    report?: WorkerReport,
  ): Extract<Claim, { role: 'worker' }>
  executeGit(
    command: string,
    args?: readonly string[],
  ): childProcess.SpawnSyncReturns<string>
  apply(
    target: TargetIdentity,
    accepted: workspaceTypes.AcceptedContribution,
  ): TargetIdentity
  capture(cwd: string): TargetIdentity
  assert(target: TargetIdentity): void
  advance(revision: string): void
  write: boolean | undefined
}
interface FixtureEffects {
  produce(
    options: worker.WorkerOptions,
    signal?: AbortSignal,
    prompt?: string,
  ): Promise<Claim>
  accept(
    input: workspaceTypes.ContributionRequest,
  ): Promise<workspaceTypes.AcceptedContribution>
  checks(input: workspaceTypes.ContributionRequest): Promise<readonly string[]>
  prepare(
    input: workspaceTypes.PrerequisiteRequest,
  ): Promise<workspaceTypes.PrerequisiteBaseline>
  handoff(
    input: workspaceTypes.ReviewedHandoffRequest,
  ): Promise<workspaceTypes.AcceptedContribution>
  apply(
    target: TargetIdentity,
    accepted: workspaceTypes.AcceptedContribution,
  ): TargetIdentity
}
function fixtureResources(options: FixtureOptions): FixtureResources {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'dag-run-unit-')))
  directories.push(root)
  const target: TargetIdentity = {
    root,
    commonDirectory: join(root, '.git'),
    gitDirectory: join(root, '.git'),
    branch: 'unit',
    launchRevision: 'launch',
    expectedRevision: 'launch',
  }
  let currentTarget = target
  const revisions = new Map([[root, target.expectedRevision]])
  const definition: DagDefinition = {
    schema: 1,
    kind: 'dag',
    name: 'answer',
    goal: 'Deliver 42',
    criteria: { answer: 'The answer is 42' },
    defaults: { profile: 'small' },
    review: { profile: 'large' },
    ...(options.write ? { integration: { profile: 'small' } } : {}),
    limits: {
      concurrency: 2,
      nodeRetries: 2,
      repairCycles: 3,
      ...options.limits,
    },
    nodes: options.nodes ?? {
      maker: node([], options.write ? ['answer.ts'] : []),
    },
    verify: [{ id: 'combined', argv: ['unit-check'] }],
    stages: ['integration', 'checks', 'review'],
  }
  const request: RunRequest = {
    projectRoot: root,
    runId: 'unit',
    definition,
    assignments: assignments(definition),
    source: { 'dag.yaml': JSON.stringify(definition) },
    runtime: ModelRuntime.prototype,
    signal: new AbortController().signal,
  }
  const runDirectory = join(root, '.pi/dags/runs/unit')
  const owner: DagRunOwner = {
    runDirectory,
    get target() {
      return currentTarget
    },
    write: (state) => {
      atomicWrite(join(runDirectory, 'state.json'), state)
      return state
    },
    advanceTarget: (next) => {
      currentTarget = next
    },
    recoveryCheckpoint: () => {
      const state = readRunState(runDirectory)
      const path = state.snapshots['recovery'] ?? ''
      return { state, path, value: JSON.parse(fs.readFileSync(path, 'utf8')) }
    },
  }
  function worktree(id: string, number: number, baseline: string): string {
    const path = join(root, 'worktrees', `${id}-${number}`)
    fs.mkdirSync(path, { recursive: true })
    revisions.set(path, baseline)
    return path
  }
  function contribution(
    id: string,
    number = 0,
    baseline = target.launchRevision,
  ): workspaceTypes.AcceptedContribution {
    const layout = attemptLayout(runDirectory, id, number)
    const revision = `${id}-${number}`
    const handoff = join(layout.runner, 'accepted-handoff.md')
    if (!fs.existsSync(handoff)) text(handoff, `Accepted ${id}:${number}`)
    return {
      baseline,
      revision,
      tree: `tree-${revision}`,
      validationWorktree: worktree(`${id}.accepted`, number, revision),
      changedPaths: options.write ? ['answer.ts'] : [],
      artifacts: [
        identity(
          text(join(layout.artifacts, 'proof.txt'), `${id}:${number}:42`),
        ),
      ],
      receipts: [],
      acceptedRef: `refs/pi-dags/unit/${id}/${number}`,
      receipt: text(
        join(layout.runner, 'accepted.json'),
        JSON.stringify({ revision }),
      ),
      handoff,
    }
  }
  function claim(
    options: worker.WorkerOptions,
    report: WorkerReport = completed,
  ) {
    text(join(options.artifacts, 'proof.txt'), `${options.assignment.id}:42`)
    return {
      kind: 'claimed' as const,
      role: 'worker' as const,
      report,
      reportPath: text(
        join(options.artifacts, 'outcome.json'),
        JSON.stringify(report),
      ),
      handoffPath: text(
        join(options.artifacts, 'handoff.md'),
        'Existing scope only',
      ),
    }
  }
  const executeGit = (_command: string, args: readonly string[] = []) => {
    const cwd = args[1] ?? root
    let stdout: string
    if (args.includes('--show-toplevel'))
      stdout = `${target.commonDirectory}\n${target.gitDirectory}\n${cwd}\n`
    else if (args.includes('merge-base')) stdout = ''
    else if (args.at(-1)?.endsWith('^{tree}'))
      stdout = `tree-${args.at(-1)?.slice(0, -7)}\n`
    else if (args.includes('add')) stdout = ''
    else throw new Error(`Unexpected subprocess: ${args.join(' ')}`)
    return { pid: 0, status: 0, signal: null, output: [], stdout, stderr: '' }
  }
  function apply(
    saved: TargetIdentity,
    accepted: workspaceTypes.AcceptedContribution,
  ) {
    currentTarget = { ...saved, expectedRevision: accepted.revision }
    revisions.set(saved.root, accepted.revision)
    return currentTarget
  }
  function capture(cwd: string) {
    return {
      ...currentTarget,
      root: cwd,
      expectedRevision: revisions.get(cwd) ?? currentTarget.expectedRevision,
    }
  }
  function assert(saved: TargetIdentity): void {
    if (
      (revisions.get(saved.root) ?? currentTarget.expectedRevision) !==
      saved.expectedRevision
    )
      throw new workspace.WorkspaceError('target-identity', saved.root)
  }
  function advance(revision: string): void {
    currentTarget = { ...currentTarget, expectedRevision: revision }
    revisions.set(root, revision)
  }
  return {
    root,
    target,
    request,
    runDirectory,
    owner,
    worktree,
    contribution,
    claim,
    executeGit,
    apply,
    capture,
    assert,
    advance,
    write: options.write,
  }
}
function fixtureEffects(h: FixtureResources): FixtureEffects {
  const effects = {
    produce: (
      options: worker.WorkerOptions,
      _signal?: AbortSignal,
      _prompt?: string,
    ): Promise<Claim> =>
      Promise.resolve(
        options.role === 'reviewer'
          ? {
              kind: 'claimed',
              role: 'reviewer',
              report: approved,
              reportPath: text(
                join(options.artifacts, 'review.json'),
                JSON.stringify(approved),
              ),
            }
          : h.claim(options),
      ),
    accept: (input: workspaceTypes.ContributionRequest) =>
      Promise.resolve(
        h.contribution(
          input.identity.assignment,
          input.identity.attempt,
          input.baseline,
        ),
      ),
    checks: (
      _input: workspaceTypes.ContributionRequest,
    ): Promise<readonly string[]> => Promise.resolve([]),
    prepare: (input: workspaceTypes.PrerequisiteRequest) => {
      const direct = input.accepted.filter((accepted) =>
        input.needs.includes(accepted.id),
      )
      const baseline: workspaceTypes.PrerequisiteBaseline = {
        revision:
          direct[0]?.input.contribution.revision ??
          input.emptyBaseline ??
          input.target.expectedRevision,
        inputs: direct.map((accepted) => accepted.input),
        direct: direct.map((accepted) => ({
          id: accepted.id,
          revision: accepted.input.contribution.revision,
          handoff: accepted.input.contribution.handoff,
          artifacts: accepted.input.contribution.artifacts,
        })),
      }
      atomicWrite(join(input.runner, 'prerequisites.json'), baseline)
      return Promise.resolve(baseline)
    },
    handoff: (
      input: Parameters<typeof workspaceContribution.acceptReviewedHandoff>[0],
    ) =>
      Promise.resolve(
        h.contribution(
          input.identity.assignment,
          input.identity.attempt,
          input.branch.revision,
        ),
      ),
    apply: h.apply,
  }
  return effects
}
function installWorkspace(
  h: FixtureResources,
  effects: FixtureEffects,
  spyOn: typeof testSpyOn,
): void {
  const { worktree } = h
  const utf8ChildProcess: {
    spawnSync(
      command: string,
      args: readonly string[],
      options: childProcess.SpawnSyncOptionsWithStringEncoding,
    ): childProcess.SpawnSyncReturns<string>
  } = childProcess
  track(spyOn(utf8ChildProcess, 'spawnSync').mockImplementation(h.executeGit))
  track(spyOn(workspace, 'captureTarget').mockImplementation(h.capture))
  track(spyOn(workspace, 'assertTarget').mockImplementation(h.assert))
  track(
    spyOn(workspace, 'prepareWorktree').mockImplementation((_saved, input) =>
      worktree(
        `${input.assignment}.${input.role}`,
        input.attempt,
        input.baseline,
      ),
    ),
  )
  track(
    spyOn(workspaceContribution, 'prepareIntegration').mockImplementation(
      (_saved, accepted, input) =>
        worktree(
          `${input.assignment}.${input.role}`,
          input.attempt,
          accepted.revision,
        ),
    ),
  )
  track(
    spyOn(workspaceCapabilities, 'acceptedInput').mockImplementation(
      (accepted) => ({
        contribution: accepted,
        evidence: [
          identity(accepted.receipt),
          identity(accepted.handoff),
          ...accepted.artifacts,
        ],
      }),
    ),
  )
  track(
    spyOn(workspaceCheckpoint, 'checkpointWorkspace').mockImplementation(
      (saved, resources) => ({
        accepted: resources.contributions.map((accepted) => ({
          input: workspaceCapabilities.acceptedInput(accepted),
          write: h.write ? ['answer.ts'] : [],
        })),
        preparations: Object.fromEntries(
          [...resources.preparations].map(([id, baseline]) => [
            id,
            { baseline, targetRevision: saved.expectedRevision },
          ]),
        ),
        merges: [],
      }),
    ),
  )
  track(
    spyOn(workspaceCheckpoint, 'restoreWorkspace').mockImplementation(
      (savedOwner) => {
        const saved: SavedCheckpoint = JSON.parse(
          fs.readFileSync(savedOwner.recoveryCheckpoint().path, 'utf8'),
        )
        return {
          contributions: new Map(
            saved.workspace.accepted.map(({ input }) => [
              input.contribution.receipt,
              input.contribution,
            ]),
          ),
          preparations: new Map(
            Object.entries(saved.workspace.preparations).map(([id, value]) => [
              id,
              value.baseline,
            ]),
          ),
          inputs: saved.workspace.accepted.map(({ input }) => ({
            contribution: {
              ...input.contribution,
              changedPaths: [...input.contribution.changedPaths],
              artifacts: [...input.contribution.artifacts],
              receipts: [...input.contribution.receipts],
            },
            evidence: [...input.evidence],
          })),
          merges: [],
        }
      },
    ),
  )
  track(
    spyOn(workspacePrerequisites, 'preparePrerequisites').mockImplementation(
      (input) => effects.prepare(input),
    ),
  )
  track(
    spyOn(workspaceContribution, 'acceptContribution').mockImplementation(
      (input) => effects.accept(input),
    ),
  )
  track(
    spyOn(
      workspaceChecks.ContributionChecks.prototype,
      'run',
    ).mockImplementation(function (this: workspaceChecks.ContributionChecks) {
      return effects.checks(this.request)
    }),
  )
  track(
    spyOn(workspaceContribution, 'applyIntegration').mockImplementation(
      (saved, accepted, _authorization, advance) => {
        const next = effects.apply(saved, accepted)
        advance?.(next)
        return next
      },
    ),
  )
  track(
    spyOn(
      workspaceContribution,
      'recoverAppliedIntegration',
    ).mockImplementation((saved, accepted) => ({
      ...saved,
      expectedRevision: accepted.revision,
    })),
  )
  track(
    spyOn(workspaceContribution, 'acceptReviewedHandoff').mockImplementation(
      (input) => effects.handoff(input),
    ),
  )
}
function installWorkers(
  effects: FixtureEffects,
  spyOn: typeof testSpyOn,
): void {
  track(
    spyOn(worker, 'preflightSession').mockResolvedValue(
      SessionManager.prototype,
    ),
  )
  track(
    spyOn(worker, 'createWorker').mockImplementation((input) =>
      Promise.resolve({
        identity: input.reopen ?? {
          id: `${input.assignment.id}:${input.artifacts}`,
          path: join(input.sessionsDirectory, `${input.assignment.id}.jsonl`),
          cwd: input.cwd,
        },
        prompt: (prompt, signal) => effects.produce(input, signal, prompt),
        close: () => Promise.resolve(),
      }),
    ),
  )
}
function fixtureRecovery(h: FixtureResources) {
  const { root, target, request, runDirectory, owner, worktree } = h
  function accepted(
    accepted: workspaceTypes.AcceptedContribution,
    retries = 0,
  ): AssignmentState {
    const id = accepted.acceptedRef.split('/').at(-2) ?? 'maker'
    const attempt: AttemptState = {
      number: 0,
      baseline: accepted.baseline,
      worktree: worktree(id, 0, accepted.baseline),
      ...attemptLayout(runDirectory, id, 0),
      sessionId: `${id}-session`,
      sessionPath: text(
        join(root, 'sessions', `${id}.jsonl`),
        'Saved transcript',
      ),
      inputs: {},
      receipts: [accepted.receipt],
      acceptedRevision: accepted.revision,
      candidateRevision: accepted.revision,
    }
    return { stage: 'accepted', retries, attempts: [attempt] }
  }
  function seed(
    checkpoint: Partial<Checkpoint> & Pick<Checkpoint, 'phase'>,
    update: Partial<RunState> = {},
    preparations = new Map<string, workspaceTypes.PrerequisiteBaseline>(),
  ): RunState {
    fs.mkdirSync(runDirectory, { recursive: true })
    const snapshot = join(runDirectory, 'snapshot.json')
    const { stages: _stages, ...body } = request.definition
    atomicWrite(snapshot, {
      source: request.source,
      definition: JSON.stringify(body),
      profiles: JSON.stringify({ profiles: request.assignments.profiles }),
      resources: Object.fromEntries(
        Object.keys(request.assignments.nodes).map((id) => [
          id,
          { instructions: [], skills: [] },
        ]),
      ),
    })
    const contributions = checkpoint.contributions ?? []
    const preparationRecords = Object.fromEntries(
      [...preparations].map(([id, baseline]) => {
        const path = join(runDirectory, `preparation-${id}.json`)
        atomicWrite(path, baseline)
        return [id, identity(path)]
      }),
    )
    const saved: SavedCheckpoint = {
      contributions: [],
      controls: [],
      ...checkpoint,
      workspace: workspaceCheckpoint.checkpointWorkspace(
        update.target ?? target,
        {
          contributions,
          preparations,
        },
      ),
      preparationNumber: preparations.size,
      preparationRecords,
      acceptedNodes: Object.fromEntries(
        Object.entries(update.assignments ?? {}).flatMap(([id, assignment]) => {
          if (assignment.stage !== 'accepted' || !request.definition.nodes[id])
            return []
          const contribution = contributions.find(
            (value) =>
              value.revision === assignment.attempts.at(-1)?.acceptedRevision,
          )
          return contribution ? [[id, { receipt: contribution.receipt }]] : []
        }),
      ),
      ...(preparations.has('integration')
        ? { finalPreparation: 'integration' }
        : {}),
    }
    const recovery = join(runDirectory, 'recovery-seed.json')
    atomicWrite(recovery, saved)
    const state: RunState = {
      schema: 1,
      runId: request.runId,
      status: 'paused',
      target,
      revisions: [
        {
          identity: identity(snapshot).sha256,
          source: snapshot,
          expanded: snapshot,
          reason: 'Initial admitted DAG',
          review: null,
        },
      ],
      assignments: {},
      repairRounds: { answer: 0 },
      cycle: null,
      needsAuthor: null,
      ...update,
      snapshots: {
        effective: snapshot,
        effectiveSha256: identity(snapshot).sha256,
        recovery,
        recoverySha256: identity(recovery).sha256,
      },
    }
    owner.write(state)
    return state
  }
  return { accepted, seed }
}
export function fixture(spyOn: typeof testSpyOn, options: FixtureOptions = {}) {
  const h = fixtureResources(options)
  const { request, owner } = h
  const effects = fixtureEffects(h)
  installWorkspace(h, effects, spyOn)
  installWorkers(effects, spyOn)
  function managed(
    signal = request.signal,
    capacity = new ExecutionCapacity(2),
    updated: RunRequest = request,
  ) {
    return managedDag({ ...updated, signal }, owner, {
      capacity,
      prerequisites: [],
      integrated: () => [],
      imports: () => [],
      importedMerges: () => [],
    })
  }
  return { ...h, effects, managed, ...fixtureRecovery(h) }
}
export function savedCheckpoint(state: RunState): SavedCheckpoint {
  return JSON.parse(fs.readFileSync(state.snapshots['recovery'] ?? '', 'utf8'))
}
export function reason(state: RunState): string {
  return JSON.parse(fs.readFileSync(state.needsAuthor ?? '', 'utf8')).reason
}
export function last(state: RunState, id: string): AttemptState {
  const value = state.assignments[id]?.attempts.at(-1)
  if (!value) throw new Error(`Missing ${id} attempt`)
  return value
}
