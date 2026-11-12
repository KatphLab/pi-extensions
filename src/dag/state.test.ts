import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addRuntimeExcludes,
  atomicWrite,
  attemptLayout,
  identifyTarget,
  inspectOwner,
  RunOwner,
  type RunState,
  readRunState,
} from './state.js'

const roots: string[] = []
const owners: RunOwner[] = []
afterEach(() => {
  for (const owner of owners.splice(0)) owner.release()
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    env: {
      ...process.env,
      GIT_MASTER: '1',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'state-'))
  roots.push(root)
  git(root, ['init', '-q'])
  fs.writeFileSync(join(root, '.gitignore'), 'user-only\n')
  fs.writeFileSync(join(root, 'source'), 'initial')
  git(root, ['add', '.'])
  git(root, [
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'fixture',
    '--trailer',
    'Co-authored-by: sisyphus-dev-ai <sisyphus-dev-ai@users.noreply.github.com>',
  ])
  const target = identifyTarget(root)
  const runDirectory = join(root, '.pi/dags/runs/run-a')
  const owner = RunOwner.acquire({ target, runDirectory })
  owners.push(owner)
  const state: RunState = {
    schema: 1,
    runId: 'run-a',
    status: 'running',
    target,
    snapshots: {
      profiles: '/frozen/profiles',
      assignment: '/frozen/assignment',
    },
    revisions: [
      {
        identity: 'definition-1',
        source: '/frozen/source',
        expanded: '/frozen/expanded',
        reason: 'launch',
        review: '/review',
      },
    ],
    assignments: {
      build: {
        stage: 'interrupted',
        retries: 1,
        attempts: [
          {
            number: 1,
            baseline: target.launchRevision,
            worktree: '/exact/worktree',
            artifacts: '/artifacts',
            runner: '/runner',
            inputs: {
              parent: 'accepted-parent',
              evidence: 'artifact-identity',
            },
            definitionIdentity: 'frozen-effective-assignment',
            inputIdentities: {
              parent: 'accepted-parent',
              prerequisites: 'valid-node-id',
            },
            sessionId: 'exact-id',
            sessionPath: '/exact/session.jsonl',
            receipts: ['/observed/receipt'],
          },
        ],
      },
    },
    repairRounds: { dag: 2 },
    cycle: {
      dagId: 'dag',
      stage: 'review',
      revision: target.launchRevision,
      reviewInputs: { tree: 'exact-tree' },
    },
    needsAuthor: null,
  }
  return { root, runDirectory, owner, state, target }
}
test('missing absolute coordinator paths fail before creating run or evidence directories', () => {
  const { root, target } = fixture()
  const unopened = join(root, 'unopened-git')
  expect(() =>
    RunOwner.acquire({
      runDirectory: 'undefined',
      target: { ...target, commonDirectory: unopened },
    }),
  ).toThrow('absolute-path-required')
  expect(fs.existsSync(unopened)).toBe(false)
  expect(() => attemptLayout('undefined', 'build', 0)).toThrow(
    'absolute-path-required',
  )
  expect(() => atomicWrite('undefined/context.json', {})).toThrow(
    'absolute-path-required',
  )
})
describe('owned checkpoints and argv commands', () => {
  test('preserves exact progress and cycle while status reads require no owner', () => {
    const { owner, state, runDirectory } = fixture()
    owner.write(state)
    owner.write({ ...state, status: 'paused' })
    owner.write({ ...state, status: 'running' })
    owner.write({ ...state, status: 'running' })
    owner.write({ ...state, status: 'succeeded' })
    owner.release()
    const before = fs.readdirSync(runDirectory)
    const saved = readRunState(runDirectory)
    expect(saved).toMatchObject({ ...state, status: 'succeeded' })
    expect(saved.lifecycle?.complete).toBe(true)
    expect(saved.lifecycle?.events.map((event) => event.status)).toEqual([
      'running',
      'paused',
      'running',
      'succeeded',
    ])
    expect(
      saved.lifecycle?.events.every((event) =>
        Number.isFinite(Date.parse(event.at)),
      ),
    ).toBe(true)
    expect(fs.readdirSync(runDirectory)).toEqual(before)
    expect(() => owner.write(state)).toThrow('owner-released')
  })
  test.each(['constructor', 'toString'])(
    'treats prototype-named DAG %s as absent until its own child is persisted',
    (dagId) => {
      const { owner, state, runDirectory } = fixture()
      owner.write({ ...state, children: {}, cycle: null })
      const child = owner.child(dagId)
      expect(() => child.recoveryCheckpoint()).toThrow('missing-dag')
      fs.mkdirSync(child.runDirectory, { recursive: true })
      const path = join(child.runDirectory, 'recovery-known.json')
      atomicWrite(path, { phase: 'reviewed' })
      const completed: RunState = {
        ...state,
        runId: `${state.runId}.${dagId}`,
        status: 'succeeded',
        cycle: null,
        snapshots: {
          recovery: path,
          recoverySha256: createHash('sha256')
            .update(fs.readFileSync(path))
            .digest('hex'),
        },
      }
      child.write(completed)
      expect(readRunState(runDirectory).children?.[dagId]).toEqual(completed)
      expect(child.recoveryCheckpoint().value).toEqual({ phase: 'reviewed' })
      owner.claimCycle(dagId)
      owner.approveCycle(dagId)
      expect(readRunState(runDirectory).approvals?.at(-1)).toMatchObject({
        dagId,
        child: completed,
      })
      const archived = owner.archivedChild(0)
      expect(archived.recoveryCheckpoint().value).toEqual({ phase: 'reviewed' })
      expect(() => archived.write({ ...completed, status: 'running' })).toThrow(
        'read-only-approval',
      )
    },
  )
  test('refuses a redirected exclusion file instead of writing through it', () => {
    const { root, target } = fixture()
    const victim = join(root, 'victim')
    fs.writeFileSync(victim, 'user bytes\n')
    const info = join(target.commonDirectory, 'info')
    fs.mkdirSync(info, { recursive: true })
    const exclude = join(info, 'exclude')
    fs.rmSync(exclude, { force: true })
    fs.symlinkSync(victim, exclude)
    expect(() => addRuntimeExcludes(target)).toThrow('metadata-symlink')
    expect(fs.readFileSync(victim, 'utf8')).toBe('user bytes\n')
    fs.rmSync(exclude, { force: true })
    fs.writeFileSync(exclude, 'user rule\n')
    addRuntimeExcludes(target)
    expect(fs.readFileSync(exclude, 'utf8')).toBe(
      'user rule\n/.pi/dags/runs/\n/.pi/dags/wt/\n',
    )
  })
  test('publishes a complete owner record without leaving publication temporaries', () => {
    const { runDirectory } = fixture()
    expect(
      fs.readdirSync(runDirectory).filter((name) => name.endsWith('.tmp')),
    ).toEqual([])
    expect(
      JSON.parse(fs.readFileSync(join(runDirectory, 'owner.lock'), 'utf8')),
    ).toMatchObject({ pid: expect.any(Number) })
    expect(() =>
      RunOwner.acquire({
        target: identifyTarget(runDirectory.split('/.pi/')[0] ?? ''),
        runDirectory,
      }),
    ).toThrow('ownership-conflict')
  })
  test('excludes only runtime roots and allows a different target worktree', () => {
    const { root, owner, target } = fixture()
    addRuntimeExcludes(target)
    fs.mkdirSync(join(root, '.pi/dags/plans'), { recursive: true })
    fs.writeFileSync(join(root, '.pi/dags/plans/authored.yaml'), 'authored')
    expect(fs.readFileSync(join(root, '.gitignore'), 'utf8')).toBe(
      'user-only\n',
    )
    expect(git(root, ['status', '--short', '--untracked-files=all'])).toBe(
      '?? .pi/dags/plans/authored.yaml',
    )
    expect(
      fs
        .readFileSync(join(target.commonDirectory, 'info/exclude'), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('/.pi/')),
    ).toEqual(['/.pi/dags/runs/', '/.pi/dags/wt/'])
    const worktree = join(root, 'other')
    git(root, ['worktree', 'add', '--detach', worktree, 'HEAD'])
    const other = RunOwner.acquire({
      target: identifyTarget(worktree),
      runDirectory: join(worktree, '.pi/dags/runs/other'),
    })
    owners.push(other)
    other.releaseReservation()
    owner.releaseReservation()
  })
})
describe('ownership and command interruption', () => {
  test('run-only ownership preserves paused target reservations and still excludes a second owner of the same run', () => {
    const { root, target, owner, state, runDirectory: original } = fixture()
    owner.write({ ...state, status: 'paused' })
    const metadata = join(target.commonDirectory, 'pi-dags')
    const reservation = join(
      metadata,
      fs
        .readdirSync(metadata)
        .find((name) => name.endsWith('.reservation.json')) ?? '',
    )
    const before = fs.readFileSync(reservation, 'utf8')
    const runDirectory = join(root, '.pi/dags/runs/review')
    const review = RunOwner.acquire({ target, runDirectory, ownership: 'run' })
    owners.push(review)
    const saved = review.write({ ...state, runId: 'review' })
    expect(saved.ownership).toBe('run')
    expect(() =>
      RunOwner.acquire({ target, runDirectory, ownership: 'run' }),
    ).toThrow('ownership-conflict')
    review.releaseReservation()
    review.release()
    expect(fs.readFileSync(reservation, 'utf8')).toBe(before)
    owner.release()
    expect(() =>
      RunOwner.acquire({ target, runDirectory: join(root, 'other') }),
    ).toThrow('target-reserved')
    const resumed = RunOwner.acquire({ target, runDirectory: original })
    owners.push(resumed)
    resumed.releaseReservation()
    resumed.release()
    const standalone = RunOwner.acquire({
      target,
      runDirectory,
      ownership: 'run',
    })
    owners.push(standalone)
    standalone.releaseReservation()
    standalone.release()
    expect(fs.existsSync(reservation)).toBe(false)
  })
  test('rejects a second real client and retains paused reservation until explicit release', () => {
    const { root, target, runDirectory, owner, state } = fixture()
    owner.write({ ...state, status: 'paused' })
    const script = join(root, 'client.ts')
    fs.writeFileSync(
      script,
      `import { RunOwner } from ${JSON.stringify(new URL('./state.ts', import.meta.url).pathname)}; try { RunOwner.acquire(JSON.parse(process.argv[2])); process.exit(9) } catch(e) { console.log(e.code) }`,
    )
    const result = spawnSync(
      process.execPath,
      [script, JSON.stringify({ target, runDirectory })],
      { env: process.env, encoding: 'utf8' },
    )
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('ownership-conflict')
    owner.release()
    expect(() =>
      RunOwner.acquire({
        target,
        runDirectory: join(root, '.pi/dags/runs/another'),
      }),
    ).toThrow('target-reserved')
    const resumed = RunOwner.acquire({ target, runDirectory })
    owners.push(resumed)
    expect(readRunState(runDirectory).cycle).toEqual(state.cycle)
    resumed.releaseReservation()
  })
  test.each([true, false])(
    'retains unknown timing for legacy or orphaned running checkpoints (legacy=%s)',
    (legacy) => {
      const { owner, state, runDirectory, target } = fixture()
      if (legacy) atomicWrite(join(runDirectory, 'state.json'), state)
      else owner.write(state)
      owner.release()
      const resumed = RunOwner.acquire({ runDirectory, target })
      owners.push(resumed)
      const saved = resumed.write({ ...state, status: 'paused' })
      expect(saved.lifecycle?.complete).toBe(false)
      expect(saved.lifecycle?.events.at(-1)?.status).toBe('paused')
    },
  )
  test('keeps complete previous JSON when atomic rename fails', () => {
    const { owner, state, runDirectory } = fixture()
    const saved = owner.write(state)
    const rename = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('injected EIO')
    })
    try {
      expect(() => owner.write({ ...state, status: 'succeeded' })).toThrow(
        'filesystem',
      )
    } finally {
      rename.mockRestore()
    }
    expect(readRunState(runDirectory)).toEqual(saved)
    expect(fs.readdirSync(runDirectory).sort()).toEqual([
      'owner.lock',
      'state.json',
    ])
  })
  test('inspects stale owners without taking over and rejects malformed progress', () => {
    const { owner, state, runDirectory, target } = fixture()
    owner.write(state)
    owner.release()
    const child = spawnSync(
      process.execPath,
      ['-e', 'console.log(process.pid)'],
      { env: process.env, encoding: 'utf8' },
    )
    const lock = join(runDirectory, 'owner.lock')
    fs.writeFileSync(
      lock,
      JSON.stringify({
        pid: Number(child.stdout),
        nonce: 'dead-process',
        runDirectory,
      }),
    )
    expect(inspectOwner(lock).status).toBe('stale')
    expect(() => RunOwner.acquire({ target, runDirectory })).toThrow(
      'ownership-conflict',
    )
    fs.writeFileSync(join(runDirectory, 'state.json'), '{"status":"succeeded"}')
    expect(() => readRunState(runDirectory)).toThrow('invalid-state')
  })
})

test('only the cycle owner can publish its intended clean target revision to children', () => {
  const { root, owner, state, target, runDirectory } = fixture()
  owner.write({ ...state, cycle: null, children: {} })
  const child = owner.child('build')
  owner.claimCycle('build')
  fs.writeFileSync(join(root, 'source'), 'reviewed change')
  git(root, ['add', 'source'])
  git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'reviewed'])
  const next = { ...target, expectedRevision: git(root, ['rev-parse', 'HEAD']) }
  expect(() => child.advanceTarget?.(next)).toThrow('target-advance')
  expect(child.target).toEqual(target)
  const current = readRunState(runDirectory)
  owner.write({
    ...current,
    cycle: {
      dagId: 'build',
      stage: 'integration',
      revision: target.expectedRevision,
      reviewInputs: {
        intendedRevision: next.expectedRevision,
        intendedTree: git(root, ['rev-parse', 'HEAD^{tree}']),
      },
    },
  })
  expect(() => owner.child('other').advanceTarget?.(next)).toThrow(
    'target-advance',
  )
  fs.writeFileSync(join(root, 'source'), 'uncommitted user edit')
  expect(() => child.advanceTarget?.(next)).toThrow('target-advance')
  expect(child.target).toEqual(target)
  fs.writeFileSync(join(root, 'source'), 'reviewed change')
  child.advanceTarget?.(next)
  expect(child.target).toEqual(next)
  expect(readRunState(runDirectory).target).toEqual(next)
})

test.each(['valid', 'changed', 'foreign', 'released'])(
  'restores only the current owned hash-bound checkpoint: %s',
  (kind) => {
    const { owner, state, runDirectory, root } = fixture()
    const path = join(
      kind === 'foreign' ? root : runDirectory,
      'recovery-known.json',
    )
    atomicWrite(path, { phase: 'worker', resources: ['exact-session'] })
    owner.write({
      ...state,
      snapshots: {
        ...state.snapshots,
        recovery: path,
        recoverySha256: createHash('sha256')
          .update(fs.readFileSync(path))
          .digest('hex'),
      },
    })
    if (kind === 'changed') fs.appendFileSync(path, ' ')
    if (kind === 'released') owner.release()
    if (kind === 'valid')
      expect(owner.recoveryCheckpoint().value).toEqual({
        phase: 'worker',
        resources: ['exact-session'],
      })
    else
      expect(() => owner.recoveryCheckpoint()).toThrow(
        {
          changed: 'changed-checkpoint',
          foreign: 'invalid-checkpoint',
          released: 'owner-released',
        }[kind],
      )
  },
)
