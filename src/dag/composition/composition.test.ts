import { afterEach, expect, spyOn, test } from 'bun:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as command from '@dag/command.js'
import * as definition from '@dag/definition/plan.js'
import type { PlanRevision, ReviewReport } from '@dag/definition/schema.js'
import { artifactIdentity as identity } from '@dag/files.js'
import * as run from '@dag/run/run.js'
import type { ManagedDag } from '@dag/run/types.js'
import { atomicWrite, type RunState, readRunState } from '@dag/state.js'
import * as worker from '@dag/worker.js'
import * as capabilities from '@dag/workspace/capabilities.js'
import * as workspace from '@dag/workspace/workspace.js'
import {
  DefaultResourceLoader,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { assertOverallVerdict, blockingEntry, runPlan } from './composition.js'
import {
  approved,
  createFixture,
  type Fixture,
  managedChild,
  savedChild,
  state,
} from './fixtures.js'
import { amendPlan, restartPlan, resumePlan } from './recovery.js'

const roots: string[] = []
const restores: (() => void)[] = []
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore()
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
function restoreAfter(spy: { mockRestore(): void }): void {
  restores.push(() => spy.mockRestore())
}
function json(path: string) {
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}
function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, release: resolve }
}
const runtime: ModelRuntime = Object.create(ModelRuntime.prototype)
const resources: ResourceLoader = Object.create(DefaultResourceLoader.prototype)

function fixture(needs: Readonly<Record<string, readonly string[]>>) {
  const f = createFixture(needs, runtime)
  const { root, target } = f
  roots.push(root)
  restoreAfter(spyOn(workspace, 'captureTarget').mockReturnValue(target))
  restoreAfter(spyOn(workspace, 'assertTarget').mockImplementation(() => {}))
  restoreAfter(
    spyOn(workspace, 'authorizeTarget').mockImplementation(() => () => {}),
  )
  restoreAfter(
    spyOn(workspace, 'prepareWorktree').mockImplementation(
      (_target, options) => {
        const path = join(root, 'worktrees', options.assignment)
        fs.mkdirSync(path, { recursive: true })
        return path
      },
    ),
  )
  restoreAfter(
    spyOn(capabilities, 'acceptedInput').mockImplementation((contribution) => ({
      contribution,
      evidence: contribution.artifacts,
    })),
  )
  return f
}
type Bindings = Parameters<typeof run.managedDag>[2]
function children(
  f: Fixture,
  configure: (
    id: string,
    child: ManagedDag,
    bindings: Bindings,
  ) => void = () => {},
) {
  const admitted = new Map<string, Bindings>()
  restoreAfter(
    spyOn(run, 'managedDag').mockImplementation((request, owner, bindings) => {
      const id = request.runId.slice(f.request.runId.length + 1)
      const child = managedChild(f, id, owner, request)
      admitted.set(id, bindings)
      configure(id, child, bindings)
      return child
    }),
  )
  return admitted
}
function reviewer(
  respond: (
    options: worker.WorkerOptions,
    input: { inputIdentity: command.ArtifactIdentity },
  ) => ReviewReport = () => approved,
) {
  const opened: worker.WorkerOptions[] = []
  restoreAfter(
    spyOn(worker, 'preflightSession').mockResolvedValue(
      Object.create(SessionManager.prototype),
    ),
  )
  restoreAfter(
    spyOn(worker, 'createWorker').mockImplementation((options) => {
      opened.push(options)
      return Promise.resolve<worker.WorkerHandle>({
        identity: options.reopen ?? {
          id: 'overall-session',
          path: join(options.sessionsDirectory, 'overall.jsonl'),
          cwd: options.cwd,
        },
        prompt(text) {
          const report = respond(options, JSON.parse(text))
          const reportPath = join(options.artifacts, 'review.json')
          atomicWrite(reportPath, report)
          return Promise.resolve({
            kind: 'claimed',
            role: 'reviewer',
            report,
            reportPath,
          })
        },
        close: () => Promise.resolve(),
      })
    }),
  )
  return opened
}
function paused(f: Fixture, updates: Partial<RunState> = {}): RunState {
  fs.mkdirSync(f.runDirectory, { recursive: true })
  const path = join(f.runDirectory, 'plan-snapshot.json')
  atomicWrite(path, f.revision)
  const saved: RunState = {
    ...state(f),
    status: 'paused',
    snapshots: { plan: path, planSha256: identity(path).sha256 },
    revisions: [
      {
        identity: f.revision.id,
        sha256: identity(path).sha256,
        source: path,
        expanded: path,
        reason: 'initial admitted plan',
        review: f.revision.review.receipt.evidencePath,
      },
    ],
    children: {},
    ...updates,
  }
  atomicWrite(join(f.runDirectory, 'state.json'), saved)
  return saved
}
function reviewedState(f: Fixture): RunState {
  const saved = Object.fromEntries(
    Object.keys(f.revision.plan.dags)
      .sort((a, b) => a.localeCompare(b))
      .map((id) => [id, savedChild(f, id)]),
  )
  return paused(f, {
    children: saved,
    approved: Object.keys(saved),
    approvals: Object.entries(saved).map(([dagId, child]) => ({
      dagId,
      revision: f.revision.id,
      child,
    })),
  })
}
function revised(
  f: Fixture,
  classification: 'minor' | 'material',
): PlanRevision {
  const alpha = f.revision.plan.dags['alpha']
  assert.ok(alpha)
  if (alpha.kind !== 'file') throw new Error('expected a concrete alpha DAG')
  const maker = alpha.definition.nodes['maker']
  if (!maker) throw new Error('expected a maker node')
  const dag = {
    ...alpha.definition,
    nodes: { maker: { ...maker, task: 'Deliver the clarified alpha value' } },
  }
  const assignments = f.revision.assignments.dags['alpha']
  assert.ok(assignments)
  const assignedMaker = assignments.nodes['maker']
  assert.ok(assignedMaker)
  return {
    ...f.revision,
    id: 'revision-2',
    previous: f.revision.id,
    amendment: { classification, reason: 'Clarify the agreed alpha task' },
    plan: {
      ...f.revision.plan,
      dags: { ...f.revision.plan.dags, alpha: { ...alpha, definition: dag } },
    },
    assignments: {
      ...f.revision.assignments,
      dags: {
        ...f.revision.assignments.dags,
        alpha: {
          ...assignments,
          nodes: {
            maker: { ...assignedMaker, node: dag.nodes.maker },
          },
        },
      },
    },
  }
}
function commands(
  status: (
    request: command.CommandRequest,
  ) => command.CommandObservation['status'],
) {
  const effects: string[] = []
  restoreAfter(
    spyOn(command, 'executeCommand').mockImplementation((request) => {
      effects.push(request.identity.assignment)
      const result = status(request)
      const receipt = join(request.runner, `check-${effects.length}.json`)
      atomicWrite(receipt, { status: result, identity: request.identity })
      return Promise.resolve<command.CommandObservation>({
        identity: request.identity,
        argv: request.argv,
        cwd: request.cwd,
        pid: null,
        status: result,
        exitCode: result === 'completed' ? 0 : null,
        signal: null,
        error: null,
        artifacts: [],
        stdout: join(request.runner, 'stdout'),
        stderr: join(request.runner, 'stderr'),
        receipt,
      })
    }),
  )
  restoreAfter(
    spyOn(command, 'commandClaim').mockImplementation((observation) => ({
      outcome:
        observation.status === 'completed' ? 'claimed-complete' : 'failed',
      deliverables: [],
      receipt: observation.receipt,
      revision: observation.identity.revision,
    })),
  )
  return effects
}

test('admits independent DAGs together but exposes dependencies only after their owned review', async () => {
  const f = fixture({ dependent: ['alpha'], alpha: [], beta: [] })
  const alphaStarted = gate()
  const betaStarted = gate()
  const alphaWorker = gate()
  const betaWorker = gate()
  const alphaReview = gate()
  const releaseReview = gate()
  const dependentStarted = gate()
  const admitted = children(f, (id, child) => {
    const executeWorkers = child.executeWorkers
    child.executeWorkers = async () => {
      const result = await executeWorkers()
      if (id === 'alpha') {
        alphaStarted.release()
        await alphaWorker.promise
      } else if (id === 'beta') {
        betaStarted.release()
        await betaWorker.promise
      } else dependentStarted.release()
      return result
    }
    if (id === 'alpha') {
      const executeCycle = child.executeCycle
      child.executeCycle = async () => {
        alphaReview.release()
        await releaseReview.promise
        return executeCycle()
      }
    }
  })
  reviewer()
  const running = runPlan(f.request)
  await Promise.all([alphaStarted.promise, betaStarted.promise])
  expect(
    Object.keys(readRunState(f.runDirectory).children ?? {}).sort((a, b) =>
      a.localeCompare(b),
    ),
  ).toEqual(['alpha', 'beta'])
  alphaWorker.release()
  await alphaReview.promise
  betaWorker.release()
  expect(readRunState(f.runDirectory).cycle?.dagId).toBe('alpha')
  expect(admitted.has('dependent')).toBe(false)
  releaseReview.release()
  await dependentStarted.promise
  expect(admitted.get('dependent')?.prerequisites).toMatchObject([
    {
      id: 'reviewed.alpha',
      write: ['alpha.ts'],
      reviewedCode: true,
      input: { contribution: f.contributions.get('alpha') },
    },
  ])
  const result = await running
  expect(result.state.status).toBe('succeeded')
  expect(
    result.state.approved?.slice().sort((a, b) => a.localeCompare(b)),
  ).toEqual(['alpha', 'beta', 'dependent'])
  expect(result.state.cycle).toBeNull()
  assert.ok(result.state.snapshots['plan'])
  expect(json(result.state.snapshots['plan'])).toEqual(f.revision)
  const inputPath = result.state.snapshots['overallInput']
  assert.ok(inputPath)
  assert.ok(result.state.snapshots['overallVerdict'])
  expect(
    json(inputPath).reviewed.map((entry: { id: string }) => entry.id),
  ).toEqual(['alpha', 'beta', 'dependent'])
  expect(json(result.state.snapshots['overallVerdict'])).toMatchObject({
    input: identity(inputPath),
    verdict: approved,
  })
})

test('stops at a ready deferred decision with its reviewed evidence and downstream scope intact', async () => {
  const f = fixture({ alpha: [], design: ['alpha'], dependent: ['design'] })
  const revision: PlanRevision = {
    ...f.revision,
    plan: {
      ...f.revision.plan,
      dags: {
        ...f.revision.plan.dags,
        design: {
          kind: 'deferred',
          needs: ['alpha'],
          satisfies: ['complete'],
          deferred: {
            objective: 'Choose the dependent interface',
            decisionNeeded: 'Author approval of the interface',
          },
        },
      },
    },
  }
  children(f)
  const result = await runPlan({ ...f.request, revision })
  expect(result.state.status).toBe('needs-author')
  expect(result.state.approved).toEqual(['alpha'])
  expect(Object.keys(result.state.children ?? {})).toEqual(['alpha'])
  if (!result.state.needsAuthor) throw new Error('expected author evidence')
  expect(json(result.state.needsAuthor)).toMatchObject({
    dag: 'design',
    objective: 'Choose the dependent interface',
    decisionNeeded: 'Author approval of the interface',
    affectedAssignments: ['design', 'dependent'],
    reviewed: ['alpha'],
    findings: [
      {
        assignment: 'design',
        reason: 'deferred-author-decision',
        evidence: [join(f.runDirectory, 'dags/alpha/runner/verdict.json')],
      },
    ],
  })
})

test('does not authorize a successful child without approval and can recover its retained cycle', async () => {
  const f = fixture({ alpha: [], dependent: ['alpha'] })
  let review: ReviewReport = { ...approved, verdict: 'changes-requested' }
  children(f, (id, child) => {
    if (id !== 'alpha') return
    const executeCycle = child.executeCycle
    child.executeCycle = () => {
      const report =
        child.managedResult.state.assignments['review']?.attempts[0]?.report
      if (!report) throw new Error('expected a review report')
      atomicWrite(report, review)
      return executeCycle()
    }
  })
  reviewer()
  const rejected = await runPlan(f.request)
  expect(rejected.state.status).toBe('paused')
  expect(rejected.state.approved ?? []).toEqual([])
  expect(rejected.state.children?.['alpha']?.status).toBe('succeeded')
  expect(rejected.state.children?.['dependent']).toBeUndefined()
  expect(rejected.state.cycle?.dagId).toBe('alpha')
  expect(json(join(f.runDirectory, 'failure.json')).message).toContain(
    'unreviewed-input',
  )
  const retained = rejected.state.children?.['alpha']
  if (!retained) throw new Error('expected a retained alpha child')
  review = approved
  const recovered = await resumePlan(f.recovery)
  expect(recovered.state.status).toBe('succeeded')
  expect(recovered.state.children?.['alpha']?.snapshots).toEqual(
    retained.snapshots,
  )
  expect(recovered.state.approved).toEqual(['alpha', 'dependent'])
})

test('withholds handoff and dependent admission when a child cycle needs the author', async () => {
  const f = fixture({ alpha: [], dependent: ['alpha'] })
  const admitted = children(f, (id, child) => {
    if (id !== 'alpha') return
    child.executeCycle = async () => {
      await child.repairFromOverall({
        ...approved,
        verdict: 'changes-requested',
      })
      return {
        runDirectory: join(f.runDirectory, 'dags', id),
        state: child.managedResult.state,
      }
    }
  })
  const result = await runPlan(f.request)
  expect(result.state.status).toBe('needs-author')
  expect(result.state.children?.['alpha']?.status).toBe('needs-author')
  expect(result.state.approved ?? []).toEqual([])
  expect(admitted.has('dependent')).toBe(false)
  expect(result.state.cycle?.dagId).toBe('alpha')
})

test('rejects evidence changed during overall review and resumes the exact retained reviewer input', async () => {
  const f = fixture({ alpha: [] })
  children(f)
  const opened = reviewer(() => {
    const proof = f.contributions.get('alpha')?.artifacts[0]?.path
    if (!proof) throw new Error('expected alpha evidence')
    fs.writeFileSync(proof, 'changed after review started\n')
    return approved
  })
  await expect(runPlan(f.request)).rejects.toThrow('changed-reviewed-evidence')
  const rejected = readRunState(f.runDirectory)
  expect(rejected.status).toBe('paused')
  expect(rejected.approved).toEqual(['alpha'])
  expect(rejected.snapshots['overallVerdict']).toBeUndefined()
  expect(rejected.assignments['overall-review']?.stage).toBe('interrupted')
  const attempt = rejected.assignments['overall-review']?.attempts[0]
  if (!attempt) throw new Error('expected an overall review attempt')
  assert.ok(rejected.snapshots['overallInput'])
  const input = fs.readFileSync(rejected.snapshots['overallInput'], 'utf8')
  const proof = f.contributions.get('alpha')?.artifacts[0]?.path
  if (!proof) throw new Error('expected alpha evidence')
  fs.writeFileSync(proof, 'alpha evidence\n')
  const recovered = await resumePlan(f.recovery)
  expect(recovered.state.status).toBe('succeeded')
  assert.ok(recovered.state.snapshots['overallInput'])
  expect(
    fs.readFileSync(recovered.state.snapshots['overallInput'], 'utf8'),
  ).toBe(input)
  expect(opened.at(-1)?.reopen).toBeDefined()
  expect(opened.at(-1)?.reopen?.id).toBe(attempt.sessionId)
  expect(opened.at(-1)?.reopen?.path).toBe(attempt.sessionPath)
  expect(opened.at(-1)?.reopen?.cwd).toBe(attempt.worktree)
  expect(recovered.state.assignments['overall-review']?.attempts).toHaveLength(
    1,
  )
})

test('routes an attributable overall blocker to its owner and invalidates only approved dependents', async () => {
  const f = fixture({ alpha: [], dependent: ['alpha'], beta: [] })
  children(f)
  reviewer(() => ({
    verdict: 'changes-requested',
    summary: 'The upstream value prevents completion',
    findings: [
      {
        id: 'value',
        severity: 'blocker',
        criterion: 'complete',
        assignment: 'alpha.maker',
        evidence: ['alpha.ts'],
        requestedChange: 'Restore the agreed value',
      },
    ],
  }))
  const result = await runPlan(f.request)
  expect(result.state.status).toBe('needs-author')
  expect(result.state.cycle).toMatchObject({ dagId: 'alpha', stage: 'repair' })
  expect(result.state.invalidated).toEqual(['dependent'])
  expect(
    result.state.approved?.slice().sort((a, b) => a.localeCompare(b)),
  ).toEqual(['beta', 'dependent'])
  expect(result.state.children?.['dependent']?.status).toBe('succeeded')
  expect(result.state.children?.['beta']?.status).toBe('succeeded')
  expect(result.state.needsAuthor).toBe(
    result.state.children?.['alpha']?.needsAuthor ?? null,
  )
  if (!result.state.needsAuthor) throw new Error('expected author evidence')
  expect(json(result.state.needsAuthor)).toMatchObject({
    verdict: 'changes-requested',
    findings: [{ assignment: 'maker', criterion: 'value' }],
  })
  expect(result.state.snapshots['overallInput']).toBeUndefined()
})

test('stages a material amendment without execution, then recovers just its affected closure', async () => {
  const f = fixture({ dependent: ['alpha'], alpha: [], beta: [] })
  const previous = reviewedState(f)
  const overall = {
    stage: 'interrupted' as const,
    retries: 0,
    attempts: [
      {
        number: 0,
        baseline: 'base',
        worktree: f.root,
        artifacts: f.root,
        runner: f.root,
        inputs: {},
        receipts: [],
        sessionId: 'old-reviewer',
        sessionPath: join(f.root, 'old-session.jsonl'),
      },
    ],
  }
  atomicWrite(join(f.runDirectory, 'state.json'), {
    ...previous,
    status: 'needs-author',
    needsAuthor: join(f.root, 'author-decision.json'),
    cycle: {
      dagId: 'alpha',
      stage: 'review',
      revision: 'base',
      reviewInputs: {},
    },
    assignments: { 'overall-review': overall },
    snapshots: {
      ...previous.snapshots,
      overallInput: 'obsolete-input',
      overallInputSha256: 'obsolete-hash',
      overallVerdict: 'obsolete-verdict',
    },
  })
  const amended = revised(f, 'material')
  const next = {
    ...amended,
    plan: {
      ...amended.plan,
      limits: { ...amended.plan.limits, nodeRetries: 2 },
    },
  }
  if (!next.amendment) throw new Error('expected an amendment')
  restoreAfter(spyOn(definition, 'freezePlanRevision').mockResolvedValue(next))
  const previews: unknown[] = []
  const staged = await amendPlan({
    runDirectory: f.runDirectory,
    plan: next.plan,
    amendment: next.amendment,
    runtime,
    resources,
    onPreview: (preview) => {
      expect(readRunState(f.runDirectory).revisions).toEqual(previous.revisions)
      expect(readRunState(f.runDirectory).revisionPending).not.toBe(true)
      previews.push(preview)
    },
  })
  expect(staged.revisionPending).toBe(true)
  const expectedBudgets = {
    'unit-plan': { concurrency: 2, nodeRetries: 0, repairCycles: 1 },
    'dag/alpha': { concurrency: 2, nodeRetries: 0, repairCycles: 1 },
    'dag/dependent': { concurrency: 2, nodeRetries: 0, repairCycles: 1 },
    'dag/beta': { concurrency: 2, nodeRetries: 0, repairCycles: 1 },
  }
  expect(previews).toEqual([
    {
      affectedTasks: ['alpha/maker', 'dependent'],
      budgets: {
        before: expectedBudgets,
        after: {
          ...expectedBudgets,
          'unit-plan': { concurrency: 2, nodeRetries: 2, repairCycles: 1 },
        },
      },
    },
  ])
  expect(staged.status).toBe('needs-author')
  expect(staged.approved).toEqual(['beta'])
  expect(
    staged.invalidated?.slice().sort((a, b) => a.localeCompare(b)),
  ).toEqual(['alpha', 'dependent'])
  expect(staged.affectedNodes).toEqual({ alpha: ['maker'] })
  expect(staged.children).toEqual(previous.children)
  expect(staged.cycle).toBeNull()
  expect(staged.assignments['overall-review']?.stage).toBe('ready')
  expect(staged.snapshots['overallInput']).toBeUndefined()
  expect(staged.snapshots['overallVerdict']).toBeUndefined()
  assert.ok(staged.snapshots['plan'])
  expect(json(staged.snapshots['plan'])).toEqual(next)
  const invalidated = new Map<
    string,
    { amended: boolean | undefined; nodes: readonly string[] | undefined }
  >()
  const replayInputs = new Map<
    string,
    {
      prerequisites: readonly string[]
      integrated: readonly string[]
      imports: readonly string[]
      merges: readonly string[]
    }
  >()
  children(f, (id, child, bindings) => {
    const invalidate = child.invalidateForUpstream
    child.invalidateForUpstream = (amended, nodes) => {
      invalidated.set(id, { amended, nodes })
      invalidate(amended, nodes)
    }
    const executeWorkers = child.executeWorkers
    child.executeWorkers = () => {
      replayInputs.set(id, {
        prerequisites: bindings.prerequisites.map((input) => input.id),
        integrated: bindings
          .integrated()
          .map((input) => input.id)
          .sort((a, b) => a.localeCompare(b)),
        imports: bindings
          .imports()
          .map((input) => input.contribution.acceptedRef)
          .sort((a, b) => a.localeCompare(b)),
        merges: [...bindings.importedMerges()].sort((a, b) =>
          a.localeCompare(b),
        ),
      })
      return executeWorkers()
    }
  })
  reviewer()
  const recovered = await resumePlan(f.recovery)
  expect(recovered.state.status).toBe('succeeded')
  expect(recovered.state.revisionPending).toBe(false)
  expect(recovered.state.needsAuthor).toBeNull()
  expect(recovered.state.invalidated).toEqual([])
  expect(
    recovered.state.approved?.slice().sort((a, b) => a.localeCompare(b)),
  ).toEqual(['alpha', 'beta', 'dependent'])
  expect(recovered.state.children?.['beta']).toEqual(
    previous.children?.['beta'],
  )
  expect(invalidated).toEqual(
    new Map([
      ['alpha', { amended: true, nodes: ['maker'] }],
      ['dependent', { amended: true, nodes: undefined }],
    ]),
  )
  expect(replayInputs.get('alpha')).toEqual({
    prerequisites: [],
    integrated: ['reviewed.beta'],
    imports: [
      'refs/accepted/alpha',
      'refs/accepted/beta',
      'refs/accepted/dependent',
    ],
    merges: ['merge.alpha', 'merge.beta', 'merge.dependent'],
  })
  expect(replayInputs.get('dependent')).toMatchObject({
    prerequisites: ['reviewed.alpha'],
    integrated: ['reviewed.alpha', 'reviewed.beta'],
  })
})

test('retains reviewed approvals for a minor wording-only revision', async () => {
  const f = fixture({ alpha: [], dependent: ['alpha'] })
  const previous = reviewedState(f)
  const next = revised(f, 'minor')
  if (!next.amendment) throw new Error('expected an amendment')
  restoreAfter(spyOn(definition, 'freezePlanRevision').mockResolvedValue(next))
  const staged = await amendPlan({
    runDirectory: f.runDirectory,
    plan: next.plan,
    amendment: next.amendment,
    runtime,
    resources,
  })
  expect(staged.approved).toEqual(previous.approved)
  expect(staged.children).toEqual(previous.children)
  expect(staged.invalidated).toEqual([])
  expect(staged.affectedNodes).toEqual({})
  expect(staged.revisionPending).toBe(true)
  expect(staged.revisions.at(-1)?.identity).toBe(next.id)
})

test('stages resource replacement only for the interrupted child while retaining its attempts and sibling approval', async () => {
  const f = fixture({ alpha: [], beta: [] })
  const alpha = savedChild(f, 'alpha')
  const maker = alpha.assignments['maker']
  const attempt = maker?.attempts[0]
  assert.ok(maker)
  assert.ok(attempt)
  const recovery = alpha.snapshots['recovery']
  assert.ok(recovery)
  atomicWrite(recovery, {
    phase: 'worker',
    contributions: [],
    controls: [],
    workspace: { accepted: [], preparations: {}, merges: [] },
    preparationNumber: 0,
    preparationRecords: {},
    acceptedNodes: {},
  })
  const interrupted: RunState = {
    ...alpha,
    status: 'paused',
    snapshots: { recovery, recoverySha256: identity(recovery).sha256 },
    repairRounds: { value: 1 },
    assignments: {
      ...alpha.assignments,
      maker: {
        ...maker,
        stage: 'interrupted',
        retries: 2,
        attempts: [
          {
            ...attempt,
            worktree: join(f.root, 'lost-worktree'),
            sessionId: 'retained-session',
            sessionPath: join(f.root, 'retained-session.jsonl'),
          },
        ],
      },
    },
  }
  const beta = savedChild(f, 'beta')
  const previous = paused(f, {
    children: { alpha: interrupted, beta },
    approved: ['beta'],
    cycle: {
      dagId: 'alpha',
      stage: 'repair',
      revision: 'base',
      reviewInputs: {},
    },
  })
  const admitted = children(f)
  const restart = {
    runDirectory: f.runDirectory,
    assignment: 'alpha/maker',
    reason: 'The inspected alpha worktree was lost',
  }
  await expect(
    restartPlan({ ...restart, assignment: 'alpha/maker/extra' }),
  ).rejects.toThrow('restart-not-admissible')
  expect(readRunState(f.runDirectory)).toEqual(previous)
  const staged = await restartPlan(restart)
  expect(staged.status).toBe('paused')
  expect(staged.cycle).toEqual(previous.cycle)
  expect(staged.approved).toEqual(['beta'])
  expect(staged.children?.['beta']).toEqual(beta)
  expect(staged.children?.['alpha']).toMatchObject({
    status: 'paused',
    assignments: interrupted.assignments,
    repairRounds: { value: 1 },
    restarts: [
      {
        assignment: 'maker',
        attempt: 0,
        effect: 'replace-resources',
        reason: restart.reason,
        previousWorktree: join(f.root, 'lost-worktree'),
        previousSessionId: 'retained-session',
        previousSessionPath: join(f.root, 'retained-session.jsonl'),
      },
    ],
  })
  expect(staged.restarts).toBeUndefined()
  expect(admitted.size).toBe(0)
  expect(readRunState(f.runDirectory)).toEqual(staged)
})

test('requires an explicit restart for an uncertain overall command and never replays completed checks', async () => {
  const f = fixture({ alpha: [] })
  const revision: PlanRevision = {
    ...f.revision,
    plan: {
      ...f.revision.plan,
      verify: [
        { id: 'first', argv: ['check-first'] },
        { id: 'second', argv: ['check-second'] },
      ],
    },
  }
  children(f)
  reviewer()
  let authorizedRepeat = false
  const effects = commands((request) =>
    request.identity.assignment === 'overall.second' && !authorizedRepeat
      ? 'interrupted'
      : 'completed',
  )
  const interrupted = await runPlan({ ...f.request, revision })
  expect(interrupted.state.status).toBe('paused')
  const assignment = interrupted.state.assignments['overall-review']
  assert.ok(assignment)
  expect(assignment.stage).toBe('interrupted')
  const attempt = assignment.attempts[0]
  if (!attempt) throw new Error('expected an overall review attempt')
  expect(attempt.inputs['startedCheck']).toBe('1')
  expect(attempt.receipts).toHaveLength(1)
  await expect(resumePlan(f.recovery)).rejects.toThrow(
    'uncertain-command-requires-restart',
  )
  expect(readRunState(f.runDirectory)).toEqual(interrupted.state)
  const restart = {
    runDirectory: f.runDirectory,
    assignment: 'overall-review',
    reason: 'The interrupted second check is safe to repeat',
  }
  await expect(restartPlan({ ...restart, reason: ' ' })).rejects.toThrow(
    'restart-reason-required',
  )
  const firstReceipt = attempt.receipts[0]
  assert.ok(firstReceipt)
  const firstEvidence = fs.readFileSync(firstReceipt, 'utf8')
  fs.writeFileSync(firstReceipt, `${firstEvidence}\n`)
  await expect(restartPlan(restart)).rejects.toThrow('changed-overall-check')
  expect(readRunState(f.runDirectory)).toEqual(interrupted.state)
  fs.writeFileSync(firstReceipt, firstEvidence)
  const staged = await restartPlan(restart)
  expect(staged.status).toBe('paused')
  expect(staged.restarts).toMatchObject([
    { assignment: 'overall-review', attempt: 0, effect: 'repeat-command' },
  ])
  expect(staged.assignments['overall-review']).toEqual(assignment)
  expect(effects).toEqual(['overall.first', 'overall.second'])
  await expect(restartPlan(restart)).rejects.toThrow('restart-already-staged')
  const interruptedReceipt = attempt.inputs['interruptedReceipt']
  assert.ok(interruptedReceipt)
  const interruptedEvidence = fs.readFileSync(interruptedReceipt, 'utf8')
  fs.writeFileSync(interruptedReceipt, `${interruptedEvidence}\n`)
  await expect(resumePlan(f.recovery)).rejects.toThrow('changed-overall-check')
  expect(readRunState(f.runDirectory)).toEqual(staged)
  expect(effects).toEqual(['overall.first', 'overall.second'])
  fs.writeFileSync(interruptedReceipt, interruptedEvidence)
  authorizedRepeat = true
  const recovered = await resumePlan(f.recovery)
  expect(recovered.state.status).toBe('succeeded')
  expect(effects).toEqual(['overall.first', 'overall.second', 'overall.second'])
  const completed = recovered.state.assignments['overall-review']?.attempts[0]
  if (!completed) throw new Error('expected a completed overall review attempt')
  expect(completed.receipts).toHaveLength(2)
  expect(completed.receipts[0]).toBe(attempt.receipts[0])
  expect(completed.inputs['startedCheck']).toBeUndefined()
  expect(recovered.state.restarts?.[0]?.consumedAt).toEqual(expect.any(String))
  assert.ok(recovered.state.snapshots['overallInput'])
  expect(json(recovered.state.snapshots['overallInput']).checks).toEqual(
    completed.receipts,
  )
})

test('withholds overall review when a declared overall check fails', async () => {
  const f = fixture({ alpha: [] })
  const revision: PlanRevision = {
    ...f.revision,
    plan: {
      ...f.revision.plan,
      verify: [{ id: 'acceptance', argv: ['check-acceptance'] }],
    },
  }
  children(f)
  commands(() => 'failed')
  const result = await runPlan({ ...f.request, revision })
  expect(result.state.status).toBe('needs-author')
  expect(result.state.approved).toEqual(['alpha'])
  expect(result.state.assignments['overall-review']?.stage).toBe('failed')
  expect(result.state.snapshots['overallVerdict']).toBeUndefined()
  const attempt = result.state.assignments['overall-review']?.attempts[0]
  if (!attempt) throw new Error('expected an overall review attempt')
  if (!result.state.needsAuthor) throw new Error('expected author evidence')
  expect(json(result.state.needsAuthor)).toEqual({
    reason: 'overall-check-failed',
    receipt: attempt.inputs['failedReceipt'],
    reviewed: ['alpha'],
  })
})

test('overall routing binds only the accepted verdict and prefers the longest DAG id', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'overall-verdict-'))
  try {
    const report = join(root, 'review.json')
    const inputs = join(root, 'review-inputs.json')
    const verdict = join(root, 'verdict.json')
    fs.writeFileSync(report, JSON.stringify(approved))
    fs.writeFileSync(inputs, '{"inputs":[]}')
    const envelope = (verdictReport: ReviewReport) =>
      JSON.stringify({
        input: { path: inputs, sha256: identity(inputs).sha256 },
        report: { path: report, sha256: identity(report).sha256 },
        verdict: verdictReport,
      })
    fs.writeFileSync(verdict, envelope(approved))
    const state = {
      snapshots: { overallVerdictSha256: identity(verdict).sha256 },
    }
    expect(assertOverallVerdict(state, verdict).verdict).toBe('approved')

    // Substitute the verdict bytes: the recorded identity no longer matches.
    fs.writeFileSync(
      verdict,
      envelope({
        ...approved,
        verdict: 'changes-requested',
      }),
    )
    expect(() => assertOverallVerdict(state, verdict)).toThrow(
      'changed-overall-verdict',
    )

    // Keep the verdict intact but replace the reviewed report it names.
    fs.writeFileSync(verdict, envelope(approved))
    const pinned = {
      snapshots: { overallVerdictSha256: identity(verdict).sha256 },
    }
    fs.writeFileSync(
      report,
      JSON.stringify({ ...approved, summary: 'replaced after acceptance' }),
    )
    expect(() => assertOverallVerdict(pinned, verdict)).toThrow(
      'changed-overall-verdict',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }

  const entries = [
    ['review', { kind: 'file' }],
    ['review.extra', { kind: 'file' }],
  ] as const
  expect(blockingEntry(entries, 'review.extra.node')?.[0]).toBe('review.extra')
  expect(blockingEntry(entries, 'review.node')?.[0]).toBe('review')
  expect(blockingEntry(entries, 'other.node')).toBeUndefined()
})
