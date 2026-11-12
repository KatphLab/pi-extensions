import { afterEach, expect, spyOn, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArtifactIdentity } from '@dag/command.js'
import { type DagDefinition, DefinitionError } from '@dag/definition/schema.js'
import {
  type AttemptState,
  identifyTarget,
  RunOwner,
  readRunState,
} from '@dag/state.js'
import * as worker from '@dag/worker.js'
import * as workspace from '@dag/workspace/workspace.js'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { automaticStageId } from './context.js'
import { restartDag, resumeDag, stageManagedRestart } from './recovery.js'
import { runDag } from './run.js'
import {
  approved,
  assignments,
  cleanupRunTests,
  directories,
  identity,
  last,
  node,
  reason,
  fixture as runFixture,
  savedCheckpoint,
  text,
  track,
} from './test-fixture.js'

afterEach(cleanupRunTests)
const fixture = runFixture.bind(undefined, spyOn)
test('command consumers and repeated validators resolve accepted nested output names', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'dag-inputs-')))
  directories.push(root)
  for (const args of [
    ['init', '-b', 'fixture'],
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@localhost'],
    ['commit', '--allow-empty', '-m', 'baseline'],
  ]) {
    const result = childProcess.spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  const input = `
    const inputs = await Bun.file(process.env.DAG_INPUTS_FILE).json();
    const source = inputs.find(item => item.assignment === 'maker' && item.path === 'data/value.txt');
    if (!source) throw new Error('Missing declared prerequisite data/value.txt');
    const value = Number(await Bun.file(source.artifact.path).text());
  `
  const definition: DagDefinition = {
    schema: 1,
    kind: 'dag',
    name: 'inputs',
    goal: 'Double the accepted value',
    context:
      'Assess only the generated arithmetic proof; repository implementation is outside scope.',
    criteria: { answer: 'The result is 42' },
    review: { profile: 'large' },
    limits: { concurrency: 1, nodeRetries: 0, repairCycles: 0 },
    verify: [],
    stages: ['checks', 'review'],
    nodes: {
      maker: {
        kind: 'command',
        needs: [],
        references: [],
        write: [],
        satisfies: ['answer'],
        outputs: ['data/value.txt'],
        verify: [],
        argv: [
          process.execPath,
          '-e',
          `await Bun.write(process.env.DAG_EVIDENCE_DIR + '/data/value.txt', '21')`,
        ],
      },
      consumer: {
        kind: 'command',
        needs: ['maker'],
        references: [],
        write: [],
        satisfies: ['answer'],
        outputs: ['proof.txt'],
        argv: [
          process.execPath,
          '-e',
          `${input}
          await Bun.write(process.env.DAG_EVIDENCE_DIR + '/proof.txt', String(value * 2));
        `,
        ],
        verify: [
          {
            id: 'double',
            argv: [
              process.execPath,
              '-e',
              `${input}
          const result = Number(await Bun.file(process.env.DAG_EVIDENCE_DIR + '/proof.txt').text());
          if (result !== value * 2) throw new Error('Incorrect transformed value');
        `,
            ],
          },
        ],
      },
    },
  }
  const reviewer = track(
    spyOn(worker, 'createWorker').mockImplementation(async (options) => ({
      identity: {
        id: 'review',
        path: join(options.sessionsDirectory, 'review.jsonl'),
        cwd: options.cwd,
      },
      prompt: async () => ({
        kind: 'claimed' as const,
        role: 'reviewer' as const,
        report: {
          verdict: 'approved' as const,
          summary: 'The transformed value is correct',
          findings: [],
        },
        reportPath: text(
          join(options.artifacts, 'review.json'),
          JSON.stringify({
            verdict: 'approved',
            summary: 'The transformed value is correct',
            findings: [],
          }),
        ),
      }),
      close: async () => {},
    })),
  )
  const reserved = RunOwner.acquire({
    target: identifyTarget(root),
    runDirectory: join(root, '.pi/dags/runs/other'),
  })
  let result: Awaited<ReturnType<typeof runDag>>
  try {
    result = await runDag({
      ownership: 'run',
      projectRoot: root,
      runId: 'inputs',
      definition,
      assignments: assignments(definition),
      source: { 'dag.yaml': JSON.stringify(definition) },
      runtime: ModelRuntime.prototype,
      signal: AbortSignal.timeout(8000),
    })
  } finally {
    reserved.release()
  }
  expect(result.state.status).toBe('succeeded')
  expect(reviewer.mock.calls[0]?.[0].assignment).toMatchObject({
    context: definition.context,
    goal: definition.goal,
    criteria: definition.criteria,
  })
  expect(result.state.ownership).toBe('run')
  expect(() =>
    RunOwner.acquire({
      target: identifyTarget(root),
      runDirectory: join(root, '.pi/dags/runs/blocked'),
    }),
  ).toThrow('target-reserved')
  expect(
    fs.readFileSync(
      join(last(result.state, 'consumer').artifacts, 'proof.txt'),
      'utf8',
    ),
  ).toBe('42')
  expect(
    fs.readFileSync(
      join(last(result.state, 'maker').artifacts, 'data/value.txt'),
      'utf8',
    ),
  ).toBe('21')
})

test('rejects unadmitted run identities, assignments and automatic-stage profiles before persisting work', async () => {
  const h = fixture({ write: true })
  await expect(
    runDag({ ...h.request, runId: '../escape' }),
  ).rejects.toMatchObject({ code: 'invalid-run' })
  await expect(
    runDag({
      ...h.request,
      assignments: { ...h.request.assignments, nodes: {} },
    }),
  ).rejects.toMatchObject({ code: 'assignment-mismatch' })
  await expect(
    runDag({
      ...h.request,
      assignments: { ...h.request.assignments, integration: undefined },
    }),
  ).rejects.toMatchObject({ code: 'stage-profile' })
  await expect(
    runDag({ ...h.request, ownership: 'run' }),
  ).rejects.toMatchObject({ code: 'read-only-required' })
  expect(fs.existsSync(h.owner.runDirectory)).toBe(false)
  expect(
    automaticStageId(
      { integration: {}, 'automatic.integration': {} },
      'integration',
    ),
  ).toBe('automatic.automatic.integration')
})

test.each([
  {
    phase: 'staged',
    write: true,
    repair: 'integration',
    targetAtFailure: 'launch',
    targetAfterRepair: 'integration-1',
  },
  {
    phase: 'post-apply',
    write: true,
    repair: 'integration',
    targetAtFailure: 'integration-0',
    targetAfterRepair: 'integration-1',
  },
  {
    phase: 'read-only',
    write: false,
    repair: 'maker',
    targetAtFailure: 'launch',
    targetAfterRepair: 'launch',
  },
])(
  'failed $phase checks repair only $repair while preserving accepted evidence and target history',
  async ({ phase, write, repair, targetAtFailure, targetAfterRepair }) => {
    const h = fixture({ write })
    let failed = false
    let originalMaker: AttemptState | undefined
    h.effects.checks = (input) => {
      if (!failed && (phase !== 'post-apply' || input.worktree === h.root)) {
        failed = true
        const saved = readRunState(h.owner.runDirectory)
        expect(saved.target.expectedRevision).toBe(targetAtFailure)
        expect(saved.assignments['maker']?.stage).toBe('accepted')
        originalMaker = last(saved, 'maker')
        throw new Error('Combined proof failed')
      }
      return Promise.resolve([])
    }
    const result = await runDag(h.request)
    expect(result.state.status).toBe('succeeded')
    expect(result.state.cycle).toBeNull()
    expect(result.state.target).toEqual({
      ...h.target,
      expectedRevision: targetAfterRepair,
    })
    expect(result.state.assignments['maker']).toMatchObject({
      stage: 'accepted',
      retries: Number(!write),
    })
    expect(result.state.assignments['maker']?.attempts).toHaveLength(
      write ? 1 : 2,
    )
    expect(result.state.assignments['maker']?.attempts[0]).toEqual(
      originalMaker,
    )
    expect(result.state.assignments[repair]).toMatchObject({
      stage: 'accepted',
      retries: 1,
    })
    expect(result.state.assignments[repair]?.attempts).toHaveLength(2)
    expect(last(result.state, repair).baseline).toBe(targetAtFailure)
    if (phase === 'staged') {
      expect(last(result.state, 'integration').inputs).toEqual({
        contribution: 'maker-0',
        handoff: join(
          last(result.state, 'maker').runner,
          'accepted-handoff.md',
        ),
      })
    } else expect(last(result.state, repair).inputs).toEqual({})
    expect(result.state.repairRounds['answer']).toBe(0)
    const reviewInputs = JSON.parse(
      fs.readFileSync(
        last(result.state, 'review').inputs['path'] ?? '',
        'utf8',
      ),
    )
    expect(reviewInputs).toMatchObject({
      goal: h.request.definition.goal,
      criteria: h.request.definition.criteria,
      revision: targetAfterRepair,
    })
    expect(
      reviewInputs.artifacts.map((value: ArtifactIdentity) => value.path),
    ).toContain(join(last(result.state, 'maker').artifacts, 'proof.txt'))
    expect(readRunState(result.runDirectory)).toEqual(result.state)
  },
)

test('an uncertain acceptance check requires explicit authorization and resumes the pinned candidate without a new worker attempt', async () => {
  const h = fixture()
  const accept = h.effects.accept
  let first = true
  h.effects.accept = (input) => {
    if (first) {
      first = false
      const candidate = identity(
        text(join(input.runner, 'candidate.json'), 'Pinned candidate'),
      )
      input.durable?.write({ ...input.durable.read(), candidate, started: [0] })
      throw new workspace.WorkspaceError('uncertain-check', input.runner)
    }
    input.durable?.repeat(0)
    return accept(input)
  }
  const reserved = RunOwner.acquire({
    target: h.target,
    runDirectory: join(h.root, '.pi/dags/runs/other'),
  })
  reserved.release()
  const paused = await runDag({ ...h.request, ownership: 'run' })
  expect(paused.state.status).toBe('paused')
  expect(paused.state.ownership).toBe('run')
  expect(paused.state.assignments['maker']).toMatchObject({
    stage: 'interrupted',
    retries: 0,
  })
  const before = last(paused.state, 'maker')
  const report = fs.readFileSync(before.report ?? '', 'utf8')
  const staged = await restartDag({
    runDirectory: paused.runDirectory,
    assignment: 'maker',
    reason: 'Repeat the inspected uncertain proof check',
  })
  expect(staged.status).toBe('paused')
  expect(staged.assignments).toEqual(paused.state.assignments)
  expect(staged.restarts?.[0]).toMatchObject({
    assignment: 'maker',
    attempt: 0,
    effect: 'repeat-command',
    previousWorktree: before.worktree,
  })
  await expect(
    stageManagedRestart(
      staged,
      h.request.definition,
      'maker',
      'Already staged',
    ),
  ).rejects.toMatchObject({ code: 'restart-already-staged' })
  h.effects.produce = (options) => {
    if (options.role === 'worker')
      throw new Error('The pinned candidate must not be reproduced')
    return Promise.resolve({
      kind: 'claimed',
      role: 'reviewer',
      report: approved,
      reportPath: text(
        join(options.artifacts, 'review.json'),
        JSON.stringify(approved),
      ),
    })
  }
  const resumed = await resumeDag({
    runDirectory: paused.runDirectory,
    runtime: h.request.runtime,
    signal: new AbortController().signal,
  })
  expect(resumed.state.status).toBe('succeeded')
  expect(resumed.state.ownership).toBe('run')
  expect(resumed.state.assignments['maker']?.attempts).toHaveLength(1)
  expect(resumed.state.assignments['maker']?.retries).toBe(0)
  expect(last(resumed.state, 'maker')).toMatchObject({
    worktree: before.worktree,
    sessionId: before.sessionId,
    sessionPath: before.sessionPath,
    report: before.report,
  })
  expect(fs.readFileSync(before.report ?? '', 'utf8')).toBe(report)
  expect(resumed.state.restarts?.[0]?.consumedAt).toBeString()
  expect(
    savedCheckpoint(resumed.state).acceptances?.['maker']?.progress.repeat['0'],
  ).toBeDefined()
})

test('failed producer retries exhaust locally, block unadmitted consumers, and preserve the independent accepted branch', async () => {
  const h = fixture({
    nodes: { maker: node(), consumer: node(['maker']), independent: node() },
    limits: { nodeRetries: 1 },
  })
  const prompts: string[] = []
  h.effects.produce = (options, _signal, prompt) => {
    if (options.assignment.id === 'maker') {
      prompts.push(prompt ?? '')
      throw new DefinitionError(
        'schema',
        '/evidence/0/criterion',
        `Criterion must be an identifier: ${'x'.repeat(4096)}`,
      )
    }
    return Promise.resolve(h.claim(options))
  }
  const result = await h.managed().executeWorkers()
  expect(result.state.status).toBe('needs-author')
  expect(reason(result.state)).toBe('unaccepted-prerequisites')
  expect(result.state.assignments['maker']).toMatchObject({
    stage: 'failed',
    retries: 1,
  })
  expect(result.state.assignments['maker']?.attempts).toHaveLength(2)
  expect(JSON.parse(prompts[0] ?? '{}')).not.toHaveProperty('assignment')
  expect(prompts[1]).toContain('Criterion must be an identifier')
  expect(prompts[1]).toContain('/evidence/0/criterion')
  expect(prompts[1]).toContain('schema')
  expect(prompts[1]).toContain('failure.json')
  expect(prompts[1]).not.toContain('x'.repeat(2049))
  expect(
    fs.readFileSync(
      join(last(result.state, 'maker').runner, 'failure.json'),
      'utf8',
    ),
  ).toContain('x'.repeat(4096))
  expect(result.state.assignments['consumer']).toEqual({
    stage: 'blocked',
    retries: 0,
    attempts: [],
  })
  expect(result.state.assignments['independent']).toMatchObject({
    stage: 'accepted',
    retries: 0,
  })
  expect(
    savedCheckpoint(result.state).contributions.map((value) => value.revision),
  ).toEqual(['independent-0'])
  expect(result.state.cycle).toBeNull()
})

test('changed frozen context is rejected after worker production before runner acceptance', async () => {
  const h = fixture({ limits: { nodeRetries: 0 } })
  const path = text(
    join(h.root, 'frozen-context.txt'),
    '# Mandatory\nAgreed scope',
  )
  const definition: DagDefinition = {
    ...h.request.definition,
    nodes: {
      maker: {
        ...node(),
        contextIndex: {
          contract: {
            path,
            sha256: identity(path).sha256,
            sections: ['Mandatory'],
          },
        },
        requiredContext: ['contract'],
      },
    },
  }
  h.effects.produce = (options) => {
    const claim = h.claim(options)
    fs.appendFileSync(path, '\nChanged after production')
    return Promise.resolve(claim)
  }
  h.effects.accept = () => {
    throw new Error('Changed frozen context must never reach acceptance')
  }
  const result = await h
    .managed(undefined, undefined, {
      ...h.request,
      definition,
      assignments: assignments(definition),
    })
    .executeWorkers()
  expect(result.state.status).toBe('needs-author')
  expect(result.state.assignments['maker']).toMatchObject({
    stage: 'failed',
    retries: 0,
  })
  expect(result.state.assignments['maker']?.attempts).toHaveLength(1)
  expect(savedCheckpoint(result.state).contributions).toEqual([])
  expect(
    fs.readFileSync(
      join(last(result.state, 'maker').runner, 'failure.json'),
      'utf8',
    ),
  ).toContain('Frozen context contract changed')
})
