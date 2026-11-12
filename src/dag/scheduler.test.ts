import { expect, test } from 'bun:test'
import { ExecutionCapacity, readyFrontier } from './scheduler.js'
import type { AssignmentState, IntegrationCycle } from './state.js'

type Stages = Record<string, Pick<AssignmentState, 'stage'>>

function barrier() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, resolve }
}

test('ready frontier obeys capacity', async () => {
  const nodes = {
    consumer: { needs: ['a'] },
    b: { needs: [] },
    a: { needs: [] },
  }
  const states: Stages = {}
  const capacity = new ExecutionCapacity(2)
  const aStarted = barrier()
  const bStarted = barrier()
  const consumerStarted = barrier()
  const acceptA = barrier()
  const releaseB = barrier()
  const events: unknown[] = []
  let maximum = 0
  const record = (event: string) => {
    maximum = Math.max(maximum, capacity.active)
    events.push({
      event,
      active: capacity.active,
      pending: capacity.pending,
      states: structuredClone(states),
    })
  }
  const execute = (id: string, body: () => Promise<void>) => {
    states[id] = { stage: 'running' }
    return capacity.run(async () => {
      record(`start:${id}`)
      await body()
      states[id] = { stage: 'accepted' }
      record(`accepted:${id}`)
    })
  }
  expect(readyFrontier(nodes, states).ready).toEqual(['a', 'b'])
  const a = execute('a', async () => {
    aStarted.resolve()
    await acceptA.promise
  })
  const b = execute('b', async () => {
    bStarted.resolve()
    await releaseB.promise
  })
  let consumer: Promise<void> | undefined
  try {
    await Promise.all([aStarted.promise, bStarted.promise])
    expect(capacity.active).toBe(2)
    expect(readyFrontier(nodes, states).ready).toEqual([])
    acceptA.resolve()
    await a
    expect(readyFrontier(nodes, states).ready).toEqual(['consumer'])
    consumer = execute('consumer', () => {
      expect(states['a']?.stage).toBe('accepted')
      expect(states['b']?.stage).toBe('running')
      consumerStarted.resolve()
      return Promise.resolve()
    })
    await consumerStarted.promise
    await consumer
    expect(maximum).toBe(2)
  } finally {
    acceptA.resolve()
    releaseB.resolve()
    await Promise.all([a, b, consumer])
  }
  expect(capacity.active).toBe(0)
  expect(states).toEqual({
    a: { stage: 'accepted' },
    b: { stage: 'accepted' },
    consumer: { stage: 'accepted' },
  })
  process.stdout.write(
    `${JSON.stringify({
      scenario: 'ready frontier obeys capacity',
      maximum,
      events,
      final: states,
    })}\n`,
  )
})

test('unaccepted prerequisite and held cycle', async () => {
  const nodes = {
    grandchild: { needs: ['consumer'] },
    consumer: { needs: ['producer'] },
    independent: { needs: [] },
    producer: { needs: [] },
  }
  const states: Stages = { producer: { stage: 'claimed' } }
  const claimed = readyFrontier(nodes, states)
  expect(claimed).toEqual({ ready: ['independent'], blocked: {} })
  states['producer'] = { stage: 'checking' }
  expect(readyFrontier(nodes, states)).toEqual(claimed)
  states['producer'] = { stage: 'failed' }
  const failed = readyFrontier(nodes, states)
  expect(failed).toEqual({
    ready: ['independent'],
    blocked: { consumer: ['producer'], grandchild: ['consumer'] },
  })
  states['producer'] = { stage: 'blocked' }
  expect(readyFrontier(nodes, states)).toEqual(failed)

  const capacity = new ExecutionCapacity(1)
  const cycle: IntegrationCycle = {
    dagId: 'owner',
    stage: 'repair',
    revision: 'accepted-review-input',
    reviewInputs: {},
  }
  const started = barrier()
  const release = barrier()
  const events: unknown[] = []
  const first = capacity.run(async () => {
    events.push({ event: 'independent-start', active: capacity.active, cycle })
    started.resolve()
    await release.promise
    throw new Error('acceptance check failed despite success output')
  })
  // Observe rejection immediately, before triggering it.
  const failure = first.then(
    () => undefined,
    (error: unknown) => error,
  )
  await started.promise
  const repair = capacity.run(() => {
    events.push({ event: 'repair-start', active: capacity.active, cycle })
    expect(cycle.dagId).toBe('owner')
    return Promise.resolve('repair accepted')
  })
  const review = capacity.run(() => {
    events.push({ event: 'review-start', active: capacity.active, cycle })
    return Promise.resolve('approved')
  })
  try {
    expect(capacity.active).toBe(1)
    expect(capacity.pending).toBe(2)
  } finally {
    release.resolve()
  }
  expect(await failure).toEqual(
    new Error('acceptance check failed despite success output'),
  )
  expect(await repair).toBe('repair accepted')
  expect(await review).toBe('approved')
  expect(events).toEqual([
    { event: 'independent-start', active: 1, cycle },
    { event: 'repair-start', active: 1, cycle },
    { event: 'review-start', active: 1, cycle },
  ])
  expect(capacity.active).toBe(0)
  expect(capacity.pending).toBe(0)
  process.stdout.write(
    `${JSON.stringify({
      scenario: 'unaccepted prerequisite and held cycle',
      claimed,
      failed,
      events,
      capacity: { active: capacity.active, pending: capacity.pending },
      cycle,
    })}\n`,
  )
})
