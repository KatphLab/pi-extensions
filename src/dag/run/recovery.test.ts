import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { ExecutionCapacity } from '@dag/scheduler.js'
import { atomicWrite, readRunState } from '@dag/state.js'
import * as workspaceCapabilities from '@dag/workspace/capabilities.js'
import type * as workspaceTypes from '@dag/workspace/types.js'
import * as workspace from '@dag/workspace/workspace.js'
import { restartDag, resumeDag, stageManagedRestart } from './recovery.js'
import {
  approved,
  blocker,
  cleanupRunTests,
  completed,
  identity,
  last,
  node,
  fixture as runFixture,
  savedCheckpoint,
  text,
  track,
} from './test-fixture.js'

afterEach(cleanupRunTests)
const fixture = runFixture.bind(undefined, spyOn)

test('prerequisite reconciliation holds the consumer until its uncertain check is explicitly restarted, preserving accepted producers', async () => {
  const h = fixture({
    write: true,
    nodes: {
      maker: node([], ['answer.ts']),
      sibling: node([], ['answer.ts']),
      consumer: node(['maker', 'sibling']),
    },
  })
  const maker = h.contribution('maker')
  const sibling = h.contribution('sibling')
  const reconciliation = workspaceCapabilities.acceptedInput(
    h.contribution('prerequisites.consumer', 0, 'merged-parents'),
  )
  const state = h.seed(
    { phase: 'worker', contributions: [maker, sibling] },
    { assignments: { maker: h.accepted(maker), sibling: h.accepted(sibling) } },
  )
  const prepare = h.effects.prepare
  h.effects.prepare = async (input) => {
    const baseline = await prepare(input)
    if (input.identity.assignment !== 'prerequisites.consumer') return baseline
    if (!input.durable?.read()) {
      const progress: workspaceTypes.PrerequisiteProgress = {
        tips: [maker.revision, sibling.revision],
        baseline: maker.revision,
        next: 1,
        phase: 'reconcile',
        merges: [],
        checks: { started: [], observations: {}, repeat: {}, completed: {} },
      }
      input.durable?.write(progress)
      await input.reconcile?.({
        index: 0,
        worktree: h.worktree('prerequisite-merge', 0, maker.revision),
        baseline: maker.revision,
        tips: progress.tips,
        write: ['answer.ts'],
        inputs: baseline.inputs,
        signal: input.signal,
      })
      input.durable?.write({
        ...progress,
        baseline: 'merged-parents',
        next: 2,
        phase: 'checks',
        merges: ['merged-parents'],
        checks: {
          ...progress.checks,
          candidate: identity(
            text(join(input.runner, 'candidate.json'), 'Pinned merged inputs'),
          ),
          started: [0],
        },
      })
    }
    input.durable?.repeat(0)
    const accepted = {
      ...baseline,
      revision: reconciliation.contribution.revision,
      reconciliation,
    }
    atomicWrite(join(input.runner, 'prerequisites.json'), accepted)
    return accepted
  }
  const run = h.managed()
  await run.restoreManaged(state)
  const paused = await run.executeWorkers()
  expect(paused.state.status).toBe('paused')
  expect(paused.state.assignments['consumer']).toBeUndefined()
  const reconciliationId = Object.keys(paused.state.assignments).find((id) =>
    id.startsWith('reconcile.consumer.'),
  )
  if (!reconciliationId) throw new Error('Missing prerequisite reconciler')
  expect(paused.state.assignments[reconciliationId]).toMatchObject({
    stage: 'interrupted',
    retries: 0,
  })
  const staged = await stageManagedRestart(
    paused.state,
    h.request.definition,
    reconciliationId,
    'Repeat the inspected merged prerequisite check',
  )
  expect(staged.restarts?.at(-1)?.effect).toBe('repeat-command')
  h.owner.write(staged)
  h.effects.produce = (options) => {
    if (options.assignment.id.startsWith('reconcile.'))
      throw new Error('The completed reconciler must not run again')
    return Promise.resolve(h.claim(options))
  }
  const resumedRun = h.managed()
  await resumedRun.restoreManaged(staged)
  const resumed = await resumedRun.executeWorkers()
  expect(resumed.state.status).toBe('running')
  for (const id of ['maker', 'sibling'])
    expect(resumed.state.assignments[id]).toEqual(state.assignments[id])
  expect(resumed.state.assignments[reconciliationId]).toMatchObject({
    stage: 'accepted',
    retries: 0,
    attempts: [
      {
        ...last(paused.state, reconciliationId),
        acceptedRevision: reconciliation.contribution.revision,
        receipts: [reconciliation.contribution.receipt],
      },
    ],
  })
  expect(last(resumed.state, 'consumer')).toMatchObject({
    baseline: reconciliation.contribution.revision,
    inputIdentities: { maker: maker.revision, sibling: sibling.revision },
  })
  expect(resumed.state.restarts?.at(-1)?.consumedAt).toBeString()
  expect(
    savedCheckpoint(resumed.state).pendingPreparations?.['consumer'],
  ).toBeUndefined()
})

test('repeated cancellation retains admitted resources and recovers a completed claim without another prompt or retry', async () => {
  const h = fixture()
  let controller = new AbortController()
  h.effects.produce = (_options, signal) => {
    controller.abort()
    signal?.throwIfAborted()
    throw new Error('Unreachable after cancellation')
  }
  const first = await h.managed(controller.signal).executeWorkers()
  expect(first.state.status).toBe('paused')
  const original = last(first.state, 'maker')
  controller = new AbortController()
  h.effects.produce = (options, signal) => {
    h.claim(options)
    text(
      join(options.artifacts, 'handoff.md'),
      'Retained prose.\n'.repeat(4096),
    )
    controller.abort()
    signal?.throwIfAborted()
    throw new Error('Unreachable after cancellation')
  }
  const secondRun = h.managed(controller.signal)
  await secondRun.restoreManaged(first.state)
  const second = await secondRun.executeWorkers()
  expect(second.state.status).toBe('paused')
  expect(last(second.state, 'maker')).toEqual(original)
  expect(second.state.assignments['maker']).toMatchObject({
    stage: 'interrupted',
    retries: 0,
  })
  const report = identity(join(original.artifacts, 'outcome.json'))
  h.effects.produce = () => {
    throw new Error('The completed saved claim must not be prompted again')
  }
  const finalRun = h.managed(new AbortController().signal)
  await finalRun.restoreManaged(second.state)
  const final = await finalRun.executeWorkers()
  expect(final.state.status).toBe('running')
  expect(final.state.assignments['maker']).toMatchObject({
    stage: 'accepted',
    retries: 0,
  })
  expect(final.state.assignments['maker']?.attempts).toHaveLength(1)
  expect(last(final.state, 'maker')).toMatchObject({
    worktree: original.worktree,
    sessionId: original.sessionId,
    sessionPath: original.sessionPath,
    baseline: original.baseline,
  })
  expect(identity(last(final.state, 'maker').report ?? '')).toEqual(report)
  expect(savedCheckpoint(final.state).phase).toBe('integration')
  expect(final.state.target).toEqual(h.target)
})

test('interrupted review reuses its frozen inputs and saved verdict without re-reviewing accepted work', async () => {
  const h = fixture()
  const maker = h.contribution('maker')
  const state = h.seed(
    {
      phase: 'review',
      accepted: maker,
      contributions: [maker],
      progress: { accepted: maker, route: 'worker', feedback: '' },
      receipts: [],
    },
    { assignments: { maker: h.accepted(maker) } },
  )
  const controller = new AbortController()
  h.effects.produce = (options, signal) => {
    text(join(options.artifacts, 'review.json'), JSON.stringify(approved))
    controller.abort()
    signal?.throwIfAborted()
    throw new Error('Unreachable after cancellation')
  }
  const run = h.managed(controller.signal)
  await run.restoreManaged(state)
  const paused = await run.executeCycle()
  expect(paused.state.status).toBe('paused')
  const interrupted = last(paused.state, 'review')
  const inputs = identity(interrupted.inputs['path'] ?? '')
  const verdict = identity(join(interrupted.artifacts, 'review.json'))
  h.effects.produce = () => {
    throw new Error('The saved exact-input verdict must not be prompted again')
  }
  const resumedRun = h.managed()
  await resumedRun.restoreManaged(paused.state)
  const result = await resumedRun.executeCycle()
  expect(result.state.status).toBe('succeeded')
  expect(result.state.assignments['maker']).toEqual(state.assignments['maker'])
  expect(result.state.assignments['review']?.attempts).toHaveLength(1)
  expect(last(result.state, 'review')).toMatchObject({
    number: interrupted.number,
    baseline: interrupted.baseline,
    worktree: interrupted.worktree,
    sessionId: interrupted.sessionId,
    sessionPath: interrupted.sessionPath,
    inputs: interrupted.inputs,
    report: verdict.path,
  })
  expect(identity(inputs.path)).toEqual(inputs)
  expect(identity(verdict.path)).toEqual(verdict)
  expect(result.state.repairRounds).toEqual(state.repairRounds)
})

test('cancellation while apply waits for shared capacity retains accepted work and leaves the target untouched', async () => {
  const h = fixture({ write: true })
  const accepted = h.contribution('integration')
  const state = h.seed({
    phase: 'apply',
    accepted,
    contributions: [accepted],
    progress: { accepted, route: 'worker', feedback: '' },
  })
  const capacity = new ExecutionCapacity(1)
  const held = Promise.withResolvers<void>()
  const admitted = Promise.withResolvers<void>()
  const occupying = capacity.run(async () => {
    admitted.resolve()
    await held.promise
  })
  await admitted.promise
  const queued = Promise.withResolvers<void>()
  const enterCapacity = capacity.run.bind(capacity)
  track(
    spyOn(capacity, 'run').mockImplementation(
      <T>(execute: () => Promise<T>) => {
        const pending = enterCapacity(execute)
        queued.resolve()
        return pending
      },
    ),
  )
  const controller = new AbortController()
  const run = h.managed(controller.signal, capacity)
  await run.restoreManaged(state)
  const pending = run.executeCycle()
  await queued.promise
  expect(capacity.pending).toBe(1)
  controller.abort()
  held.resolve()
  await occupying
  const paused = await pending
  expect(paused.state.status).toBe('paused')
  expect(paused.state.target).toEqual(h.target)
  expect(savedCheckpoint(paused.state)).toMatchObject({
    phase: 'apply',
    accepted,
  })
  expect(workspace.captureTarget(h.root).expectedRevision).toBe('launch')
})

test('resource replacement is staged without execution and resumes the same attempt with fresh evidence, never obsolete reports', async () => {
  const h = fixture()
  const old = h.contribution('maker')
  const previous = h.accepted(old, 1)
  const attempt = previous.attempts[0]
  if (!attempt) throw new Error('Missing interrupted attempt')
  const reportPath = text(
    join(attempt.artifacts, 'outcome.json'),
    JSON.stringify(completed),
  )
  const assignments = {
    maker: {
      ...previous,
      stage: 'interrupted' as const,
      attempts: [
        {
          ...attempt,
          worktree: join(h.root, 'lost-worktree'),
          report: reportPath,
        },
      ],
    },
  }
  const state = h.seed(
    { phase: 'worker' },
    { assignments, repairRounds: { answer: 1 } },
  )
  await expect(
    stageManagedRestart(state, h.request.definition, 'maker', ' '),
  ).rejects.toMatchObject({ code: 'restart-reason-required' })
  await expect(
    stageManagedRestart(
      {
        ...state,
        assignments: { maker: { ...previous, stage: 'interrupted' } },
      },
      h.request.definition,
      'maker',
      'The existing worker can still continue',
    ),
  ).rejects.toMatchObject({ code: 'restart-not-required' })
  const staged = await restartDag({
    runDirectory: h.owner.runDirectory,
    assignment: 'answer/maker',
    reason: 'The inspected worktree was lost',
  })
  expect(staged.status).toBe('paused')
  expect(staged.assignments).toEqual(state.assignments)
  expect(staged.restarts?.[0]).toMatchObject({
    assignment: 'maker',
    attempt: 0,
    effect: 'replace-resources',
    previousWorktree: join(h.root, 'lost-worktree'),
    previousSessionPath: attempt.sessionPath,
  })
  const result = await resumeDag({
    runDirectory: h.owner.runDirectory,
    runtime: h.request.runtime,
    signal: new AbortController().signal,
  })
  expect(result.state.status).toBe('succeeded')
  expect(result.state.assignments['maker']).toMatchObject({
    stage: 'accepted',
    retries: 1,
  })
  expect(result.state.assignments['maker']?.attempts).toHaveLength(1)
  const fresh = last(result.state, 'maker')
  expect(fresh.number).toBe(attempt.number)
  expect(fresh.baseline).toBe(attempt.baseline)
  expect(fresh.worktree).not.toBe(assignments.maker.attempts[0]?.worktree)
  expect(fresh.artifacts).not.toBe(attempt.artifacts)
  expect(fresh.report).toBe(join(fresh.artifacts, 'outcome.json'))
  expect(fresh.sessionId).not.toBe(attempt.sessionId)
  expect(fresh.inputs['executionAssignment']).toBe('maker.restart-1')
  expect(result.state.restarts?.[0]?.consumedAt).toBeString()
  expect(result.state.repairRounds).toEqual(state.repairRounds)
  expect(fs.readFileSync(reportPath, 'utf8')).toBe(JSON.stringify(completed))
})

test.each(['effective', 'recovery', 'evidence'] as const)(
  'resume refuses changed %s bytes before modifying accepted state',
  async (changed) => {
    const h = fixture()
    const accepted = h.contribution('maker')
    const state = h.seed(
      { phase: 'worker', contributions: [accepted] },
      { assignments: { maker: h.accepted(accepted) } },
    )
    const path =
      changed === 'evidence'
        ? accepted.artifacts[0]?.path
        : state.snapshots[changed]
    if (!path) throw new Error('Missing bound evidence')
    fs.appendFileSync(path, '\nchanged')
    await expect(
      resumeDag({
        runDirectory: h.owner.runDirectory,
        runtime: h.request.runtime,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: changed === 'evidence' ? 'changed-evidence' : 'changed-checkpoint',
    })
    expect(readRunState(h.owner.runDirectory)).toEqual(state)
  },
)

test('resume recognizes an already applied accepted revision and verifies it without applying the contribution twice', async () => {
  const h = fixture({ write: true })
  const maker = h.contribution('maker')
  const integration = h.contribution('integration')
  h.seed(
    {
      phase: 'apply',
      accepted: integration,
      contributions: [maker, integration],
      progress: { accepted: maker, route: 'worker', feedback: '' },
    },
    {
      assignments: {
        maker: h.accepted(maker),
        integration: h.accepted(integration),
      },
      cycle: {
        dagId: 'answer',
        stage: 'integration',
        revision: 'launch',
        reviewInputs: {
          intendedRevision: integration.revision,
          intendedTree: integration.tree,
        },
      },
    },
  )
  h.advance(integration.revision)
  h.effects.apply = () => {
    throw new Error('The accepted revision was already applied')
  }
  const resumed = await resumeDag({
    runDirectory: h.owner.runDirectory,
    runtime: h.request.runtime,
    signal: new AbortController().signal,
  })
  expect(resumed.state.status).toBe('succeeded')
  expect(resumed.state.target.expectedRevision).toBe(integration.revision)
  expect(resumed.state.assignments['maker']?.attempts).toHaveLength(1)
  expect(resumed.state.assignments['integration']?.attempts).toHaveLength(1)
  expect(resumed.state.assignments['combined-checks']?.stage).toBe('accepted')
})

test('reviewed handoff resumes pinned checks and is invalidated by integration repair without repeating accepted work', async () => {
  const h = fixture({ write: true })
  const maker = h.contribution('maker')
  const integration = h.contribution('integration')
  const reviewedAttempt = h.accepted(integration)
  const preparation: workspaceTypes.PrerequisiteBaseline = {
    revision: maker.revision,
    inputs: [workspaceCapabilities.acceptedInput(maker)],
    direct: [],
  }
  h.advance(integration.revision)
  const state = h.seed(
    {
      phase: 'decision',
      accepted: integration,
      contributions: [maker, integration],
      verdict: JSON.stringify(approved),
    },
    {
      target: { ...h.target, expectedRevision: integration.revision },
      assignments: {
        maker: h.accepted(maker),
        integration: h.accepted(integration),
        review: reviewedAttempt,
      },
    },
    new Map([
      ['branch', preparation],
      ['final', preparation],
    ]),
  )
  const publish = h.effects.handoff
  h.effects.handoff = (input) => {
    const progress = input.durable?.read()
    if (!progress) throw new Error('Missing durable handoff progress')
    if (!progress.candidate) {
      fs.mkdirSync(
        last(readRunState(h.owner.runDirectory), input.identity.assignment)
          .worktree,
        { recursive: true },
      )
      input.durable?.write({
        ...progress,
        candidate: identity(
          text(join(input.runner, 'candidate.json'), 'Pinned reviewed branch'),
        ),
        started: [0],
      })
      throw new workspace.WorkspaceError('uncertain-check', input.runner)
    }
    input.durable?.repeat(0)
    return publish(input)
  }
  const run = h.managed()
  await run.restoreManaged(state)
  const paused = await run.executeCycle()
  expect(paused.state.status).toBe('paused')
  expect(paused.state.assignments['reviewed-handoff']?.stage).toBe(
    'interrupted',
  )
  const staged = await stageManagedRestart(
    paused.state,
    h.request.definition,
    'reviewed-handoff',
    'Repeat the inspected reviewed-branch proof',
  )
  expect(staged.restarts?.at(-1)?.effect).toBe('repeat-command')
  h.owner.write(staged)
  h.effects.produce = () => {
    throw new Error('Accepted workers and review must not repeat')
  }
  const resumedRun = h.managed()
  await resumedRun.restoreManaged(staged)
  const result = await resumedRun.executeCycle()
  expect(result.state.status).toBe('succeeded')
  expect(result.state.assignments['maker']).toEqual(state.assignments['maker'])
  expect(result.state.assignments['reviewed-handoff']).toMatchObject({
    stage: 'accepted',
    retries: 0,
  })
  expect(last(result.state, 'reviewed-handoff').baseline).toBe(maker.revision)
  const reviewed = savedCheckpoint(result.state).reviewed
  expect(reviewed?.baseline).toBe(maker.revision)
  expect(reviewed?.revision).toBe(
    last(result.state, 'reviewed-handoff').acceptedRevision,
  )
  expect(reviewed?.receipt).not.toBe(integration.receipt)
  expect(result.state.assignments['review']).toEqual(
    state.assignments['review'],
  )
  expect(result.state.assignments['reviewed-handoff']?.attempts).toHaveLength(1)
  expect(last(result.state, 'reviewed-handoff').worktree).toBe(
    last(paused.state, 'reviewed-handoff').worktree,
  )
  expect(result.state.restarts?.at(-1)?.consumedAt).toBeString()
  expect(result.state.cycle).toBeNull()
  await resumedRun.repairFromOverall(blocker('integration'))
  expect(resumedRun.managedResult.state.status).toBe('running')
  expect(resumedRun.managedResult.state.repairRounds['answer']).toBe(1)
  expect(resumedRun.managedResult.state.assignments).toEqual(
    result.state.assignments,
  )
  const repairing = savedCheckpoint(readRunState(h.owner.runDirectory))
  expect(repairing.handoff).toBeUndefined()
  expect(repairing.reviewed).toBeUndefined()
  expect(() => resumedRun.reviewedResult('answer')).toThrow('unreviewed-input')
})
