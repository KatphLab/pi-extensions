import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTiming, runUsage } from './accounting.js'
import type { RunState } from './state.js'

const roots: string[] = []
const state: RunState = {
  schema: 1,
  runId: 'run',
  status: 'succeeded',
  target: {
    root: '/fixture',
    commonDirectory: '/fixture/.git',
    gitDirectory: '/fixture/.git',
    branch: null,
    launchRevision: 'head',
    expectedRevision: 'head',
  },
  snapshots: {},
  revisions: [],
  assignments: {},
  repairRounds: {},
  cycle: null,
  needsAuthor: null,
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dag-accounting-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
const usage = {
  input: 2,
  output: 3,
  cacheRead: 5,
  cacheWrite: 7,
  reasoning: 1,
  totalTokens: 17,
  cost: { total: 0.25 },
}
function session(
  root: string,
  filename: string,
  id: string,
  entries: unknown[],
) {
  const path = join(root, filename)
  writeFileSync(
    path,
    `${[{ type: 'session', id }, ...entries]
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`,
  )
  return path
}
function assignment(path: string, id: string): RunState['assignments'][string] {
  const attempt = {
    number: 0,
    baseline: 'head',
    worktree: '/fixture',
    artifacts: '/artifacts',
    runner: '/runner',
    inputs: {},
    receipts: [],
    sessionPath: path,
    sessionId: id,
  }
  return {
    stage: 'accepted',
    retries: 1,
    attempts: [attempt, { ...attempt, number: 1 }],
  }
}
const assistant = {
  type: 'message',
  id: 'assistant',
  message: { role: 'assistant', usage },
}

test('counts all persisted usage once across retries, archived children and replacement sessions, with separate external approvals', async () => {
  const root = fixture()
  const entries = [
    assistant,
    assistant,
    { type: 'message', id: 'tool', message: { role: 'toolResult', usage } },
    { type: 'compaction', id: 'compact', usage },
    { type: 'branch_summary', id: 'summary', usage },
    { type: 'usage', id: 'warm', kind: 'unknown-kind', usage },
    {
      type: 'message',
      id: 'user',
      message: { role: 'user', content: 'not usage' },
    },
  ]
  const path = session(root, 'worker.jsonl', 'worker', entries)
  const copy = session(root, 'copy.jsonl', 'worker', entries)
  const prior = session(root, 'prior.jsonl', 'prior', [assistant])
  const external = session(root, 'approval.jsonl', 'approval', [assistant])
  const child = {
    ...state,
    runId: 'run.child',
    assignments: { worker: assignment(path, 'worker') },
    restarts: [
      {
        assignment: 'worker',
        attempt: 0,
        effect: 'replace-resources' as const,
        reason: 'missing worktree',
        stagedAt: 'time',
        previousWorktree: '/old',
        previousSessionPath: prior,
        previousSessionId: 'prior',
      },
    ],
  }
  const result = await runUsage(
    {
      ...state,
      children: { child },
      approvals: [{ dagId: 'child', child }],
      assignments: { copy: assignment(copy, 'worker') },
    },
    [external, external],
  )
  expect(result.complete).toBe(true)
  expect(result.execution).toEqual({
    requests: 2,
    input: 12,
    output: 18,
    cacheRead: 30,
    cacheWrite: 42,
    totalTokens: 102,
    estimatedCost: 1.5,
  })
  expect(result.approvals).toMatchObject({
    requests: 1,
    totalTokens: 17,
    estimatedCost: 0.25,
  })
  expect(result.recordedTotal).toMatchObject({
    requests: 3,
    totalTokens: 119,
    estimatedCost: 1.75,
  })
  expect(result.byAssignment['run.child/worker']).toBeDefined()
  expect(result.exclusions).toContain('Readiness probes')
})

test('missing, mismatched or malformed sessions disclose partial accounting rather than claiming zero usage', async () => {
  const root = fixture()
  const valid = session(root, 'partial.jsonl', 'partial', [assistant])
  writeFileSync(
    valid,
    JSON.stringify({ type: 'session', id: 'partial' }) +
      '\n' +
      JSON.stringify(assistant) +
      '\n{',
  )
  const malformed = session(root, 'bad.jsonl', 'bad', [{}])
  const absentUsage = session(root, 'missing-usage.jsonl', 'no-usage', [
    { ...assistant, message: { role: 'assistant' } },
  ])
  const empty = join(root, 'empty.jsonl')
  writeFileSync(empty, '')
  const result = await runUsage({
    ...state,
    assignments: {
      partial: assignment(valid, 'partial'),
      missing: assignment(join(root, 'absent'), 'absent'),
      malformed: assignment(malformed, 'bad'),
      empty: assignment(empty, 'empty'),
      mismatched: assignment(
        session(root, 'identity.jsonl', 'actual', [assistant]),
        'expected',
      ),
      usage: assignment(absentUsage, 'no-usage'),
    },
  })
  expect(result.complete).toBe(false)
  expect(result.execution).toMatchObject({ requests: 1, totalTokens: 17 })
  expect(result.issues).toHaveLength(6)
  expect(result.approvals).toBeNull()
})

test('timing separates active execution from author pauses and never invents legacy or orphan duration', () => {
  const at = (seconds: number) => new Date(seconds * 1000).toISOString()
  const lifecycle = {
    complete: true,
    events: [
      { status: 'running' as const, at: at(0) },
      { status: 'needs-author' as const, at: at(10) },
      { status: 'running' as const, at: at(30) },
      { status: 'succeeded' as const, at: at(50) },
    ],
  }
  expect(runTiming({ ...state, lifecycle }, false, 100_000)).toMatchObject({
    complete: true,
    elapsedMs: 50_000,
    activeMs: 30_000,
    startedAt: at(0),
    finishedAt: at(50),
  })
  const running = {
    ...state,
    status: 'running' as const,
    lifecycle: { ...lifecycle, events: lifecycle.events.slice(0, 3) },
  }
  expect(runTiming(running, true, 40_000)).toMatchObject({
    elapsedMs: 40_000,
    activeMs: 20_000,
    finishedAt: null,
  })
  expect(runTiming(running, false, 40_000)).toMatchObject({
    complete: false,
    activeMs: null,
  })
  expect(runTiming(state, false)).toMatchObject({
    complete: false,
    activeMs: null,
    elapsedMs: null,
  })
  expect(
    runTiming(
      { ...state, lifecycle: { ...lifecycle, complete: false } },
      false,
    ),
  ).toMatchObject({ complete: false, activeMs: null, elapsedMs: null })
})
