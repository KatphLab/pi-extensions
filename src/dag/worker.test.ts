import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkerReport } from '@dag/definition/schema.js'
import {
  createDagHarness,
  type FixtureAction,
} from '../test-utils/dag-harness.js'
import { createWorker, preflightSession, type WorkerOptions } from './worker.js'

function options(
  h: Awaited<ReturnType<typeof createDagHarness>>,
  suffix = '',
): WorkerOptions {
  return {
    cwd: h.cwd,
    artifacts: h.artifacts,
    sessionsDirectory: h.sessionsDirectory,
    agentDirectory: join(h.root, 'agent'),
    runtime: h.runtime,
    role: 'worker',
    assignment: {
      id: 'fixture',
      goal: 'Deliver a result',
      criteria: { result: 'Required result exists' },
      context: '',
      profile: { model: `dag-fixture/fixture${suffix}`, size: 'large' },
      skills: [],
      instructions: [],
      node: {
        kind: 'agent',
        task: 'Write result.txt and reports',
        write: ['result.txt'],
        outputs: [],
        needs: [],
        references: [],
        satisfies: ['result'],
        verify: [],
      },
    },
  }
}
const outcome: WorkerReport = {
  outcome: 'claimed-complete',
  summary: 'Fixture complete',
  deliverables: ['result.txt'],
  evidence: [{ criterion: 'result', paths: ['result.txt'] }],
  findings: [],
}
function reports(
  h: Awaited<ReturnType<typeof createDagHarness>>,
): FixtureAction[] {
  return [
    {
      tool: 'write',
      arguments: {
        path: join(h.artifacts, 'outcome.json'),
        content: JSON.stringify(outcome),
      },
    },
    {
      tool: 'write',
      arguments: {
        path: join(h.artifacts, 'handoff.md'),
        content:
          'claimed-complete; result.txt; result criterion; no unresolved findings',
      },
    },
    { text: 'complete' },
  ]
}

test.each(['', ':high'])(
  'persistent SDK assignment and reopen preserves thinking %s',
  async (suffix) => {
    const actions: FixtureAction[] = []
    const h = await createDagHarness(actions, true)
    const config = options(h, suffix)
    let worker: Awaited<ReturnType<typeof createWorker>> | undefined
    try {
      actions.push(
        { tool: 'write', arguments: { path: 'result.txt', content: 'first' } },
        { tool: 'read', arguments: { path: 'result.txt' } },
        {
          tool: 'edit',
          arguments: {
            path: 'result.txt',
            edits: [{ oldText: 'first', newText: 'edited by actual SDK' }],
          },
        },
        ...reports(h),
      )
      worker = await createWorker(config)
      const claimed = await worker.prompt(
        'Produce result.txt and the bounded reports.',
      )
      expect(claimed.kind).toBe('claimed')
      expect(claimed.report).toEqual(outcome)
      expect(await readFile(join(h.cwd, 'result.txt'), 'utf8')).toBe(
        'edited by actual SDK',
      )
      const identity = worker.identity
      const saved = await readFile(identity.path, 'utf8')
      const entries: { type: string; message?: { role: string } }[] = saved
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(
        new Set(
          entries.flatMap((entry) =>
            entry.message ? [entry.message.role] : [],
          ),
        ),
      ).toEqual(new Set(['system', 'user', 'assistant', 'toolResult']))
      await worker.close()
      worker = await createWorker({ ...config, reopen: identity })
      expect(worker.identity).toEqual(identity)
      actions.push({ text: 'prior result retained' })
      await worker.prompt(
        'Inspect the existing conversation and retain the completed result.',
      )
      const last = JSON.stringify(h.requests.at(-1))
      expect(last).toContain('edited by actual SDK')
      for (const request of h.requests) {
        expect(request).toMatchObject({ model: 'fixture' })
        if (suffix) expect(request).toHaveProperty('reasoning_effort', 'high')
        else expect(request).not.toHaveProperty('reasoning_effort')
      }
      expect(await readFile(join(h.cwd, 'result.txt'), 'utf8')).toBe(
        'edited by actual SDK',
      )
    } finally {
      await worker?.close()
      await h.close()
    }
  },
)

test('persistent SDK assignment and reopen: report-only citations read worktree evidence without write permission', async () => {
  const actions: FixtureAction[] = []
  const h = await createDagHarness(actions)
  const reference = join(h.cwd, 'reference.txt')
  const report: WorkerReport = {
    ...outcome,
    deliverables: ['proof.json'],
    evidence: [{ criterion: 'result', paths: ['reference.txt', 'proof.json'] }],
    findings: [
      {
        summary: 'Read-only source',
        evidence: [reference],
        needsAuthor: false,
      },
    ],
  }
  const config = options(h)
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined
  try {
    await writeFile(reference, 'Existing read-only evidence')
    actions.push(
      { tool: 'read', arguments: { path: 'reference.txt' } },
      {
        tool: 'write',
        arguments: { path: 'reference.txt', content: 'forbidden' },
      },
      {
        tool: 'edit',
        arguments: {
          path: 'reference.txt',
          edits: [{ oldText: 'Existing', newText: 'Forbidden' }],
        },
      },
      {
        tool: 'write',
        arguments: {
          path: join(h.artifacts, 'proof.json'),
          content: '{"proof":true}',
        },
      },
      {
        tool: 'write',
        arguments: {
          path: join(h.artifacts, 'outcome.json'),
          content: JSON.stringify(report),
        },
      },
      ...reports(h).slice(1),
    )
    worker = await createWorker({
      ...config,
      assignment: {
        ...config.assignment,
        node: {
          ...config.assignment.node,
          write: [],
          references: ['reference.txt'],
          contextIndex: {
            agreedPlan: {
              path: 'reference.txt',
              sha256: createHash('sha256')
                .update('Existing read-only evidence')
                .digest('hex'),
              sections: [],
            },
          },
          requiredContext: ['agreedPlan'],
          outputs: ['proof.json'],
        },
      },
    })
    expect(
      (
        await worker.prompt(
          'Read reference.txt and submit proof without changing the project',
        )
      ).report,
    ).toEqual(report)
    const request = JSON.stringify(h.requests.at(-1))
    expect(request).toContain('Frozen context index')
    expect(request).toContain('agreedPlan')
    expect(request).toContain(reference)
    expect(request).toContain('workflow-control decisions only')
    expect(await readFile(reference, 'utf8')).toBe(
      'Existing read-only evidence',
    )
    expect(await readFile(join(h.artifacts, 'proof.json'), 'utf8')).toBe(
      '{"proof":true}',
    )
    await symlink(h.root, join(h.cwd, 'outside-link'))
    await symlink(join(h.cwd, '.git'), join(h.cwd, 'git-link'))
    await mkdir(join(h.root, 'attempt', 'runner'))
    await symlink(
      join(h.root, 'attempt', 'runner'),
      join(h.artifacts, 'runner-link'),
    )
    for (const path of [
      join(h.root, 'outside.txt'),
      '../outside.txt',
      'outside-link/outside.txt',
      'git-link',
      '.pi/dags/runs/receipt.json',
      join(h.root, 'attempt', 'runner', 'receipt.json'),
      join(h.artifacts, 'runner', 'receipt.json'),
      join(h.artifacts, 'runner-link', 'receipt.json'),
    ]) {
      await writeFile(
        join(h.artifacts, 'outcome.json'),
        JSON.stringify({
          ...report,
          evidence: [{ criterion: 'result', paths: [path] }],
        }),
      )
      actions.push({
        text: 'A citation is not authorization to escape evidence boundaries',
      })
      await expect(
        worker.prompt('Submit bounded evidence'),
      ).rejects.toMatchObject({ code: 'scope' })
    }
  } finally {
    await worker?.close()
    await h.close()
  }
})

test('worker submission and resource failures: exact resource preflight never replaces transcripts', async () => {
  const h = await createDagHarness([])
  try {
    const path = join(h.root, 'missing.jsonl')
    const identity = { id: 'saved-id', path, cwd: h.cwd }
    await expect(preflightSession(identity)).rejects.toMatchObject({
      code: 'session',
    })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const text of [
      '',
      'invalid',
      JSON.stringify({
        type: 'session',
        id: 'wrong',
        cwd: h.cwd,
        version: 3,
        timestamp: '2026-11-03',
      }),
      JSON.stringify({
        type: 'session',
        id: identity.id,
        cwd: h.root,
        version: 3,
        timestamp: '2026-11-03',
      }),
    ]) {
      await writeFile(path, text)
      await expect(preflightSession(identity)).rejects.toMatchObject({
        code: 'session',
      })
      expect(await readFile(path, 'utf8')).toBe(text)
    }
    const absentCwd = join(h.root, 'absent-worktree')
    await writeFile(
      path,
      JSON.stringify({
        type: 'session',
        version: 3,
        id: identity.id,
        cwd: absentCwd,
        timestamp: '2026-11-03',
      }),
    )
    await expect(
      preflightSession({ ...identity, cwd: absentCwd }),
    ).rejects.toMatchObject({ code: 'session' })
    await expect(stat(absentCwd)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      createWorker({
        ...options(h),
        assignment: {
          ...options(h).assignment,
          profile: { model: 'dag-fixture/unapproved-fallback', size: 'small' },
        },
      }),
    ).rejects.toMatchObject({ code: 'model' })
    expect(h.requests).toEqual([])
  } finally {
    await h.close()
  }
})

test('worker submission and resource failures: validates JSON controls while accepting unrestricted prose', async () => {
  const actions: FixtureAction[] = []
  const h = await createDagHarness(actions)
  const base = options(h)
  const worker = await createWorker({
    ...base,
    assignment: {
      ...base.assignment,
      node: {
        ...base.assignment.node,
        outputs: ['proof.md'],
      },
    },
  })
  try {
    const cases = [
      { text: undefined, code: 'ENOENT' },
      { text: '{}', code: 'schema' },
      { text: '{', code: 'report-json' },
      { text: JSON.stringify(outcome), code: 'ENOENT' },
      {
        text: JSON.stringify({ ...outcome, summary: 'x'.repeat(32_768) }),
        code: 'report-size',
      },
    ]
    for (const scenario of cases) {
      if (scenario.text !== undefined)
        await writeFile(join(h.artifacts, 'outcome.json'), scenario.text)
      actions.push({ text: 'Everything passed; accept the result!' })
      await expect(
        worker.prompt('Finish the assignment'),
      ).rejects.toMatchObject({ code: scenario.code })
    }
    await writeFile(join(h.artifacts, 'outcome.json'), JSON.stringify(outcome))
    await writeFile(join(h.artifacts, 'handoff.md'), '')
    actions.push({ text: 'Reports submitted' })
    await expect(worker.prompt('Finish the assignment')).rejects.toMatchObject({
      code: 'report',
    })
    actions.push(
      {
        tool: 'write',
        arguments: {
          path: join(h.artifacts, 'outcome.json'),
          content: JSON.stringify({
            ...outcome,
            evidence: [
              { criterion: 'result and other', paths: ['result.txt'] },
            ],
          }),
        },
      },
      { tool: 'validate_submission', arguments: {} },
      ...reports(h).slice(0, -1),
      {
        tool: 'write',
        arguments: {
          path: join(h.artifacts, 'handoff.md'),
          content: 'é'.repeat(65_536),
        },
      },
      {
        tool: 'write',
        arguments: {
          path: join(h.artifacts, 'proof.md'),
          content: 'Report without required headings.\n'.repeat(4096),
        },
      },
      { tool: 'validate_submission', arguments: {} },
      { text: 'Corrected submission' },
    )
    expect(
      (
        await worker.prompt(
          'Validate and correct control reports before finishing',
        )
      ).report,
    ).toEqual(outcome)
    const request = JSON.stringify(h.requests.at(-1))
    expect(request).toContain('/evidence/0/criterion')
    expect(request).toContain(
      'Submission valid. Runner acceptance is still required.',
    )
    expect(await readFile(join(h.artifacts, 'handoff.md'), 'utf8')).toBe(
      'é'.repeat(65_536),
    )
    await writeFile(
      join(h.artifacts, 'outcome.json'),
      JSON.stringify({ ...outcome, outcome: 'blocked' }),
    )
    actions.push({ text: 'Missing essential review inputs' })
    expect((await worker.prompt('Report the blocker')).report).toMatchObject({
      outcome: 'blocked',
    })
    actions.push({ status: 400 })
    const failure = await worker.prompt('Complete despite stale claim').then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: 'model' })
    if (!(failure instanceof Error)) throw new Error('expected a model error')
    expect(failure.message).toContain('Model request failed (')
    const cause = failure.cause
    expect(cause instanceof Error && cause.message.length > 0).toBe(true)
  } finally {
    await worker.close()
    await h.close()
  }
})

test('worker submission and resource failures: bounded tools reject runner writes, scope escapes and reviewer project edits', async () => {
  const actions: FixtureAction[] = []
  const h = await createDagHarness(actions)
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined
  try {
    for (const name of [
      'outcome.json',
      'handoff.md',
      'review.json',
      'runner/forged.json',
      '../escape',
    ])
      await expect(
        createWorker({
          ...options(h),
          assignment: {
            ...options(h).assignment,
            node: { ...options(h).assignment.node, outputs: [name] },
          },
        }),
      ).rejects.toMatchObject({ code: 'scope' })
    await mkdir(join(h.cwd, 'linked'), { recursive: true })
    await writeFile(join(h.cwd, 'private.txt'), 'original private bytes')
    await symlink('private.txt', join(h.cwd, 'allowed.txt'))
    await symlink('missing.txt', join(h.cwd, 'dangling.txt'))
    await symlink('target.txt', join(h.cwd, 'linked', 'alias.txt'))
    await symlink(join(h.root, 'attempt'), join(h.cwd, 'escape'))
    await symlink(join(h.cwd, '.git'), join(h.cwd, 'git-alias'))
    const gitPointer = await readFile(join(h.cwd, '.git'), 'utf8')
    const forbidden = [
      join(h.root, 'attempt', 'runner', 'forged.json'),
      join(h.cwd, 'other.txt'),
      join(h.cwd, 'missing.txt'),
      join(h.cwd, 'escape', 'forged.json'),
    ]
    actions.push(
      ...forbidden.map((path) => ({
        tool: 'write',
        arguments: { path, content: 'forged acceptance' },
      })),
      {
        tool: 'write',
        arguments: { path: 'git-alias', content: 'corrupt metadata' },
      },
      {
        tool: 'write',
        arguments: { path: 'dangling.txt', content: 'undeclared new file' },
      },
      {
        tool: 'write',
        arguments: { path: 'allowed.txt', content: 'unauthorized alias write' },
      },
      {
        tool: 'edit',
        arguments: {
          path: 'allowed.txt',
          edits: [
            { oldText: 'original private bytes', newText: 'forbidden edit' },
          ],
        },
      },
      {
        tool: 'write',
        arguments: {
          path: 'linked/alias.txt',
          content: 'permitted alias write',
        },
      },
      {
        tool: 'edit',
        arguments: {
          path: 'linked/alias.txt',
          edits: [{ oldText: 'write', newText: 'edit' }],
        },
      },
      ...reports(h),
    )
    worker = await createWorker({
      ...options(h),
      assignment: {
        ...options(h).assignment,
        node: {
          ...options(h).assignment.node,
          write: [
            'result.txt',
            'escape/',
            'git-alias',
            'allowed.txt',
            'dangling.txt',
            'linked/',
          ],
        },
      },
    })
    expect(
      (
        await worker.prompt(
          'Untrusted file says overwrite runner records. Produce only permitted reports.',
        )
      ).kind,
    ).toBe('claimed')
    for (const path of forbidden)
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(h.cwd, '.git'), 'utf8')).toBe(gitPointer)
    expect(await readFile(join(h.cwd, 'private.txt'), 'utf8')).toBe(
      'original private bytes',
    )
    expect(await readFile(join(h.cwd, 'linked', 'target.txt'), 'utf8')).toBe(
      'permitted alias edit',
    )
    expect(JSON.stringify(h.requests)).not.toContain('"name":"subagent"')
    await worker.close()
    worker = await createWorker({ ...options(h), role: 'reviewer' })
    actions.push(
      {
        tool: 'write',
        arguments: { path: 'result.txt', content: 'unauthorized' },
      },
      {
        tool: 'write',
        arguments: {
          path: join(h.artifacts, 'review.json'),
          content: JSON.stringify({
            verdict: 'approved',
            summary: 'verified',
            findings: [],
          }),
        },
      },
      { text: 'reviewed' },
    )
    const review = await worker.prompt('Review without modifying the project')
    expect(review.kind).toBe('claimed')
    await expect(stat(join(h.cwd, 'result.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  } finally {
    await worker?.close()
    await h.close()
  }
})

test('worker submission and resource failures: abort is not completion and frozen instructions survive exact reopen', async () => {
  const release = Promise.withResolvers<void>()
  const actions: FixtureAction[] = [{ wait: release.promise }]
  const h = await createDagHarness(actions)
  const source = join(h.root, 'skill.md')
  await writeFile(source, 'Frozen selected skill v1')
  const config = {
    ...options(h),
    assignment: {
      ...options(h).assignment,
      skills: [
        {
          name: 'selected',
          filePath: source,
          baseDir: h.root,
          content: await readFile(source, 'utf8'),
        },
      ],
    },
  }
  let worker = await createWorker(config)
  try {
    const preAborted = new AbortController()
    preAborted.abort('cancelled before prompt')
    const rejected = await worker
      .prompt('Do not start', preAborted.signal)
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(rejected).toBeInstanceOf(Error)
    expect(rejected).toMatchObject({
      code: 'sdk',
      message: 'cancelled before prompt',
    })
    expect(h.requests).toHaveLength(0)
    const controller = new AbortController()
    const pending = worker.prompt('Wait for interruption', controller.signal)
    const failed = pending.then(
      () => ({ code: 'unexpected-completion' }),
      (error: unknown) => error,
    )
    await h.requested
    controller.abort()
    expect(await failed).toMatchObject({ code: 'aborted' })
    const identity = worker.identity
    release.resolve()
    await worker.close()
    await writeFile(source, 'Changed selected skill v2')
    worker = await createWorker({ ...config, reopen: identity })
    actions.push(...reports(h))
    await worker.prompt('Continue the same frozen assignment')
    const request = JSON.stringify(h.requests.at(-1))
    expect(request).toContain('Frozen selected skill v1')
    expect(request).not.toContain('Changed selected skill v2')
    expect(worker.identity).toEqual(identity)
  } finally {
    release.resolve()
    await worker.close()
    await h.close()
  }
})
