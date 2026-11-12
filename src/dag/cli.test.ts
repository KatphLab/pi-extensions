import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as composition from '@dag/composition/composition.js'
import * as compositionRecovery from '@dag/composition/recovery.js'
import type { PlanRunRequest } from '@dag/composition/types.js'
import * as runAmendment from '@dag/run/amendment.js'
import { RunError } from '@dag/run/error.js'
import * as runRecovery from '@dag/run/recovery.js'
import * as run from '@dag/run/run.js'
import type { RunRequest, RunResult } from '@dag/run/types.js'
import { WorkspaceError } from '@dag/workspace/workspace.js'
import * as sdk from '@earendil-works/pi-coding-agent'
import { main } from './cli.js'
import { approve, dagSource, profileSource } from './cli-test-fixture.js'
import type { RunState } from './state.js'

const roots: string[] = []
const signals = ['SIGINT', 'SIGTERM'] as const
let listeners = signals.map((signal) => ({
  signal,
  values: process.listeners(signal),
}))
let cwd = process.cwd()
let exitCode = process.exitCode
let stdout = ''
let stderr = ''
beforeEach(() => {
  cwd = process.cwd()
  exitCode = process.exitCode
  listeners = signals.map((signal) => ({
    signal,
    values: process.listeners(signal),
  }))
  stdout = ''
  stderr = ''
  spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
})
afterEach(() => {
  mock.restore()
  process.chdir(cwd)
  process.exitCode = exitCode
  for (const { signal, values } of listeners)
    for (const listener of process.listeners(signal))
      if (!values.includes(listener)) process.off(signal, listener)
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

const model = {
  id: 'model',
  name: 'CLI unit model',
  provider: 'unit',
  api: 'openai-completions' as const,
  baseUrl: 'http://127.0.0.1:1',
  reasoning: true,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 512,
}
const planSource = JSON.stringify({
  schema: 1,
  kind: 'plan',
  name: 'cli-plan',
  goal: 'Deliver reviewed reports',
  criteria: { proof: 'The reports support the goal' },
  review: { profile: 'large' },
  dags: { report: { file: 'dag.yaml', satisfies: ['proof'] } },
})
function save(runDirectory: string, state: RunState): void {
  fs.writeFileSync(join(runDirectory, 'state.json'), JSON.stringify(state))
}
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'dag-cli-unit-'))
  roots.push(root)
  process.chdir(root)
  const definitionPath = join(root, 'dag.yaml')
  const profilesPath = join(root, 'profiles.yaml')
  fs.writeFileSync(definitionPath, dagSource)
  fs.writeFileSync(profilesPath, profileSource)
  fs.writeFileSync(join(root, 'plan.yaml'), planSource)
  fs.writeFileSync(join(root, 'input.txt'), 'Required author input')
  const runDirectory = join(root, 'run')
  fs.mkdirSync(runDirectory)
  const state: RunState = {
    schema: 1,
    runId: 'saved-run',
    status: 'paused',
    target: {
      root,
      commonDirectory: join(root, '.git'),
      gitDirectory: join(root, '.git'),
      branch: null,
      launchRevision: 'launch',
      expectedRevision: 'launch',
    },
    snapshots: {},
    revisions: [],
    assignments: {},
    repairRounds: {},
    cycle: null,
    needsAuthor: null,
  }
  save(runDirectory, state)
  const runtime: sdk.ModelRuntime = Object.create(sdk.ModelRuntime.prototype)
  const create = spyOn(sdk.ModelRuntime, 'create').mockResolvedValue(runtime)
  const available = spyOn(runtime, 'getAvailable').mockResolvedValue([model])
  spyOn(runtime, 'getPhysicalModel').mockImplementation((provider, id) =>
    provider === model.provider && id === model.id ? model : undefined,
  )
  spyOn(sdk, 'getAgentDir').mockReturnValue(join(root, 'agent'))
  spyOn(sdk.DefaultResourceLoader.prototype, 'reload').mockResolvedValue()
  spyOn(sdk.DefaultResourceLoader.prototype, 'getSkills').mockReturnValue({
    skills: [],
    diagnostics: [],
  })
  spyOn(sdk.DefaultResourceLoader.prototype, 'getAgentsFiles').mockReturnValue({
    agentsFiles: [],
  })
  return {
    root,
    definitionPath,
    profilesPath,
    runDirectory,
    state,
    create,
    available,
    runtime,
  }
}
function messages(): unknown[] {
  return stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

test.each([
  [['status', 'run', 'extra'], 'exactly the documented operands'],
  [['run', 'dag.yaml'], 'Usage: dag'],
  [['review-dag'], 'exactly the documented operands'],
  [['review'], 'exactly the documented operands'],
  [['review-dag', 'dag.yaml', 'other.yaml'], 'exactly the documented operands'],
  [['unknown', 'run'], 'Usage: dag'],
  [['status', ''], 'Usage: dag'],
  [['status', 'run', '--profiles', 'profiles.yaml'], 'Usage: dag'],
  [['review-dag', 'dag.yaml', '--previous-run', 'old-run'], 'Unknown option'],
  [
    ['run', 'dag.yaml', '--profiles', 'a', '--profiles', 'b'],
    'Options may appear only once',
  ],
  [['status', 'run', '--unknown'], 'Unknown option'],
])('rejects malformed arguments %j before admission', async (argv, message) => {
  expect(await main(argv)).toBe(2)
  expect(stderr).toContain(message)
  expect(stdout).toBe('')
})

test('help explains named workflows without loading credentials', async () => {
  const f = fixture()
  expect(await main(['--help'])).toBe(0)
  expect(stdout).toContain('dag-cli review <file> [--profiles <file>]')
  expect(stdout).toContain('dag-cli review-dag <file> [--profiles <file>]')
  expect(f.create).not.toHaveBeenCalled()
})

test.each([
  ['review', false],
  ['review', true],
  ['review-dag', false],
  ['review-dag', true],
] as const)(
  'bundled %s reaches target admission without an initial receipt (explicit profiles=%s)',
  async (command, explicit) => {
    const f = fixture()
    const execute = spyOn(run, 'runDag')
    const agent = join(f.root, 'agent')
    fs.mkdirSync(agent)
    fs.writeFileSync(
      join(agent, 'dag-profiles.yaml'),
      explicit ? 'invalid default profiles' : profileSource,
    )
    // A project-local file must not shadow the trusted packaged workflow.
    fs.writeFileSync(
      join(f.root, 'review-dag.yaml'),
      'invalid local definition',
    )
    expect(
      await main([
        command,
        'dag.yaml',
        ...(explicit ? ['--profiles', f.profilesPath] : []),
      ]),
    ).toBe(2)
    expect(stderr).toContain('git')
    expect(stderr).not.toContain('.review.json')
    expect(execute.mock.calls[0]?.[0].ownership).toBe('run')
    expect(messages()[0]).toMatchObject({
      runDirectory: expect.stringContaining(
        join(f.root, '.pi/dags/runs/review-dag-'),
      ),
    })
    const context = execute.mock.calls[0]?.[0].definition.context ?? ''
    expect(context).toContain(fs.realpathSync(f.definitionPath))
    expect(context).not.toContain('unit/model:high')
    expect(context).not.toContain('executionBaseline')
    expect(context).not.toContain('historicalUsage')
    expect(context).not.toContain('invalid local definition')
  },
)

test.each([
  ['missing.yaml', 'ENOENT'],
  ['plan.yaml', 'parseDag accepts standalone DAGs'],
])('review-dag rejects %s inputs before execution', async (target, message) => {
  const f = fixture()
  fs.unlinkSync(f.profilesPath)
  expect(await main(['review-dag', target, '--profiles', f.profilesPath])).toBe(
    2,
  )
  expect(stderr).toContain(message)
  expect(f.create).not.toHaveBeenCalled()
  expect(fs.existsSync(join(f.root, '.pi'))).toBe(false)
  expect(stdout).toBe('')
})

test('an explicit bundled definition path still requires initial approval', async () => {
  const f = fixture()
  const definition = fileURLToPath(
    new URL('./builtins/review-dag.yaml', import.meta.url),
  )
  expect(await main(['run', definition, '--profiles', f.profilesPath])).toBe(2)
  expect(stderr).toContain('review-dag.review.json')
  expect(stdout).toBe('')
})

test('status reports the saved checkpoint without authentication or mutation', async () => {
  const f = fixture()
  const frozen = join(f.runDirectory, 'snapshot.json')
  fs.writeFileSync(
    frozen,
    JSON.stringify({
      definition: JSON.stringify({
        limits: { nodeRetries: 2, repairCycles: 1 },
      }),
    }),
  )
  save(f.runDirectory, {
    ...f.state,
    snapshots: { effective: frozen },
    assignments: {
      build: {
        stage: 'interrupted',
        retries: 1,
        attempts: [
          {
            number: 0,
            baseline: 'launch',
            worktree: f.root,
            artifacts: join(f.runDirectory, 'evidence/build/0/artifacts'),
            runner: join(f.runDirectory, 'evidence/build/0/runner'),
            inputs: {},
            receipts: [],
          },
        ],
      },
    },
  })
  const path = join(f.runDirectory, 'state.json')
  const before = fs.readFileSync(path, 'utf8')
  expect(await main(['status', 'run'])).toBe(0)
  expect(messages()).toEqual([
    {
      runId: 'saved-run',
      status: 'paused',
      context: {
        state: path,
        runDirectory: f.runDirectory,
        worktree: f.root,
        candidateRevision: 'launch',
        evidence: join(f.runDirectory, 'evidence'),
        snapshots: { effective: frozen },
      },
      currentTasks: [
        {
          task: 'saved-run/build',
          stage: 'interrupted',
          worktree: f.root,
          retryBudget: { used: 1, limit: 2, remaining: 1 },
        },
      ],
      blocker: null,
      reports: [],
    },
  ])
  expect(await main(['summary', 'run'])).toBe(0)
  expect(messages().at(-1)).toMatchObject({
    timing: { complete: false, activeMs: null, elapsedMs: null },
    usage: { complete: true, execution: { totalTokens: 0 }, approvals: null },
    acceptedReports: [],
  })
  expect(fs.readFileSync(path, 'utf8')).toBe(before)
  expect(f.create).not.toHaveBeenCalled()
  expect(stderr).toBe('')
  fs.writeFileSync(path, '{}')
  expect(await main(['status', 'run'])).toBe(2)
  expect(stderr).toContain('invalid-state')
})

test.each([
  ['dag.yaml', { name: 'cli-unit', nodes: ['build'] }],
  ['plan.yaml', { name: 'cli-plan', dags: ['report'] }],
])(
  'validate %s reports readiness without requiring approval or starting work',
  async (definition, metadata) => {
    const f = fixture()
    const standalone = spyOn(run, 'runDag').mockRejectedValue(
      new Error('Must not run'),
    )
    const plan = spyOn(composition, 'runPlan').mockRejectedValue(
      new Error('Must not run'),
    )
    spyOn(sdk, 'readStoredCredential').mockReturnValue({
      type: 'api_key',
      key: 'secret',
    })
    expect(
      await main(['validate', definition, '--profiles', 'profiles.yaml']),
    ).toBe(0)
    expect(messages()).toEqual([
      {
        valid: true,
        ...metadata,
        stages: ['checks', 'review'],
        readiness: 'configuration-ready',
        models: [
          {
            model: 'unit/model:high',
            catalog: 'listed',
            credentials: 'resolved',
            request: 'not-probed',
          },
        ],
      },
    ])
    expect(standalone).not.toHaveBeenCalled()
    expect(plan).not.toHaveBeenCalled()
    expect(fs.existsSync(join(f.root, '.pi'))).toBe(false)
    const options = f.create.mock.calls[0]?.[0]
    expect(options).toMatchObject({
      allowModelNetwork: false,
      refreshOnCreate: false,
    })
    await expect(options?.credentials?.list()).resolves.toEqual([
      { providerId: 'unit', type: 'api_key' },
    ])
    await expect(
      options?.credentials?.modify('unit', async () => undefined),
    ).rejects.toThrow('Validation cannot refresh credentials')
    await expect(options?.credentials?.delete('unit')).rejects.toThrow(
      'Validation cannot modify credentials',
    )
    expect(stderr).toBe('')
  },
)

test.each(['dag.yaml', 'plan.yaml'])(
  'explicit model probing for %s distinguishes catalog discovery from a successful request',
  async (definition) => {
    const f = fixture()
    const probe = spyOn(f.runtime, 'completeSimple').mockRejectedValue(
      new Error('private provider diagnostic'),
    )
    expect(
      await main([
        'validate',
        definition,
        '--profiles',
        'profiles.yaml',
        '--probe-models',
      ]),
    ).toBe(2)
    expect(stderr).toContain('Model request probe failed for unit/model')
    expect(stderr).not.toContain('private provider diagnostic')
    expect(stdout).toBe('')
    probe.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: 'OK' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 1,
    })
    expect(
      await main([
        'validate',
        definition,
        '--profiles',
        'profiles.yaml',
        '--probe-models',
      ]),
    ).toBe(0)
    expect(messages()).toMatchObject([
      { readiness: 'request-verified', models: [{ request: 'succeeded' }] },
    ])
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe.mock.calls.at(-1)?.[0]).toMatchObject({ id: 'model' })
    expect(probe.mock.calls.at(-1)?.[2]).toMatchObject({ reasoning: 'high' })
    expect(fs.existsSync(join(f.root, '.pi'))).toBe(false)
  },
)

test('summary exposes accepted report locations and external approval usage without executing work', async () => {
  const f = fixture()
  const approval = join(f.root, 'approval.jsonl')
  fs.writeFileSync(
    approval,
    `${JSON.stringify({ type: 'session', id: 'approval' })}\n${JSON.stringify({ type: 'message', id: 'response', message: { role: 'assistant', usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } } })}\n`,
  )
  const child = {
    ...f.state,
    runId: 'saved-run.child',
    assignments: {
      report: {
        stage: 'accepted' as const,
        retries: 0,
        attempts: [
          {
            number: 0,
            baseline: 'launch',
            worktree: f.root,
            artifacts: '/accepted/artifacts',
            runner: '/runner',
            inputs: {},
            receipts: [],
            report: '/accepted/artifacts/outcome.json',
            acceptedRevision: 'accepted',
          },
        ],
      },
    },
  }
  save(f.runDirectory, { ...f.state, status: 'succeeded', children: { child } })
  const before = fs.readFileSync(join(f.runDirectory, 'state.json'), 'utf8')
  expect(
    await main([
      'summary',
      f.runDirectory,
      '--approval-session',
      approval,
      '--approval-session',
      approval,
    ]),
  ).toBe(0)
  expect(messages()).toMatchObject([
    {
      progress: { status: 'succeeded' },
      usage: {
        execution: { requests: 0 },
        approvals: { requests: 1, totalTokens: 5, estimatedCost: 0.5 },
      },
      acceptedReports: [
        {
          assignment: 'saved-run.child/report',
          artifacts: '/accepted/artifacts',
          report: '/accepted/artifacts/outcome.json',
          revision: 'accepted',
        },
      ],
    },
  ])
  expect(await main(['status', f.runDirectory])).toBe(0)
  expect(messages().at(-1)).toMatchObject({
    status: 'succeeded',
    currentTasks: [],
    reports: [
      {
        assignment: 'saved-run.child/report',
        artifacts: '/accepted/artifacts',
        report: '/accepted/artifacts/outcome.json',
        revision: 'accepted',
      },
    ],
  })
  expect(f.create).not.toHaveBeenCalled()
  expect(fs.readFileSync(join(f.runDirectory, 'state.json'), 'utf8')).toBe(
    before,
  )
})

test.each([false, true])(
  'watch follows durable transitions without authenticating or owning execution (compact=%s)',
  async (compact) => {
    const f = fixture()
    const lock = join(f.runDirectory, 'owner.lock')
    fs.writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        nonce: 'owner',
        runDirectory: f.runDirectory,
      }),
    )
    const failurePath = join(f.runDirectory, 'failure.json')
    const diagnostic = JSON.stringify({
      code: 'schema',
      message: `Invalid criterion: ${'x'.repeat(4096)}`,
    })
    fs.writeFileSync(failurePath, diagnostic)
    save(f.runDirectory, { ...f.state, status: 'running' })
    let updates = 0
    spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      updates += 1
      save(f.runDirectory, {
        ...f.state,
        status: updates === 1 ? 'running' : 'needs-author',
        children: {
          review: {
            ...f.state,
            runId: 'saved-run.review',
            assignments: {
              build: {
                stage: 'failed',
                retries: 1,
                attempts: [
                  {
                    number: 0,
                    baseline: 'launch',
                    worktree: f.root,
                    artifacts: f.root,
                    runner: f.runDirectory,
                    inputs: {},
                    receipts: [],
                  },
                ],
              },
            },
          },
        },
      })
      return true
    })
    expect(
      await main(['watch', f.runDirectory, ...(compact ? ['--compact'] : [])]),
    ).toBe(3)
    if (compact) {
      expect(messages()).toMatchObject([
        { status: 'running', changes: { 'saved-run': { status: 'running' } } },
        {
          changes: {
            'saved-run.review/build': { stage: 'failed', failure: failurePath },
          },
        },
        {
          status: 'needs-author',
          changes: { 'saved-run': { status: 'needs-author' } },
        },
      ])
      expect(JSON.stringify(messages().at(-1))).not.toContain(
        'saved-run.review/build',
      )
      expect(stdout).not.toContain('Invalid criterion')
    } else
      expect(messages()).toMatchObject([
        { owner: 'live', progress: { status: 'running' } },
        {
          progress: {
            children: {
              review: {
                assignments: {
                  build: {
                    stage: 'failed',
                    retries: 1,
                    failure: {
                      path: failurePath,
                      diagnostic: diagnostic.slice(0, 2048),
                    },
                  },
                },
              },
            },
          },
        },
        { progress: { status: 'needs-author' } },
      ])
    expect(f.create).not.toHaveBeenCalled()
    expect(fs.existsSync(lock)).toBe(true)
  },
)

test('watch stops on an orphan or observer cancellation without modifying run state', async () => {
  const f = fixture()
  const state = { ...f.state, status: 'running' as const }
  save(f.runDirectory, state)
  expect(await main(['watch', f.runDirectory])).toBe(1)
  expect(messages()).toMatchObject([{ owner: 'absent' }])
  fs.writeFileSync(
    join(f.runDirectory, 'owner.lock'),
    JSON.stringify({
      pid: process.pid,
      nonce: 'owner',
      runDirectory: f.runDirectory,
    }),
  )
  spyOn(process.stdout, 'write').mockImplementation(() => {
    process.emit('SIGINT')
    return true
  })
  expect(await main(['watch', f.runDirectory])).toBe(130)
  expect(
    JSON.parse(fs.readFileSync(join(f.runDirectory, 'state.json'), 'utf8')),
  ).toEqual(state)
  expect(f.create).not.toHaveBeenCalled()
})

test('readiness rejects unavailable exact models and unreadable initial references', async () => {
  const f = fixture()
  f.available.mockResolvedValueOnce([])
  expect(
    await main(['validate', 'dag.yaml', '--profiles', 'profiles.yaml']),
  ).toBe(2)
  expect(stdout).toBe('')
  stderr = ''
  fs.rmSync(join(f.root, 'input.txt'))
  expect(
    await main(['validate', 'dag.yaml', '--profiles', 'profiles.yaml']),
  ).toBe(2)
  expect(stderr).toContain('Required readable file is unavailable')
  expect(stdout).toBe('')
  expect(fs.existsSync(join(f.root, '.pi'))).toBe(false)
})

test.each([
  ['unapproved', 'approved independent large-profile plan review'],
  ['small-reviewer', 'approved independent large-profile plan review'],
  ['unavailable-reviewer', 'Plan reviewer exact model is unavailable'],
  ['stale-document', 'document identity is stale or duplicated'],
  ['duplicate-document', 'document identity is stale or duplicated'],
  ['missing-profiles', 'exact definition and profiles'],
  ['empty-evidence', 'existing nonempty file'],
])('run refuses %s approval before execution', async (kind, message) => {
  const f = fixture()
  const { receipt, path } = approve(f)
  const launch = spyOn(run, 'runDag').mockRejectedValue(
    new Error('Must not run'),
  )
  let review = receipt
  switch (kind) {
    case 'unapproved':
      review = { ...receipt, verdict: 'changes-requested' }
      break
    case 'small-reviewer':
      review = { ...receipt, reviewerProfile: 'small' }
      break
    case 'unavailable-reviewer':
      f.available.mockResolvedValueOnce([model]).mockResolvedValueOnce([])
      break
    case 'stale-document':
      fs.appendFileSync(f.definitionPath, '\n')
      break
    case 'duplicate-document':
      review = {
        ...receipt,
        documents: [...receipt.documents, ...receipt.documents.slice(0, 1)],
      }
      break
    case 'missing-profiles':
      review = { ...receipt, documents: receipt.documents.slice(0, 1) }
      break
    case 'empty-evidence':
      fs.writeFileSync(receipt.evidencePath, '')
      break
  }
  fs.writeFileSync(path, JSON.stringify(review))
  expect(await main(['run', 'dag.yaml', '--profiles', 'profiles.yaml'])).toBe(2)
  expect(stderr).toContain(message)
  expect(stdout).toBe('')
  expect(launch).not.toHaveBeenCalled()
})

test('run admits only the reviewed definition and profiles captured before readiness', async () => {
  const f = fixture()
  const { receipt, path } = approve(f)
  f.available.mockImplementationOnce(() => {
    fs.writeFileSync(
      f.definitionPath,
      dagSource.replace('Produce the report', 'Changed task'),
    )
    fs.writeFileSync(
      f.profilesPath,
      profileSource.replace('unit/model', 'unit/changed'),
    )
    return Promise.resolve([model])
  })
  let admitted: RunRequest | undefined
  spyOn(run, 'runDag').mockImplementation((request) => {
    admitted = request
    return Promise.resolve<RunResult>({
      runDirectory: join(f.root, '.pi/dags/runs', request.runId),
      state: { ...f.state, runId: request.runId, status: 'succeeded' },
    })
  })
  expect(await main(['run', 'dag.yaml', '--profiles', 'profiles.yaml'])).toBe(0)
  expect(admitted?.source[f.definitionPath]).toBe(dagSource)
  expect(admitted?.source[f.profilesPath]).toBe(profileSource)
  expect(admitted?.source[path]).toBe(JSON.stringify(receipt))
  expect(admitted?.assignments.nodes['build']?.node).toMatchObject({
    task: 'Produce the report',
  })
  expect(messages()).toEqual([
    expect.objectContaining({ runId: expect.stringMatching(/^cli-unit-/) }),
    expect.objectContaining({ status: 'succeeded' }),
  ])
  expect(stderr).toBe('')
})

test('plan admission freezes reviewed documents and reports the author-handoff exit', async () => {
  const f = fixture()
  approve(f, 'plan.yaml')
  let admitted: PlanRunRequest | undefined
  spyOn(composition, 'runPlan').mockImplementation((request) => {
    admitted = request
    return Promise.resolve<RunResult>({
      runDirectory: join(f.root, '.pi/dags/runs', request.runId),
      state: {
        ...f.state,
        runId: request.runId,
        status: 'needs-author',
        children: {},
      },
    })
  })
  expect(await main(['run', 'plan.yaml', '--profiles', 'profiles.yaml'])).toBe(
    3,
  )
  expect(
    admitted?.revision.plan.documents[join(f.root, 'plan.yaml')]?.content,
  ).toBe(planSource)
  expect(admitted?.revision.review.receipt.documents).toHaveLength(3)
  expect(messages()).toEqual([
    expect.objectContaining({ runId: expect.stringMatching(/^cli-plan-/) }),
    expect.objectContaining({ status: 'needs-author' }),
  ])
})

test.each([
  ['standalone', 'succeeded', 0],
  ['plan', 'needs-author', 3],
  ['standalone', 'paused', 1],
  ['plan', 'failed', 1],
  ['standalone', 'running', 1],
] as const)(
  'resume %s reports %s with exit %i',
  async (kind, status, expected) => {
    const f = fixture()
    const state = {
      ...f.state,
      status,
      ...(kind === 'plan' ? { children: {} } : {}),
    }
    save(f.runDirectory, state)
    const standalone = spyOn(runRecovery, 'resumeDag').mockRejectedValue(
      new Error('Wrong runner'),
    )
    const plan = spyOn(compositionRecovery, 'resumePlan').mockRejectedValue(
      new Error('Wrong runner'),
    )
    const result = { runDirectory: f.runDirectory, state }
    if (kind === 'plan') plan.mockResolvedValue(result)
    else standalone.mockResolvedValue(result)
    expect(await main(['resume', 'run'])).toBe(expected)
    expect(messages()).toEqual([
      {
        runDirectory: f.runDirectory,
        runId: state.runId,
        status,
        evidence: join(f.runDirectory, 'evidence'),
      },
    ])
    expect(f.create.mock.calls[0]?.[0]).toEqual({
      allowModelNetwork: false,
      refreshOnCreate: false,
    })
    expect(stderr).toBe('')
  },
)

test.each(['standalone', 'plan'])(
  'restart stages %s authorization without interpreting its status as execution',
  async (kind) => {
    const f = fixture()
    const state: RunState = {
      ...f.state,
      status: 'needs-author',
      ...(kind === 'plan' ? { children: {} } : {}),
    }
    save(f.runDirectory, state)
    const standalone = spyOn(runRecovery, 'restartDag').mockRejectedValue(
      new Error('Wrong runner'),
    )
    const plan = spyOn(compositionRecovery, 'restartPlan').mockRejectedValue(
      new Error('Wrong runner'),
    )
    if (kind === 'plan') plan.mockResolvedValue(state)
    else standalone.mockResolvedValue(state)
    expect(
      await main([
        'restart',
        'run',
        'overall-review',
        '--reason',
        'Replace missing resources',
      ]),
    ).toBe(0)
    expect(messages()).toEqual([
      expect.objectContaining({ status: 'needs-author' }),
    ])
    expect(f.create).not.toHaveBeenCalled()
    expect(stderr).toBe('')
  },
)

test.each([
  [
    'material',
    'Required scope change',
    [],
    'Material amendment requires --review',
  ],
  ['minor', 'Wording only', ['--review', 'receipt.json'], 'omit --review'],
  ['minor', '   ', [], 'Amendment reason is required'],
])(
  'amend rejects %s authorization without changing the checkpoint',
  async (classification, reason, review, message) => {
    const f = fixture()
    const before = fs.readFileSync(join(f.runDirectory, 'state.json'), 'utf8')
    expect(
      await main([
        'amend',
        'run',
        'dag.yaml',
        '--classification',
        classification,
        '--reason',
        reason,
        ...review,
      ]),
    ).toBe(2)
    expect(stderr).toContain(message)
    expect(fs.readFileSync(join(f.runDirectory, 'state.json'), 'utf8')).toBe(
      before,
    )
    expect(f.create).not.toHaveBeenCalled()
    expect(stdout).toBe('')
  },
)

test.each(['standalone', 'plan'])(
  'amend admits reviewed %s changes against its frozen profile source',
  async (kind) => {
    const f = fixture()
    const definition = kind === 'plan' ? 'plan.yaml' : 'dag.yaml'
    const profilesPath = join(f.root, 'authored-profiles.yaml')
    fs.writeFileSync(profilesPath, profileSource)
    fs.writeFileSync(f.profilesPath, '{}')
    fs.writeFileSync(
      f.definitionPath,
      dagSource.replace('Produce the report', 'Refine the report'),
    )
    const { path: reviewPath } = approve(
      f,
      definition,
      'authored-profiles.yaml',
    )
    const snapshot = join(f.runDirectory, 'frozen.json')
    fs.writeFileSync(
      snapshot,
      JSON.stringify(
        kind === 'plan'
          ? { plan: { profilesPath } }
          : {
              source: {
                [f.definitionPath]: dagSource,
                [profilesPath]: profileSource,
              },
            },
      ),
    )
    const state: RunState = {
      ...f.state,
      status: 'needs-author',
      snapshots: kind === 'plan' ? { plan: snapshot } : { effective: snapshot },
      ...(kind === 'plan' ? { children: {} } : {}),
    }
    save(f.runDirectory, state)
    const standalone = spyOn(runAmendment, 'amendDag').mockImplementation(
      () => {
        throw new Error('Wrong amendment kind')
      },
    )
    const plan = spyOn(compositionRecovery, 'amendPlan').mockRejectedValue(
      new Error('Wrong amendment kind'),
    )
    if (kind === 'plan') plan.mockResolvedValue(state)
    else standalone.mockReturnValue(state)
    expect(
      await main([
        'amend',
        'run',
        definition,
        '--classification',
        'material',
        '--reason',
        'Reviewed change',
        '--review',
        reviewPath,
      ]),
    ).toBe(0)
    if (kind === 'plan') {
      expect(plan.mock.calls[0]?.[0].plan.profilesPath).toBe(profilesPath)
      expect(
        plan.mock.calls[0]?.[0].plan.documents[f.definitionPath]?.content,
      ).toContain('Refine the report')
    } else {
      expect(standalone.mock.calls[0]?.[0].source[profilesPath]).toBe(
        profileSource,
      )
      expect(
        standalone.mock.calls[0]?.[0].definition.nodes['build'],
      ).toMatchObject({
        task: 'Refine the report',
      })
    }
    expect(messages()).toEqual([
      expect.objectContaining({ status: 'needs-author' }),
    ])
    expect(stderr).toBe('')
  },
)

test.each([
  [new RunError('unsafe-recovery', 'run'), 2],
  [new WorkspaceError('dirty-target', 'target'), 2],
  [Object.assign(new Error('Permission denied'), { code: 'EACCES' }), 2],
  [new Error('Unexpected failure'), 1],
  ['Non-error failure', 1],
])('maps rejected execution %s to exit %i', async (error, expected) => {
  fixture()
  spyOn(runRecovery, 'resumeDag').mockRejectedValue(error)
  expect(await main(['resume', 'run'])).toBe(expected)
  expect(stderr).toBe(`${error instanceof Error ? error.message : error}\n`)
  expect(stdout).toBe('')
})

test.each([
  ['SIGINT', false],
  ['SIGTERM', true],
] as const)(
  '%s overrides execution and error exits and removes its listeners',
  async (signal, fail) => {
    const f = fixture()
    const before = process.listeners(signal)
    spyOn(runRecovery, 'resumeDag').mockImplementation(() => {
      const stop = process
        .listeners(signal)
        .find((listener) => !before.includes(listener))
      expect(stop).toBeDefined()
      stop?.(signal)
      if (fail) return Promise.reject(new Error('Interrupted failure'))
      return Promise.resolve<RunResult>({
        runDirectory: f.runDirectory,
        state: { ...f.state, status: 'succeeded' },
      })
    })
    expect(await main(['resume', 'run'])).toBe(130)
    for (const saved of listeners)
      expect(process.listeners(saved.signal)).toEqual(saved.values)
    expect(stderr).toBe(fail ? 'Interrupted failure\n' : '')
  },
)
