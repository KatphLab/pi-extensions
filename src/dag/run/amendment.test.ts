import { afterEach, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import * as command from '@dag/command.js'
import type { DagNode } from '@dag/definition/schema.js'
import { readRunState } from '@dag/state.js'
import type * as workspaceTypes from '@dag/workspace/types.js'
import { affectedDagNodes, amendDag } from './amendment.js'
import { resumeDag } from './recovery.js'
import {
  approved,
  assignments,
  cleanupRunTests,
  completed,
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

function authorityEscalation(kind: 'agent' | 'command') {
  const sibling: DagNode =
    kind === 'agent'
      ? node(['reducer'])
      : {
          kind: 'command',
          argv: ['unit-command'],
          needs: ['reducer'],
          references: [],
          write: [],
          satisfies: ['answer'],
          outputs: ['proof.txt'],
          verify: [],
        }
  const h = fixture({
    nodes: {
      accepted: {
        ...node(),
        outputs: ['proof.txt', 'data.json'],
      },
      maker: node(['reducer']),
      reducer: {
        ...node(['accepted']),
        outputs: ['joined.json'],
      },
      sibling,
    },
    limits: { nodeRetries: 1 },
  })
  const produce = h.effects.produce
  const accept = h.effects.accept
  h.effects.accept = async (input) => {
    const result = await accept(input)
    return {
      ...result,
      artifacts: input.outputs.map((path) =>
        identity(join(input.artifacts, path)),
      ),
    }
  }
  const started = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  const waitForCancellation = (signal?: AbortSignal) => {
    signal?.addEventListener('abort', () => cancelled.resolve(), {
      once: true,
    })
    started.resolve()
    return cancelled.promise
  }
  let siblingPrompts = 0
  const execute = track(
    spyOn(command, 'executeCommand').mockImplementation(async (input) => {
      if (siblingPrompts++ === 0) throw new Error('Retry the existing scope')
      await waitForCancellation(input.signal)
      return {
        identity: input.identity,
        argv: input.argv,
        cwd: input.cwd,
        pid: 1,
        status: 'interrupted',
        exitCode: null,
        signal: 'SIGKILL',
        error: null,
        artifacts: [],
        stdout: text(join(input.runner, 'stdout.log'), ''),
        stderr: text(join(input.runner, 'stderr.log'), ''),
        receipt: text(join(input.runner, 'interrupted.json'), '{}'),
      }
    }),
  )
  h.effects.produce = async (options, signal, prompt) => {
    if (options.assignment.id === 'reducer') {
      const claim = h.claim(options, {
        ...completed,
        deliverables: ['joined.json'],
        evidence: [{ criterion: 'answer', paths: ['joined.json'] }],
      })
      text(join(options.artifacts, 'joined.json'), '{"value":42}')
      return claim
    }
    if (options.assignment.id === 'maker') {
      await started.promise
      return h.claim(options, {
        ...completed,
        findings: [
          {
            summary: 'The author must approve the required contract change',
            evidence: [],
            needsAuthor: true,
          },
        ],
      })
    }
    if (options.assignment.id === 'sibling') {
      if (siblingPrompts++ === 0) throw new Error('Retry the existing scope')
      await waitForCancellation(signal)
      signal?.throwIfAborted()
      throw new Error('Unreachable after cancellation')
    }
    const claim = await produce(options, signal, prompt)
    if (options.assignment.id === 'accepted')
      text(join(options.artifacts, 'data.json'), '{"value":42}')
    return claim
  }
  return { h, produce, execute }
}
test.each(['agent', 'command'] as const)(
  'worker authority escalation interrupts active %s siblings without replaying accepted work after amendment',
  async (kind) => {
    const { h, produce, execute } = authorityEscalation(kind)
    const paused = await h.managed().executeWorkers()
    expect(paused.state.status).toBe('needs-author')
    expect(reason(paused.state)).toBe('worker-new-scope')
    expect(paused.state.assignments['maker']).toMatchObject({
      stage: 'claimed',
      retries: 0,
    })
    expect(paused.state.assignments['accepted']).toMatchObject({
      stage: 'accepted',
      retries: 0,
    })
    expect(paused.state.assignments['reducer']).toMatchObject({
      stage: 'accepted',
      retries: 0,
    })
    const joined = identity(
      join(last(paused.state, 'reducer').artifacts, 'joined.json'),
    )
    const source = identity(
      join(last(paused.state, 'accepted').artifacts, 'data.json'),
    )
    expect(paused.state.assignments['sibling']).toMatchObject({
      stage: 'interrupted',
      retries: 1,
    })
    expect(paused.state.assignments['sibling']?.attempts).toHaveLength(2)
    const interrupted = last(paused.state, 'sibling')
    expect(savedCheckpoint(paused.state).contributions).toHaveLength(2)
    const definition = {
      ...h.request.definition,
      limits: { ...h.request.definition.limits, concurrency: 3 },
      nodes: {
        ...h.request.definition.nodes,
        maker: {
          ...node(['reducer']),
          task: 'Deliver the author-approved answer',
        },
      },
    }
    const previews: unknown[] = []
    const staged = amendDag({
      runDirectory: paused.runDirectory,
      definition,
      assignments: assignments(definition),
      source: h.request.source,
      classification: 'material',
      reason: 'Approve the existing assignment contract',
      reviewPath: text(join(h.root, 'amendment.review.txt'), 'Approved'),
      onPreview: (preview) => {
        expect(readRunState(paused.runDirectory)).toEqual(paused.state)
        previews.push(preview)
      },
    })
    expect(previews).toEqual([
      {
        affectedTasks: ['maker'],
        budgets: {
          before: { answer: h.request.definition.limits },
          after: { answer: definition.limits },
        },
      },
    ])
    expect(staged.revisionAffectedNodes).toEqual(['maker'])
    expect(staged.assignments).toEqual(paused.state.assignments)
    h.effects.produce = (options, signal, prompt) => {
      if (['accepted', 'reducer'].includes(options.assignment.id))
        throw new Error('Accepted work must not be reproduced')
      return produce(options, signal, prompt)
    }
    const beforeResume = readRunState(paused.runDirectory)
    const resumed = resumeDag({
      runDirectory: paused.runDirectory,
      runtime: h.request.runtime,
      signal: new AbortController().signal,
    })
    if (kind === 'command') {
      await expect(resumed).rejects.toMatchObject({
        code: 'uncertain-command-requires-restart',
      })
      expect(execute).toHaveBeenCalledTimes(2)
      expect(readRunState(paused.runDirectory)).toEqual(beforeResume)
      return
    }
    const result = await resumed
    expect(result.state.status).toBe('succeeded')
    expect(result.state.assignments['accepted']).toEqual(
      paused.state.assignments['accepted'],
    )
    expect(result.state.assignments['reducer']).toEqual(
      paused.state.assignments['reducer'],
    )
    expect(identity(joined.path)).toEqual(joined)
    expect(identity(source.path)).toEqual(source)
    expect(result.state.assignments['sibling']).toMatchObject({
      stage: 'accepted',
      retries: 1,
    })
    expect(result.state.assignments['sibling']?.attempts).toHaveLength(2)
    expect(last(result.state, 'sibling')).toMatchObject({
      number: interrupted.number,
      baseline: interrupted.baseline,
      worktree: interrupted.worktree,
      sessionId: interrupted.sessionId,
      sessionPath: interrupted.sessionPath,
    })
    expect(result.state.assignments['maker']).toMatchObject({
      stage: 'accepted',
      retries: 1,
    })
    expect(result.state.repairRounds).toEqual(paused.state.repairRounds)
  },
)
test('an upstream contract amendment invalidates its authored closure but retains sibling identities and spent budgets', async () => {
  const h = fixture({
    nodes: {
      grandchild: node(['consumer']),
      consumer: node(['maker']),
      maker: node(),
      sibling: node(),
    },
  })
  const previous = {
    definition: h.request.definition,
    assignments: h.request.assignments,
  }
  const changedNode = { ...node(), task: 'Deliver the amended answer contract' }
  const definition = {
    ...h.request.definition,
    nodes: { ...h.request.definition.nodes, maker: changedNode },
  }
  const next = { definition, assignments: assignments(definition) }
  const affected = affectedDagNodes(previous, next)
  expect(new Set(affected)).toEqual(
    new Set(['maker', 'consumer', 'grandchild']),
  )
  expect(affectedDagNodes(previous, next, 'minor')).toEqual([])
  const contributions = Object.keys(definition.nodes).map((id) =>
    h.contribution(id),
  )
  const savedAssignments = Object.fromEntries(
    contributions.map((value) => [
      value.acceptedRef.split('/').at(-2) ?? '',
      h.accepted(value, 1),
    ]),
  )
  const state = h.seed(
    { phase: 'decision', contributions },
    {
      status: 'succeeded',
      assignments: savedAssignments,
      repairRounds: { answer: 2 },
    },
  )
  const run = h.managed(undefined, undefined, { ...h.request, ...next })
  await run.restoreManaged(state, true)
  run.invalidateForUpstream(true, affected)
  expect(run.managedResult.state.status).toBe('running')
  for (const id of affected) {
    const prior = state.assignments[id]
    if (!prior) throw new Error(`Missing ${id} assignment`)
    expect(run.managedResult.state.assignments[id]).toEqual({
      ...prior,
      stage: 'ready',
    })
  }
  expect(run.managedResult.state.assignments['sibling']).toEqual(
    state.assignments['sibling'],
  )
  expect(run.managedResult.state.repairRounds).toEqual(state.repairRounds)
  const checkpoint = savedCheckpoint(run.managedResult.state)
  expect(checkpoint.phase).toBe('worker')
  expect(checkpoint.accepted).toBeUndefined()
  expect(run.managedResult.state.revisions).toHaveLength(2)
})

test('a resource-only minor amendment invalidates the producers whose accepted evidence changed', () => {
  const h = fixture()
  const maker = h.contribution('maker')
  const state = h.seed(
    {
      phase: 'checks',
      accepted: maker,
      contributions: [maker],
      progress: { accepted: maker, route: 'worker', feedback: '' },
    },
    { status: 'paused', assignments: { maker: h.accepted(maker, 1) } },
  )
  const base = assignments(h.request.definition)
  const withContent = (content: string) => ({
    ...base,
    nodes: Object.fromEntries(
      Object.entries(base.nodes).map(([id, item]) => [
        id,
        id === 'maker'
          ? {
              ...item,
              instructions: [{ path: 'skills/example/SKILL.md', content }],
            }
          : item,
      ]),
    ),
  })
  h.owner.write({ ...state, assignments: state.assignments })
  const staged = amendDag({
    runDirectory: h.owner.runDirectory,
    definition: h.request.definition,
    assignments: withContent('refreshed instruction bytes'),
    source: h.request.source,
    classification: 'minor',
    reason: 'Refresh the selected instruction bytes',
  })
  expect(staged.revisionAffected).toBe(true)
  expect(staged.revisionAffectedNodes).toEqual(['maker'])
})

test('a reviewed check-only amendment retains the staged accepted contribution and applies it without reproducing workers', async () => {
  const h = fixture({ write: true })
  const maker = h.contribution('maker')
  const integration = h.contribution('integration')
  const state = h.seed(
    {
      phase: 'staged-checks',
      accepted: integration,
      contributions: [maker, integration],
      progress: { accepted: maker, route: 'worker', feedback: '' },
    },
    {
      assignments: {
        maker: h.accepted(maker, 1),
        integration: h.accepted(integration),
      },
      repairRounds: { answer: 1 },
    },
  )
  const definition = {
    ...h.request.definition,
    verify: [{ id: 'replacement', argv: ['replacement-check'] }],
  }
  const reviewPath = text(
    join(h.root, 'amendment.review.json'),
    'Reviewed check-only amendment',
  )
  const staged = amendDag({
    runDirectory: h.owner.runDirectory,
    definition,
    assignments: h.request.assignments,
    source: h.request.source,
    classification: 'material',
    reason: 'Replace only the DAG proof command',
    reviewPath,
  })
  expect(staged.status).toBe('paused')
  expect(staged.revisionAffectedNodes).toEqual([])
  expect(staged.assignments).toEqual(state.assignments)
  expect(staged.repairRounds).toEqual(state.repairRounds)
  expect(staged.revisionPending).toBe(true)
  h.effects.produce = (options) => {
    if (options.role === 'worker')
      throw new Error('An unchanged accepted assignment must not rerun')
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
  const checkInputs: workspaceTypes.ContributionRequest[] = []
  h.effects.checks = (input) => {
    checkInputs.push(input)
    return Promise.resolve([])
  }
  const resumed = await resumeDag({
    runDirectory: h.owner.runDirectory,
    runtime: h.request.runtime,
    signal: new AbortController().signal,
  })
  expect(resumed.state.status).toBe('succeeded')
  expect(resumed.state.target.expectedRevision).toBe(integration.revision)
  expect(resumed.state.assignments['maker']).toEqual(state.assignments['maker'])
  expect(resumed.state.assignments['integration']).toEqual(
    state.assignments['integration'],
  )
  expect(resumed.state.repairRounds).toEqual(state.repairRounds)
  expect(resumed.state.revisionPending).toBe(false)
  expect(
    checkInputs.every((input) =>
      input.checks.some((check) => check.id === 'dag/replacement'),
    ),
  ).toBe(true)
  expect(checkInputs).toHaveLength(2)
})

test('amendment admission rejects unreviewed material changes and attempted identity removal without mutating the saved run', () => {
  const h = fixture()
  const accepted = h.contribution('maker')
  const state = h.seed(
    { phase: 'worker', contributions: [accepted] },
    {
      assignments: { maker: h.accepted(accepted, 1) },
      repairRounds: { answer: 2 },
    },
  )
  const scope = {
    ...h.request.definition,
    nodes: { maker: { ...node(), write: ['new.ts'] } },
  }
  const base = {
    runDirectory: h.owner.runDirectory,
    assignments: assignments(scope),
    source: h.request.source,
    reason: 'Change the agreed scope',
  }
  expect(() =>
    amendDag({ ...base, definition: scope, classification: 'minor' }),
  ).toThrow('material-amendment')
  expect(() =>
    amendDag({ ...base, definition: scope, classification: 'material' }),
  ).toThrow('review-required')
  expect(() =>
    amendDag({
      ...base,
      definition: { ...scope, nodes: {} },
      classification: 'material',
      reviewPath: 'review.json',
    }),
  ).toThrow('attempted-identity-change')
  expect(readRunState(h.owner.runDirectory)).toEqual(state)
  const runOnly = { ...state, ownership: 'run' as const }
  h.owner.write(runOnly)
  expect(() =>
    amendDag({
      ...base,
      definition: scope,
      classification: 'material',
      reviewPath: 'review.json',
    }),
  ).toThrow('read-only-required')
  expect(readRunState(h.owner.runDirectory)).toEqual(runOnly)
})

test('a staged amendment invalidates a sessionless attempt without demanding its missing session', async () => {
  const h = fixture()
  const maker = h.contribution('maker')
  const accepted = h.accepted(maker, 1)
  h.seed(
    { phase: 'worker', contributions: [maker] },
    { status: 'paused', assignments: { maker: accepted } },
  )
  const saved = readRunState(h.owner.runDirectory)
  const savedAttempt = accepted.attempts.at(-1)
  if (!savedAttempt) throw new Error('missing maker attempt')
  const {
    sessionId: _sessionId,
    sessionPath: _sessionPath,
    ...attempt
  } = savedAttempt
  h.owner.write({
    ...saved,
    status: 'paused',
    revisionPending: true,
    revisionAffected: true,
    revisionAffectedNodes: ['maker'],
    assignments: {
      ...saved.assignments,
      maker: {
        ...accepted,
        attempts: [attempt],
      },
    },
  })
  const resumed = await resumeDag({
    runDirectory: h.owner.runDirectory,
    runtime: h.request.runtime,
    signal: new AbortController().signal,
  })
  expect(resumed.state.status).toBe('succeeded')
  expect(resumed.state.revisionPending).toBe(false)
})
