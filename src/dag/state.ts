import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  arr,
  compile,
  int,
  lit,
  map,
  nullable,
  obj,
  oneOf,
  opt,
  type Static,
  str,
} from '@earendil-works/pi-schema'

const text = str({ minLength: 1 })
const count = int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const targetSchema = obj({
  root: text,
  commonDirectory: text,
  gitDirectory: text,
  branch: nullable(text),
  launchRevision: text,
  expectedRevision: text,
})
export type TargetIdentity = Readonly<Static<typeof targetSchema>>
const attemptSchema = obj({
  number: count,
  baseline: text,
  worktree: text,
  artifacts: text,
  runner: text,
  inputs: map(text),
  definitionIdentity: opt(text),
  inputIdentities: opt(map(text)),
  sessionId: opt(text),
  sessionPath: opt(text),
  report: opt(text),
  candidateRevision: opt(text),
  acceptedRevision: opt(text),
  receipts: arr(text),
})
export type AttemptState = Readonly<Static<typeof attemptSchema>>
const assignmentSchema = obj({
  stage: oneOf([
    'ready',
    'running',
    'claimed',
    'checking',
    'accepted',
    'blocked',
    'failed',
    'interrupted',
  ]),
  retries: count,
  attempts: arr(attemptSchema),
})
export type AssignmentState = Readonly<Static<typeof assignmentSchema>>
const cycleSchema = obj({
  dagId: text,
  stage: oneOf(['integration', 'checks', 'review', 'repair']),
  revision: text,
  reviewInputs: map(text),
  verdict: opt(text),
})
export type IntegrationCycle = Readonly<Static<typeof cycleSchema>>
const runStatus = oneOf([
  'running',
  'paused',
  'needs-author',
  'failed',
  'succeeded',
])
const stateFields = {
  schema: lit(1),
  runId: text,
  status: runStatus,
  // Omitted for ordinary runs, which reserve the target checkout.
  ownership: opt(lit('run')),
  lifecycle: opt(
    obj({
      complete: oneOf([true, false]),
      events: arr(obj({ status: runStatus, at: text })),
    }),
  ),
  target: targetSchema,
  snapshots: map(text),
  revisions: arr(
    obj({
      identity: text,
      sha256: opt(text),
      source: text,
      expanded: text,
      reason: text,
      review: nullable(text),
    }),
  ),
  assignments: map(assignmentSchema),
  repairRounds: map(count),
  cycle: nullable(cycleSchema),
  needsAuthor: nullable(text),
  revisionPending: opt(oneOf([true, false])),
  revisionAffected: opt(oneOf([true, false])),
  revisionAffectedNodes: opt(arr(text)),
  affectedNodes: opt(map(arr(text))),
  approved: opt(arr(text)),
  invalidated: opt(arr(text)),
  restarts: opt(
    arr(
      obj({
        assignment: text,
        attempt: count,
        effect: oneOf(['replace-resources', 'repeat-command']),
        reason: text,
        stagedAt: text,
        previousWorktree: text,
        previousSessionPath: opt(text),
        previousSessionId: opt(text),
        consumedAt: opt(text),
      }),
    ),
  ),
}
const stateSchema = obj({
  ...stateFields,
  children: opt(map(obj(stateFields))),
  approvals: opt(
    arr(obj({ dagId: text, revision: opt(text), child: obj(stateFields) })),
  ),
})
export type RunState = Readonly<Static<typeof stateSchema>>
const storedState = compile(stateSchema)
const ownerRecordSchema = obj({
  pid: int({ minimum: 1 }),
  nonce: text,
  runDirectory: text,
})
const ownerSchema = compile(ownerRecordSchema)
export type OwnerRecord = Readonly<Static<typeof ownerRecordSchema>>

export class StateError extends Error {
  constructor(
    readonly code: string,
    readonly resource: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: inspect ${resource} before explicit recovery`, options)
    this.name = 'StateError'
  }
}
function boundary(error: unknown, resource: string): StateError {
  return new StateError('filesystem', resource, {
    cause: error instanceof Error ? error : new Error(String(error)),
  })
}
function absolutePath(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new StateError('absolute-path-required', path)
}
export function atomicWrite(path: string, value: unknown): void {
  absolutePath(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, path)
  } catch (error) {
    throw boundary(error, path)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    fs.rmSync(temporary, { force: true })
  }
}
export function readRunState(runDirectory: string): RunState {
  const path = join(runDirectory, 'state.json')
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path, 'utf8'))
    if (!storedState.check(value)) throw new StateError('invalid-state', path)
    return value
  } catch (error) {
    if (error instanceof StateError) throw error
    throw boundary(error, path)
  }
}
export function inspectOwner(path: string): {
  readonly owner: OwnerRecord
  readonly status: 'live' | 'stale' | 'ambiguous'
} {
  const value: unknown = JSON.parse(fs.readFileSync(path, 'utf8'))
  if (!ownerSchema.check(value)) throw new StateError('invalid-owner', path)
  try {
    process.kill(value.pid, 0)
    return { owner: value, status: 'live' }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return { owner: value, status: 'stale' }
    return { owner: value, status: 'ambiguous' }
  }
}
function exclusive(path: string, owner: OwnerRecord): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    // Publish a complete record atomically: a concurrent reader must never see
    // a partially written owner, and an existing record still wins.
    fs.writeFileSync(temporary, JSON.stringify(owner), {
      flag: 'wx',
      mode: 0o600,
    })
    fs.linkSync(temporary, path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new StateError('ownership-conflict', path)
    throw boundary(error, path)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}
function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_MASTER: '1' },
    encoding: 'utf8',
  })
  if (result.error || result.status !== 0)
    throw new StateError('git-identity', root, {
      cause: result.error ?? new Error(result.stderr),
    })
  return result.stdout.trim()
}
export function identifyTarget(root: string): TargetIdentity {
  const canonical = fs.realpathSync(root)
  const [commonDirectory, gitDirectory, revision, branch] = git(canonical, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
    '--absolute-git-dir',
    'HEAD',
    '--abbrev-ref',
    'HEAD',
  ]).split('\n')
  if (!commonDirectory || !gitDirectory || !revision || !branch)
    throw new StateError('git-identity', canonical)
  return {
    root: canonical,
    commonDirectory: fs.realpathSync(commonDirectory),
    gitDirectory: fs.realpathSync(gitDirectory),
    branch: branch === 'HEAD' ? null : branch,
    launchRevision: revision,
    expectedRevision: revision,
  }
}
export function addRuntimeExcludes(target: TargetIdentity): void {
  const directory = join(target.commonDirectory, 'info')
  fs.mkdirSync(directory, { recursive: true })
  const path = join(directory, 'exclude')
  // Repository metadata is attacker-writable when the checkout is not trusted:
  // never follow a redirected directory or exclusion file.
  if (fs.realpathSync(directory) !== directory)
    throw new StateError('metadata-symlink', directory)
  const existing = fs.lstatSync(path, { throwIfNoEntry: false })
  if (existing && !existing.isFile())
    throw new StateError('metadata-symlink', path)
  const flags = fs.constants.O_NOFOLLOW
  let prior = ''
  if (existing) {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | flags)
    try {
      prior = fs.readFileSync(fd, 'utf8')
    } finally {
      fs.closeSync(fd)
    }
  }
  const lines = new Set(prior.split(/\r?\n/))
  const missing = ['/.pi/dags/runs/', '/.pi/dags/wt/'].filter(
    (line) => !lines.has(line),
  )
  if (missing.length === 0) return
  const text = `${prior && !prior.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`
  const fd = fs.openSync(
    path,
    fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      flags,
    0o600,
  )
  try {
    fs.writeSync(fd, text)
  } finally {
    fs.closeSync(fd)
  }
}
export interface AttemptLayout {
  readonly artifacts: string
  readonly runner: string
}
export function attemptLayout(
  runDirectory: string,
  assignment: string,
  attempt: number,
): AttemptLayout {
  absolutePath(runDirectory)
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(assignment) ||
    !Number.isSafeInteger(attempt) ||
    attempt < 0
  )
    throw new StateError('invalid-attempt', assignment)
  const root = join(runDirectory, 'evidence', assignment, String(attempt))
  const artifacts = join(root, 'artifacts')
  const runner = join(root, 'runner')
  fs.mkdirSync(artifacts, { recursive: true })
  fs.mkdirSync(runner, { recursive: true })
  return { artifacts, runner }
}

/** Restricted child capability: no target reservation or parent-state write method. */
export interface DagRunOwner {
  readonly runDirectory: string
  readonly target: TargetIdentity
  write(state: RunState): RunState
  advanceTarget?(target: TargetIdentity): void
  recoveryCheckpoint(): {
    readonly state: RunState
    readonly path: string
    readonly value: unknown
  }
}

function ownChild(parent: RunState, dagId: string) {
  if (!parent.children || !Object.hasOwn(parent.children, dagId)) return
  return parent.children[dagId]
}

/** The coordinator owns this capability; status reads never instantiate it. */
export class RunOwner {
  private released: boolean = false
  private firstWrite: boolean = true
  private readonly locks: string[] = []
  private constructor(
    readonly runDirectory: string,
    readonly target: TargetIdentity,
    private readonly record: OwnerRecord,
    private readonly reservation: string | undefined,
  ) {}
  static acquire(options: {
    readonly runDirectory: string
    readonly target: TargetIdentity
    readonly ownership?: RunState['ownership']
  }): RunOwner {
    for (const path of [
      options.runDirectory,
      options.target.root,
      options.target.commonDirectory,
      options.target.gitDirectory,
    ])
      absolutePath(path)
    const directory = resolve(options.runDirectory)
    const metadata = join(options.target.commonDirectory, 'pi-dags')
    fs.mkdirSync(metadata, { recursive: true })
    // Hash canonical checkout, not common-dir: other worktrees remain usable.
    const key = createHash('sha256').update(options.target.root).digest('hex')
    const reservation =
      options.ownership === 'run'
        ? undefined
        : join(metadata, `${key}.reservation.json`)
    const record = {
      pid: process.pid,
      nonce: randomUUID(),
      runDirectory: directory,
    }
    const owner = new RunOwner(directory, options.target, record, reservation)
    try {
      owner.lockTarget(metadata, key)
      addRuntimeExcludes(options.target)
      fs.mkdirSync(directory, { recursive: true })
      const runLock = join(directory, 'owner.lock')
      exclusive(runLock, record)
      owner.locks.push(runLock)
      if (reservation && !fs.existsSync(reservation))
        exclusive(reservation, record)
      return owner
    } catch (error) {
      owner.release()
      if (error instanceof StateError) throw error
      throw boundary(error, directory)
    }
  }
  private lockTarget(metadata: string, key: string): void {
    if (!this.reservation) return
    const targetLock = join(metadata, `${key}.lock`)
    exclusive(targetLock, this.record)
    this.locks.push(targetLock)
    if (fs.existsSync(this.reservation)) {
      const prior = inspectOwner(this.reservation).owner
      if (prior.runDirectory !== this.runDirectory)
        throw new StateError('target-reserved', this.reservation)
    }
  }
  private assertOwned(): void {
    if (this.released) throw new StateError('owner-released', this.runDirectory)
    for (const path of this.locks) {
      if (inspectOwner(path).owner.nonce !== this.record.nonce)
        throw new StateError('owner-changed', path)
    }
  }
  write(state: RunState): RunState {
    this.assertOwned()
    if (
      !storedState.check(state) ||
      state.target.root !== this.target.root ||
      state.target.commonDirectory !== this.target.commonDirectory
    )
      throw new StateError('state-identity', this.runDirectory)
    const path = join(this.runDirectory, 'state.json')
    const prior = fs.existsSync(path)
      ? readRunState(this.runDirectory)
      : undefined
    const lifecycle = prior?.lifecycle ?? {
      complete: prior === undefined,
      events: [],
    }
    const events =
      lifecycle.events.at(-1)?.status === state.status
        ? lifecycle.events
        : [
            ...lifecycle.events,
            { status: state.status, at: new Date().toISOString() },
          ]
    const saved = {
      ...state,
      ...(!this.reservation ? { ownership: 'run' as const } : {}),
      lifecycle: {
        complete:
          lifecycle.complete &&
          !(this.firstWrite && prior?.status === 'running'),
        events,
      },
    }
    atomicWrite(path, saved)
    this.firstWrite = false
    return saved
  }
  private assertChildIdentity(
    dagId: string,
    child: RunState,
    current: RunState,
  ): void {
    if (
      child.target.root !== current.target.root ||
      child.runId !== `${current.runId}.${dagId}`
    )
      throw new StateError('state-identity', dagId)
    const before = ownChild(current, dagId)
    if (
      before &&
      before.target.expectedRevision !== child.target.expectedRevision &&
      child.target.expectedRevision !== current.target.expectedRevision
    )
      throw new StateError('target-unapproved', dagId)
  }
  private writeChild(dagId: string, child: RunState): RunState {
    this.assertOwned()
    const current = readRunState(this.runDirectory)
    this.assertChildIdentity(dagId, child, current)
    const invalidated =
      current.invalidated?.includes(dagId) && child.status !== 'succeeded'
    this.write({
      ...current,
      children: { ...current.children, [dagId]: child },
      approved: invalidated
        ? (current.approved ?? []).filter((id) => id !== dagId)
        : (current.approved ?? []),
      invalidated: invalidated
        ? (current.invalidated ?? []).filter((id) => id !== dagId)
        : (current.invalidated ?? []),
      ...(current.affectedNodes
        ? {
            affectedNodes: invalidated
              ? Object.fromEntries(
                  Object.entries(current.affectedNodes).filter(
                    ([id]) => id !== dagId,
                  ),
                )
              : current.affectedNodes,
          }
        : {}),
      cycle:
        child.cycle && current.cycle?.dagId === dagId
          ? { ...child.cycle, dagId }
          : current.cycle,
    })
    return child
  }
  /** Child writes are scoped to one atomic parent progress record. */
  child(dagId: string): DagRunOwner {
    this.assertOwned()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(dagId))
      throw new StateError('invalid-dag', dagId)
    const directory = this.runDirectory
    return {
      runDirectory: join(directory, 'dags', dagId),
      get target() {
        return readRunState(directory).target
      },
      write: (child) => this.writeChild(dagId, child),
      advanceTarget: (target) => this.advanceChildTarget(dagId, target),
      recoveryCheckpoint: () => this.recoveryCheckpoint(dagId),
    }
  }
  /** Immutable reviewed child snapshot; the parent record binds reviewer and recovery identity. */
  archivedChild(index: number): DagRunOwner {
    this.assertOwned()
    const entry = readRunState(this.runDirectory).approvals?.[index]
    if (!entry) throw new StateError('missing-approval', String(index))
    return {
      runDirectory: join(this.runDirectory, 'dags', entry.dagId),
      target: entry.child.target,
      write: () => {
        throw new StateError('read-only-approval', entry.dagId)
      },
      recoveryCheckpoint: () => this.recoveryCheckpoint(undefined, index),
    }
  }
  /** An idle cycle is a durable lease, not an execution-capacity slot. */
  claimCycle(dagId: string): void {
    this.assertOwned()
    const current = readRunState(this.runDirectory)
    if (current.cycle && current.cycle.dagId !== dagId)
      throw new StateError('cycle-ownership', current.cycle.dagId)
    this.write({
      ...current,
      cycle: current.cycle ?? {
        dagId,
        stage: 'integration',
        revision: current.target.expectedRevision,
        reviewInputs: {},
      },
    })
  }
  /** Record the exact intended fast-forward before another child sees the new target. */
  private advanceChildTarget(dagId: string, target: TargetIdentity): void {
    this.assertOwned()
    const current = readRunState(this.runDirectory)
    const actual = identifyTarget(current.target.root)
    if (
      current.cycle?.dagId !== dagId ||
      current.cycle.reviewInputs['intendedRevision'] !==
        target.expectedRevision ||
      current.cycle.reviewInputs['intendedTree'] !==
        git(current.target.root, [
          'rev-parse',
          `${target.expectedRevision}^{tree}`,
        ]) ||
      actual.expectedRevision !== target.expectedRevision ||
      actual.commonDirectory !== current.target.commonDirectory ||
      actual.branch !== current.target.branch ||
      git(current.target.root, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ]) !== ''
    )
      throw new StateError('target-advance', dagId)
    this.write({ ...current, target })
  }
  /** A final finding reopens an approved DAG under its accumulated limits. */
  reopenCycle(dagId: string, dependents: readonly string[] = []): void {
    this.assertOwned()
    const current = readRunState(this.runDirectory)
    if (
      current.cycle ||
      !current.approved?.includes(dagId) ||
      current.status !== 'needs-author'
    )
      throw new StateError('cycle-ownership', dagId)
    const {
      overallInput: _input,
      overallInputSha256: _sha,
      ...snapshots
    } = current.snapshots
    this.write({
      ...current,
      status: 'running',
      needsAuthor: null,
      approved: current.approved.filter((id) => id !== dagId),
      invalidated: [
        ...new Set([...(current.invalidated ?? []), ...dependents]),
      ],
      snapshots,
      cycle: {
        dagId,
        stage: 'repair',
        revision: current.target.expectedRevision,
        reviewInputs: {},
      },
    })
  }
  approveCycle(dagId: string): void {
    this.assertOwned()
    const current = readRunState(this.runDirectory)
    const child = ownChild(current, dagId)
    if (current.cycle?.dagId !== dagId || child?.status !== 'succeeded')
      throw new StateError('cycle-ownership', dagId)
    const revision = current.revisions.at(-1)?.identity
    this.write({
      ...current,
      cycle: null,
      approved: [...(current.approved ?? []), dagId],
      approvals: [
        ...(current.approvals ?? []),
        {
          dagId,
          ...(revision ? { revision } : {}),
          child,
        },
      ],
    })
  }
  /** Only the live coordinator can restore trust from the current runner-bound checkpoint. */
  recoveryCheckpoint(dagId?: string, archiveIndex?: number) {
    this.assertOwned()
    const parent = readRunState(this.runDirectory)
    const archived =
      archiveIndex === undefined ? undefined : parent.approvals?.[archiveIndex]
    const state = archived?.child ?? (dagId ? ownChild(parent, dagId) : parent)
    if (!state)
      throw new StateError('missing-dag', dagId ?? String(archiveIndex))
    const directory =
      archived || dagId
        ? join(this.runDirectory, 'dags', archived?.dagId ?? dagId ?? '')
        : this.runDirectory
    const path = state.snapshots['recovery']
    if (
      !path ||
      dirname(path) !== directory ||
      !path.startsWith(join(directory, 'recovery-')) ||
      fs.realpathSync(path) !== path ||
      !fs.lstatSync(path).isFile()
    )
      throw new StateError('invalid-checkpoint', path ?? this.runDirectory)
    const bytes = fs.readFileSync(path)
    if (
      createHash('sha256').update(bytes).digest('hex') !==
      state.snapshots['recoverySha256']
    )
      throw new StateError('changed-checkpoint', path)
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    return { state, path, value }
  }
  /** Explicit terminal approval/failure decision; pause deliberately retains reservation. */
  releaseReservation(): void {
    this.assertOwned()
    if (!this.reservation) return
    if (inspectOwner(this.reservation).owner.runDirectory !== this.runDirectory)
      throw new StateError('reservation-changed', this.reservation)
    fs.unlinkSync(this.reservation)
  }
  release(): void {
    if (this.released) return
    for (const path of this.locks.toReversed()) {
      if (inspectOwner(path).owner.nonce !== this.record.nonce)
        throw new StateError('owner-changed', path)
      fs.unlinkSync(path)
    }
    this.released = true
  }
}
