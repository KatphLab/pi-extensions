import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { readRunState } from '@dag/state.js'
import type * as workspaceTypes from '@dag/workspace/types.js'
import {
  blocker,
  cleanupRunTests,
  last,
  node,
  reason,
  fixture as runFixture,
  savedCheckpoint,
  text,
} from './test-fixture.js'

afterEach(cleanupRunTests)
const fixture = runFixture.bind(undefined, spyOn)

test('overall and owned review repairs reopen only the producer closure while retaining accepted siblings and spent budgets', async () => {
  const h = fixture({
    nodes: {
      grandchild: node(['consumer']),
      consumer: node(['maker']),
      maker: node(),
      sibling: node(),
    },
  })
  const contributions = Object.keys(h.request.definition.nodes).map((id) =>
    h.contribution(id),
  )
  const savedAssignments = Object.fromEntries(
    contributions.map((value) => [
      value.acceptedRef.split('/').at(-2) ?? '',
      h.accepted(value),
    ]),
  )
  const accepted = contributions.find((value) => value.revision === 'maker-0')
  if (!accepted) throw new Error('Missing maker contribution')
  const state = h.seed(
    { phase: 'decision', accepted, contributions },
    {
      status: 'succeeded',
      assignments: savedAssignments,
      repairRounds: { answer: 1 },
    },
  )
  const run = h.managed()
  await run.restoreManaged(state, true)
  await run.repairFromOverall(blocker())
  const repairing = run.managedResult.state
  expect(repairing.status).toBe('running')
  expect(repairing.repairRounds['answer']).toBe(2)
  for (const id of ['maker', 'consumer', 'grandchild']) {
    expect(repairing.assignments[id]?.stage).toBe('ready')
    expect(repairing.assignments[id]?.attempts).toEqual(
      state.assignments[id]?.attempts,
    )
    expect(repairing.assignments[id]?.retries).toBe(0)
  }
  expect(repairing.assignments['sibling']).toEqual(state.assignments['sibling'])
  const result = await run.executeWorkers()
  expect(result.state.assignments['sibling']).toEqual(
    state.assignments['sibling'],
  )
  for (const id of ['maker', 'consumer', 'grandchild']) {
    expect(result.state.assignments[id]).toMatchObject({
      stage: 'accepted',
      retries: 1,
    })
    expect(result.state.assignments[id]?.attempts).toHaveLength(2)
  }
  expect(last(result.state, 'consumer').inputIdentities).toEqual({
    maker: 'maker-1',
  })
  expect(last(result.state, 'grandchild').inputIdentities).toEqual({
    consumer: 'consumer-1',
  })
  expect(result.state.repairRounds['answer']).toBe(2)
  const produce = h.effects.produce
  let needsRepair = true
  h.effects.produce = (options, signal, prompt) => {
    if (options.role !== 'reviewer' || !needsRepair)
      return produce(options, signal, prompt)
    needsRepair = false
    const report = blocker()
    return Promise.resolve({
      kind: 'claimed',
      role: 'reviewer',
      report,
      reportPath: text(
        join(options.artifacts, 'review.json'),
        JSON.stringify(report),
      ),
    })
  }
  const reviewed = await run.executeCycle()
  expect(reviewed.state.status).toBe('succeeded')
  expect(reviewed.state.repairRounds['answer']).toBe(3)
  expect(reviewed.state.target).toEqual(h.target)
  expect(reviewed.state.assignments['sibling']).toEqual(
    state.assignments['sibling'],
  )
  for (const id of ['maker', 'consumer', 'grandchild']) {
    expect(reviewed.state.assignments[id]).toMatchObject({
      stage: 'accepted',
      retries: 2,
    })
    expect(reviewed.state.assignments[id]?.attempts).toHaveLength(3)
    expect(reviewed.state.assignments[id]?.attempts.slice(0, -1)).toEqual(
      result.state.assignments[id]?.attempts,
    )
  }
  expect(last(reviewed.state, 'consumer').inputIdentities).toEqual({
    maker: 'maker-2',
  })
  expect(last(reviewed.state, 'grandchild').inputIdentities).toEqual({
    consumer: 'consumer-2',
  })
  expect(readRunState(reviewed.runDirectory)).toEqual(reviewed.state)
})

test('integration-only repair retains aggregate preparation and does not spend authored retry budgets', async () => {
  const h = fixture({
    write: true,
    nodes: { branch: node(), maker: node([], ['answer.ts']) },
  })
  const maker = h.contribution('maker')
  const integration = h.contribution('integration')
  const baseline: workspaceTypes.PrerequisiteBaseline = {
    revision: 'maker-0',
    inputs: [],
    direct: [],
  }
  const state = h.seed(
    {
      phase: 'decision',
      accepted: integration,
      contributions: [maker, integration],
    },
    {
      status: 'succeeded',
      assignments: {
        maker: h.accepted(maker, 1),
        integration: h.accepted(integration),
      },
    },
    new Map([
      ['automatic.branch', baseline],
      ['final', baseline],
      ['integration', baseline],
    ]),
  )
  const run = h.managed()
  await run.restoreManaged(state, true)
  await run.repairFromOverall(blocker('integration'))
  expect(run.managedResult.state.status).toBe('running')
  expect(run.managedResult.state.repairRounds['answer']).toBe(1)
  expect(run.managedResult.state.assignments).toEqual(state.assignments)
  expect(savedCheckpoint(run.managedResult.state)).toMatchObject({
    phase: 'integration',
    repairs: {},
    progress: { accepted: integration, route: 'integration' },
    finalPreparation: 'integration',
  })
})

test.each([
  { rounds: 3, retries: 0, expected: 'repair-cycles-exhausted' },
  { rounds: 1, retries: 2, expected: 'node-retries-exhausted' },
])(
  'exhausted repair authorization retains accumulated counters: $expected',
  async ({ rounds, retries, expected }) => {
    const h = fixture()
    const accepted = h.contribution('maker')
    const state = h.seed(
      { phase: 'decision', accepted, contributions: [accepted] },
      {
        status: 'succeeded',
        assignments: { maker: h.accepted(accepted, retries) },
        repairRounds: { answer: rounds },
      },
    )
    const run = h.managed()
    await run.restoreManaged(state, true)
    await run.repairFromOverall(blocker())
    expect(run.managedResult.state.status).toBe('needs-author')
    expect(reason(run.managedResult.state)).toBe(expected)
    expect(run.managedResult.state.repairRounds).toEqual(state.repairRounds)
    expect(run.managedResult.state.assignments).toEqual(state.assignments)
  },
)

test('unagreed reviewer scope requires the author instead of inventing assignments or repairs', async () => {
  const h = fixture()
  const accepted = h.contribution('maker')
  const verdict = blocker('new-assignment')
  const state = h.seed(
    {
      phase: 'decision',
      accepted,
      contributions: [accepted],
      verdict: JSON.stringify(verdict),
    },
    { assignments: { maker: h.accepted(accepted) } },
  )
  const run = h.managed()
  await run.restoreManaged(state)
  const result = await run.executeCycle()
  expect(result.state.status).toBe('needs-author')
  expect(reason(result.state)).toBe('review-new-scope')
  expect(result.state.assignments).toEqual(state.assignments)
  expect(result.state.repairRounds['answer']).toBe(0)
  expect(
    readRunState(h.owner.runDirectory).assignments['new-assignment'],
  ).toBeUndefined()
})

test('a persistently failing global check stops with needs-author instead of repeating the same pass', async () => {
  const h = fixture({ limits: { nodeRetries: 0, repairCycles: 0 } })
  const contributions = Object.keys(h.request.definition.nodes).map((id) =>
    h.contribution(id),
  )
  const first = contributions[0] ?? h.contribution('maker')
  const state = h.seed(
    {
      phase: 'checks',
      accepted: first,
      contributions,
      progress: { accepted: first, route: 'worker', feedback: '' },
    },
    {
      status: 'running',
      assignments: Object.fromEntries(
        contributions.map((value, index) => [
          value.acceptedRef.split('/').at(-2) ?? '',
          h.accepted(value, index === 0 ? 0 : 1),
        ]),
      ),
    },
  )
  let checks = 0
  h.effects.checks = () => {
    checks += 1
    return Promise.reject(new Error('dag-wide check keeps failing'))
  }
  const run = h.managed()
  await run.restoreManaged(state)
  const result = await run.executeCycle()
  expect(result.state.status).toBe('needs-author')
  expect(reason(result.state)).toBe('unrepairable-check-failure')
  expect(checks).toBe(1)
  expect(fs.readFileSync(result.state.needsAuthor ?? '', 'utf8')).toContain(
    'dag-wide check keeps failing',
  )
})
