import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { ArtifactIdentity } from '@dag/command.js'
import { attemptLayout } from '@dag/state.js'
import { acceptedInput } from './capabilities.js'
import {
  acceptContribution,
  acceptReviewedHandoff,
  applyIntegration,
  prepareIntegration,
} from './contribution.js'
import { preparePrerequisites } from './prerequisites.js'
import {
  check,
  cleanupWorkspace,
  fixture,
  git,
  handoffProgress,
  preparation,
} from './test-fixture.js'
import type {
  ContributionRequest,
  Prerequisite,
  ReviewedHandoffRequest,
} from './types.js'

afterEach(cleanupWorkspace)
async function reviewedHandoff() {
  const original = fixture()
  fs.unlinkSync(join(original.worktree, 'allowed/delete'))
  fs.renameSync(
    join(original.worktree, 'allowed/rename'),
    join(original.worktree, 'allowed/renamed'),
  )
  const branchChecks = check(
    "if (await Bun.file('allowed/delete').exists() || await Bun.file('allowed/rename').exists() || await Bun.file('allowed/renamed').text() !== 'rename me') process.exit(1)",
  )
  const branch: Prerequisite = {
    id: original.identity.assignment,
    needs: [],
    write: original.write,
    checks: branchChecks,
    input: acceptedInput(
      await acceptContribution({ ...original, checks: branchChecks }),
    ),
  }
  const prepared = await preparePrerequisites(
    preparation(original, [branch], [branch.id]),
  )
  const authorization = { prerequisites: prepared, write: original.write }
  const worktree = prepareIntegration(
    original.target,
    branch.input.contribution,
    {
      ...original.identity,
      assignment: 'integrator',
      baseline: original.baseline,
      role: 'assignment',
    },
    authorization,
  )
  fs.writeFileSync(join(worktree, 'allowed/edit'), 'reviewed edit')
  const final = await acceptContribution({
    ...original,
    ...attemptLayout(
      join(original.target.root, '.pi/dags/runs/run'),
      'integrator',
      0,
    ),
    worktree,
    baseline: prepared.revision,
    identity: {
      ...original.identity,
      assignment: 'integrator',
      revision: prepared.revision,
    },
    outputs: [],
    checks: check(
      "if (await Bun.file('allowed/edit').text() !== 'reviewed edit') process.exit(1)",
    ),
  })
  const target = applyIntegration(original.target, final, authorization)
  const request = {
    ...original,
    ...attemptLayout(
      join(original.target.root, '.pi/dags/runs/run'),
      'reviewed-handoff',
      0,
    ),
    target,
    baseline: branch.input.contribution.revision,
    identity: {
      ...original.identity,
      assignment: 'reviewed-handoff',
      revision: branch.input.contribution.revision,
    },
    outputs: [],
    branch: branch.input.contribution,
    final,
    preparation: prepared,
  }
  return { request, final, target }
}

test('durable reviewed handoff retains deletions and renames across an interrupted check', async () => {
  const { request, final, target } = await reviewedHandoff()
  const decisionsPath = join(request.runner, 'repeat-decisions.jsonl')
  const durable = {
    ...handoffProgress(request.runner),
    repeat: (index: number, settled?: ArtifactIdentity): void => {
      if (!settled) throw new Error('missing inspected interrupted receipt')
      const progress = durable.read()
      fs.appendFileSync(
        decisionsPath,
        `${JSON.stringify({ index, settled })}\n`,
      )
      durable.write({
        ...progress,
        repeat: { ...progress.repeat, [index]: settled },
      })
    },
  }
  const {
    started,
    sockets,
    server,
    controller,
    counter,
    deferred,
    checks,
    outcome,
    connections,
  } = await interruptHandoff(request, durable)
  try {
    await Promise.race([
      started.promise,
      outcome.then((error) => {
        throw new Error(`unexpected settlement: ${String(error)}`)
      }),
    ])
    controller.abort()
    expect(await outcome).toMatchObject({ code: 'interrupted' })
    const candidatePath = join(request.runner, 'candidate.json')
    const candidateBytes = fs.readFileSync(candidatePath, 'utf8')
    const candidate = JSON.parse(candidateBytes)
    const progress = durable.read()
    expect(progress.started).toEqual([0, 1])
    expect(Object.keys(progress.completed)).toEqual(['0'])
    expect(progress.observations['2']).toBeUndefined()
    expect(fs.existsSync(deferred)).toBe(false)
    const observations = [0, 1].map((index) =>
      JSON.parse(
        fs.readFileSync(
          join(request.runner, `check-${index}/observed-0.json`),
          'utf8',
        ),
      ),
    )
    const receipts = observations.map((item) =>
      JSON.parse(fs.readFileSync(item.receipt, 'utf8')),
    )
    expect(receipts.map((item) => item.status)).toEqual([
      'completed',
      'interrupted',
    ])
    expect(() => process.kill(receipts[1].pid, 0)).toThrow()
    const identities = observations.map((item) =>
      fs.readFileSync(item.receipt, 'utf8'),
    )
    const stage = join(
      target.root,
      '.pi/dags/wt/run/reviewed-handoff-0-assignment',
    )
    const index = git(stage, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index',
    ])
    const staged = worktreeState(stage, index)
    expect(staged.bytes).toBe('reviewed edit')
    expect(staged.tree).toBe(final.tree)
    fs.writeFileSync(
      join(stage, 'allowed/edit'),
      'local edit after interruption',
    )
    expect(() =>
      acceptReviewedHandoff({ ...request, checks, durable }, true),
    ).toThrow('changed-worktree')
    expect(fs.readFileSync(join(stage, 'allowed/edit'), 'utf8')).toBe(
      'local edit after interruption',
    )
    fs.writeFileSync(join(stage, 'allowed/edit'), staged.bytes)
    const resumed = await acceptReviewedHandoff(
      { ...request, checks, durable },
      true,
    )
    expect(worktreeState(stage, index)).toEqual(staged)
    expect(
      fs.readFileSync(join(resumed.validationWorktree, 'allowed/edit'), 'utf8'),
    ).toBe('reviewed edit')
    expect(resumed.revision).toBe(candidate.revision)
    expect(resumed.tree).toBe(final.tree)
    expect(resumed.validationWorktree).toBe(candidate.validationWorktree)
    expect(fs.readFileSync(candidatePath, 'utf8')).toBe(candidateBytes)
    expect(fs.readFileSync(counter, 'utf8')).toBe('completed\n')
    expect(fs.readFileSync(deferred, 'utf8')).toBe('deferred\n')
    expect(connections()).toBe(2)
    expect(
      observations.map((item) => fs.readFileSync(item.receipt, 'utf8')),
    ).toEqual(identities)
    expect(resumed.receipts[0]).toBe(observations[0].receipt)
    expect(resumed.receipts[1]).not.toBe(observations[1].receipt)
    expect(
      fs
        .readdirSync(join(request.runner, 'check-0'))
        .filter((name) => name.startsWith('command-')),
    ).toHaveLength(1)
    expect(
      fs
        .readdirSync(join(request.runner, 'check-1'))
        .filter((name) => name.startsWith('command-')),
    ).toHaveLength(2)
    expect(durable.read().repeat).toEqual({})
    const decisions = fs
      .readFileSync(decisionsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const interruptedPath = join(request.runner, 'check-1/observed-0.json')
    const interruptedBytes = fs.readFileSync(interruptedPath)
    expect(decisions).toEqual([
      {
        index: 1,
        settled: {
          path: interruptedPath,
          sha256: createHash('sha256').update(interruptedBytes).digest('hex'),
          bytes: interruptedBytes.length,
        },
      },
    ])
    expect(Object.keys(durable.read().completed)).toEqual(['0', '1', '2'])
    expect(git(request.target.root, ['rev-parse', resumed.acceptedRef])).toBe(
      candidate.revision,
    )
    const published = await acceptReviewedHandoff(
      { ...request, checks, durable },
      true,
    )
    expect(published).toEqual(resumed)
    expect(acceptedInput(published).contribution).toEqual(published)
    expect(fs.readFileSync(counter, 'utf8')).toBe('completed\n')
    expect(fs.readFileSync(deferred, 'utf8')).toBe('deferred\n')
    expect(connections()).toBe(2)
    const retainedStage = `${stage}.retained`
    fs.renameSync(stage, retainedStage)
    expect(() =>
      acceptReviewedHandoff({ ...request, checks, durable }, true),
    ).toThrow('missing-worktree')
    expect(fs.existsSync(stage)).toBe(false)
    expect(fs.readFileSync(join(retainedStage, 'allowed/edit'), 'utf8')).toBe(
      'reviewed edit',
    )
    expect(fs.readFileSync(counter, 'utf8')).toBe('completed\n')
  } finally {
    controller.abort()
    await outcome
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function interruptHandoff(
  request: ReviewedHandoffRequest,
  durable: NonNullable<ContributionRequest['durable']>,
) {
  const started = Promise.withResolvers<void>()
  const sockets = new Set<import('node:net').Socket>()
  let connections = 0
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('data', () => {
      connections++
      if (connections === 1) started.resolve()
      else socket.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('missing listener')
  const controller = new AbortController()
  const counter = join(request.runner, 'completed-count.txt')
  const deferred = join(request.runner, 'deferred-count.txt')
  const checks = [
    {
      id: 'completed',
      argv: [
        process.execPath,
        '-e',
        `import * as fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(counter)}, ${JSON.stringify('completed\n')})`,
      ],
    },
    {
      id: 'interrupted',
      argv: [
        process.execPath,
        '-e',
        `import { connect } from 'node:net'; const socket = connect(${address.port}, '127.0.0.1', () => socket.write('ready'))`,
      ],
    },
    {
      id: 'not-started',
      argv: [
        process.execPath,
        '-e',
        `import * as fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(deferred)}, ${JSON.stringify('deferred\n')})`,
      ],
    },
  ]
  const operation = Promise.resolve().then(() =>
    acceptReviewedHandoff({
      ...request,
      checks,
      durable,
      resumable: true,
      signal: controller.signal,
    }),
  )
  const outcome = operation.then(
    () => null,
    (error: unknown) => error,
  )
  return {
    started,
    sockets,
    server,
    controller,
    counter,
    deferred,
    checks,
    outcome,
    connections: () => connections,
  }
}

function worktreeState(stage: string, index: string) {
  return {
    worktree: stage,
    head: git(stage, ['rev-parse', 'HEAD']),
    index: git(stage, ['ls-files', '--stage', '-z']),
    tree: git(stage, ['write-tree']),
    indexSha256: createHash('sha256')
      .update(fs.readFileSync(index))
      .digest('hex'),
    bytes: fs.readFileSync(join(stage, 'allowed/edit'), 'utf8'),
  }
}
