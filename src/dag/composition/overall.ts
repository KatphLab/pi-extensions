import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { join } from 'node:path'
import {
  type ArtifactIdentity,
  commandClaim,
  executeCommand,
} from '@dag/command.js'
import {
  type PlanRevision,
  parseReviewReport,
  type ReviewReport,
} from '@dag/definition/schema.js'
import { fileIdentity } from '@dag/run/checkpoint.js'
import { automaticStageId } from '@dag/run/context.js'
import type { RunResult } from '@dag/run/types.js'
import type { ExecutionCapacity } from '@dag/scheduler.js'
import {
  type AttemptLayout,
  type AttemptState,
  atomicWrite,
  attemptLayout,
  type RunOwner,
  type RunState,
  readRunState,
} from '@dag/state.js'
import {
  createWorker,
  preflightSession,
  type WorkerHandle,
} from '@dag/worker.js'
import type { Prerequisite } from '@dag/workspace/types.js'
import {
  assertTarget,
  captureTarget,
  prepareWorktree,
} from '@dag/workspace/workspace.js'
import { CompositionError, identity } from './evidence.js'
import type { PlanRunRequest } from './types.js'

export function interruptedOverallCheck(
  state: RunState,
): AttemptState | undefined {
  const assignment = state.assignments['overall-review']
  const attempt = assignment?.attempts.at(-1)
  return assignment?.stage === 'interrupted' && !attempt?.sessionId
    ? attempt
    : undefined
}
export function pendingOverallRestart(state: RunState, attempt: AttemptState) {
  return state.restarts?.findLast(
    (item) =>
      item.assignment === 'overall-review' &&
      item.attempt === attempt.number &&
      item.effect === 'repeat-command' &&
      !item.consumedAt,
  )
}
export function assertOverallCheckEvidence(attempt: AttemptState): void {
  for (const [index, path] of attempt.receipts.entries())
    if (identity(path).sha256 !== attempt.inputs[`check.${index}`])
      throw new CompositionError('changed-overall-check', path)
  const interrupted = attempt.inputs['interruptedReceipt']
  if (
    interrupted &&
    identity(interrupted).sha256 !== attempt.inputs['interruptedReceiptSha256']
  )
    throw new CompositionError('changed-overall-check', interrupted)
}
export function stageOverallRestart(state: RunState, reason: string): RunState {
  const attempt = interruptedOverallCheck(state)
  if (!attempt || attempt.inputs['startedCheck'] === undefined)
    throw new CompositionError('restart-not-admissible', 'overall-review')
  if (!reason.trim())
    throw new CompositionError('restart-reason-required', 'overall-review')
  if (pendingOverallRestart(state, attempt))
    throw new CompositionError('restart-already-staged', 'overall-review')
  assertOverallCheckEvidence(attempt)
  return {
    ...state,
    restarts: [
      ...(state.restarts ?? []),
      {
        assignment: 'overall-review',
        attempt: attempt.number,
        effect: 'repeat-command',
        reason,
        stagedAt: new Date().toISOString(),
        previousWorktree: attempt.worktree,
      },
    ],
  }
}
function overallAssignment(revision: PlanRevision) {
  const { plan, assignments } = revision
  return {
    id: 'overall-review',
    goal: plan.goal,
    criteria: plan.criteria,
    context: plan.context ?? '',
    profile: assignments.review,
    skills: [],
    instructions: [],
    node: {
      kind: 'agent' as const,
      task: 'Independently review the complete goal against the pinned revision, per-DAG reviewed evidence and declared criteria. Write review.json.',
      needs: [],
      references: [],
      write: [],
      outputs: [],
      satisfies: Object.keys(plan.criteria),
      verify: [],
    },
  }
}
function assertIdentities(evidence: readonly ArtifactIdentity[]): void {
  for (const expected of evidence) {
    const actual = identity(expected.path)
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
      throw new CompositionError('changed-reviewed-evidence', expected.path)
  }
}
type OverallAttempt = {
  readonly state: RunState
  readonly prior: AttemptState | undefined
  readonly round: number
  readonly artifacts: AttemptLayout
  readonly checks: readonly string[]
  readonly inputPath: string
  readonly inputs: object
  readonly bound: ArtifactIdentity
  readonly evidence: readonly ArtifactIdentity[]
}
export class OverallReview {
  constructor(
    private readonly request: PlanRunRequest,
    private readonly owner: RunOwner,
    private readonly capacity: ExecutionCapacity,
    private readonly reviewed: ReadonlyMap<string, Prerequisite>,
  ) {}

  private consumeOverallRestart(attempt: AttemptState): void {
    const { owner } = this
    const state = readRunState(owner.runDirectory)
    const restart = pendingOverallRestart(state, attempt)
    if (!restart)
      throw new CompositionError(
        'uncertain-command-requires-restart',
        'overall-review',
      )
    owner.write({
      ...state,
      restarts: (state.restarts ?? []).map((item) =>
        item === restart
          ? { ...item, consumedAt: new Date().toISOString() }
          : item,
      ),
    })
  }
  private saveOverallCheck(
    attempt: AttemptState,
    stage: 'checking' | 'interrupted' | 'failed',
  ): void {
    const { owner } = this
    const state = readRunState(owner.runDirectory)
    const attempts = state.assignments['overall-review']?.attempts ?? []
    owner.write({
      ...state,
      status: stage === 'interrupted' ? 'paused' : state.status,
      assignments: {
        ...state.assignments,
        'overall-review': {
          stage,
          retries: 0,
          attempts: [
            ...(attempts.at(-1)?.number === attempt.number
              ? attempts.slice(0, -1)
              : attempts),
            attempt,
          ],
        },
      },
    })
  }
  private async executeOverallCheck(
    attempt: AttemptState,
    index: number,
  ): Promise<AttemptState> {
    const { request, owner } = this
    request.signal.throwIfAborted()
    const state = readRunState(owner.runDirectory)
    if (attempt.inputs['startedCheck'] !== undefined)
      this.consumeOverallRestart(attempt)
    const started = {
      ...attempt,
      inputs: { ...attempt.inputs, startedCheck: String(index) },
    }
    this.saveOverallCheck(started, 'checking')
    const check = request.revision.plan.verify[index]
    if (!check)
      throw new CompositionError('missing-overall-check', String(index))
    const observed = await executeCommand({
      argv: check.argv,
      cwd: state.target.root,
      artifacts: attempt.artifacts,
      runner: attempt.runner,
      outputs: [],
      signal: request.signal,
      identity: {
        runId: request.runId,
        assignment: `overall.${check.id}`,
        attempt: attempt.number,
        revision: state.target.expectedRevision,
      },
    })
    const claim = commandClaim(observed)
    const { startedCheck: _started, ...inputs } = started.inputs
    if (observed.status === 'interrupted') {
      this.saveOverallCheck(
        {
          ...started,
          inputs: {
            ...started.inputs,
            interruptedReceipt: observed.receipt,
            interruptedReceiptSha256: identity(observed.receipt).sha256,
          },
        },
        'interrupted',
      )
      throw new CompositionError('overall-check-interrupted', observed.receipt)
    }
    if (claim.outcome !== 'claimed-complete') {
      this.saveOverallCheck(
        { ...attempt, inputs: { ...inputs, failedReceipt: observed.receipt } },
        'failed',
      )
      throw new CompositionError('overall-check-failed', observed.receipt)
    }
    assertTarget(state.target)
    const completed = {
      ...attempt,
      inputs: {
        ...inputs,
        [`check.${index}`]: identity(observed.receipt).sha256,
      },
      receipts: [...attempt.receipts, observed.receipt],
    }
    this.saveOverallCheck(completed, 'checking')
    return completed
  }
  private async runOverallChecks(
    saved: AttemptState,
  ): Promise<readonly string[]> {
    const { request, capacity } = this
    assertOverallCheckEvidence(saved)
    let attempt = saved
    this.saveOverallCheck(attempt, 'checking')
    for (
      let index = attempt.receipts.length;
      index < request.revision.plan.verify.length;
      index++
    )
      attempt = await capacity.run(() =>
        this.executeOverallCheck(attempt, index),
      )
    return attempt.receipts
  }
  private overallInputs(
    state: RunState,
    checks: readonly string[],
    evidence: readonly ArtifactIdentity[],
  ) {
    const { request, reviewed } = this
    return {
      goal: request.revision.plan.goal,
      criteria: request.revision.plan.criteria,
      revision: state.target.expectedRevision,
      reviewed: [...reviewed]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, input]) => {
          const entry = request.revision.plan.dags[id]
          if (entry?.kind !== 'file')
            throw new CompositionError('unreviewed-input', id)
          return {
            id,
            handoff: input.input.contribution.handoff,
            revision: input.input.contribution.revision,
            artifacts: input.input.contribution.artifacts,
            verdict:
              state.children?.[id]?.assignments[
                automaticStageId(entry.definition.nodes, 'review')
              ]?.attempts.at(-1)?.report,
          }
        }),
      checks,
      checkReceipts: checks.map(identity),
      evidence,
    }
  }
  private async prepareOverallChecks(state: RunState) {
    const { request, owner } = this
    const previous = state.assignments['overall-review']
    const interrupted =
      previous?.stage === 'interrupted' ? previous.attempts.at(-1) : undefined
    const prior = interrupted?.sessionId ? interrupted : undefined
    const definitionIdentity = createHash('sha256')
      .update(JSON.stringify(request.revision.plan.verify))
      .digest('hex')
    const replaced =
      interrupted &&
      !prior &&
      (interrupted.definitionIdentity !== definitionIdentity ||
        interrupted.baseline !== state.target.expectedRevision)
    if (replaced && interrupted.inputs['startedCheck'] !== undefined) {
      request.signal.throwIfAborted()
      this.consumeOverallRestart(interrupted)
    }
    const nextRound = previous?.attempts.length ?? 0
    const round = replaced ? nextRound : (interrupted?.number ?? nextRound)
    const artifacts = attemptLayout(owner.runDirectory, 'overall-review', round)
    const resumable = replaced ? undefined : interrupted
    const checks = prior
      ? prior.receipts
      : await this.runOverallChecks(
          resumable ?? {
            number: round,
            baseline: state.target.expectedRevision,
            definitionIdentity,
            worktree: state.target.root,
            ...artifacts,
            inputs: {},
            receipts: [],
          },
        )
    return { prior, round, artifacts, checks }
  }
  private async prepareOverall(): Promise<OverallAttempt> {
    const { owner, reviewed } = this
    const state = readRunState(owner.runDirectory)
    assertTarget(state.target)
    const { prior, round, artifacts, checks } =
      await this.prepareOverallChecks(state)
    const evidence = [...reviewed]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, entry]) => entry.input.evidence)
    assertIdentities(evidence)
    const inputs = this.overallInputs(state, checks, evidence)
    const inputPath = join(artifacts.runner, 'review-inputs.json')
    if (prior) {
      if (
        prior.inputs['sha256'] !== identity(inputPath)['sha256'] ||
        JSON.stringify(JSON.parse(fs.readFileSync(inputPath, 'utf8'))) !==
          JSON.stringify(inputs)
      )
        throw new CompositionError('changed-overall-inputs', inputPath)
    } else atomicWrite(inputPath, inputs)
    const bound = identity(inputPath)
    const current = readRunState(owner.runDirectory)
    owner.write({
      ...current,
      snapshots: {
        ...current.snapshots,
        overallInput: inputPath,
        overallInputSha256: bound.sha256,
      },
    })
    return {
      state,
      prior,
      round,
      artifacts,
      checks,
      inputPath,
      inputs,
      bound,
      evidence,
    }
  }
  private async openOverall(attempt: OverallAttempt) {
    const { request, owner } = this
    const { state, prior, round, artifacts, inputPath, bound, checks } = attempt
    const worktree =
      prior?.worktree ??
      prepareWorktree(state.target, {
        runId: request.runId,
        assignment: 'overall-review',
        attempt: round,
        baseline: state.target.expectedRevision,
        role: 'validation',
      })
    if (prior) {
      const pinned = captureTarget(worktree)
      if (
        pinned.expectedRevision !== state.target.expectedRevision ||
        pinned.commonDirectory !== state.target.commonDirectory ||
        !prior.sessionId ||
        !prior.sessionPath
      )
        throw new CompositionError('changed-overall-worktree', worktree)
      await preflightSession({
        id: prior.sessionId,
        path: prior.sessionPath,
        cwd: worktree,
      })
    }
    const assignment = overallAssignment(request.revision)
    const reviewer = await createWorker({
      cwd: worktree,
      artifacts: artifacts.artifacts,
      sessionsDirectory: join(owner.runDirectory, 'sessions'),
      agentDirectory: join(owner.runDirectory, 'agent'),
      runtime: request.runtime,
      assignment,
      role: 'reviewer',
      ...(prior?.sessionId && prior.sessionPath
        ? {
            reopen: {
              id: prior.sessionId,
              path: prior.sessionPath,
              cwd: worktree,
            },
          }
        : {}),
    })
    const current = readRunState(owner.runDirectory)
    const saved = current.assignments['overall-review']?.attempts.at(-1)
    owner.write({
      ...current,
      assignments: {
        ...current.assignments,
        'overall-review': {
          stage: 'running',
          retries: 0,
          attempts: [
            ...(current.assignments['overall-review']?.attempts.slice(0, -1) ??
              []),
            {
              ...saved,
              number: round,
              baseline: state.target.expectedRevision,
              worktree,
              ...artifacts,
              inputs: {
                ...saved?.inputs,
                path: inputPath,
                sha256: bound.sha256,
              },
              receipts: [...checks],
              sessionId: reviewer.identity.id,
              sessionPath: reviewer.identity.path,
            },
          ],
        },
      },
    })
    return reviewer
  }
  private acceptOverall(
    attempt: OverallAttempt,
    report: ReviewReport,
    reportPath: string,
    reviewer: WorkerHandle,
  ): RunResult {
    const { owner } = this
    const { state, inputPath, bound, evidence, artifacts } = attempt
    assertTarget(state.target)
    assertIdentities(evidence)
    if (identity(inputPath).sha256 !== bound.sha256)
      throw new CompositionError('changed-review-inputs', inputPath)
    const verdictPath = join(artifacts.runner, 'verdict.json')
    atomicWrite(verdictPath, {
      input: bound,
      report: identity(reportPath),
      verdict: report,
      sessionId: reviewer.identity.id,
      sessionPath: reviewer.identity.path,
      cwd: reviewer.identity.cwd,
    })
    const current = readRunState(owner.runDirectory)
    const assignment = current.assignments['overall-review']
    if (!assignment)
      throw new CompositionError('missing-overall-attempt', verdictPath)
    const updated: RunState = {
      ...current,
      assignments: {
        ...current.assignments,
        'overall-review': { ...assignment, stage: 'accepted' },
      },
      snapshots: {
        ...current.snapshots,
        overallVerdict: verdictPath,
        overallVerdictSha256: fileIdentity(verdictPath).sha256,
      },
    }
    if (
      report.verdict === 'approved' &&
      report.findings.every((finding) => finding.severity === 'note')
    ) {
      owner.write({ ...updated, status: 'succeeded' })
      owner.releaseReservation()
    } else {
      const path = join(owner.runDirectory, 'needs-author.json')
      atomicWrite(path, {
        reason: 'overall-review-blocked',
        verdict: report,
        input: bound,
      })
      owner.write({ ...updated, status: 'needs-author', needsAuthor: path })
    }
    return {
      runDirectory: owner.runDirectory,
      state: readRunState(owner.runDirectory),
    }
  }
  async execute(): Promise<RunResult> {
    const { request, capacity } = this
    const attempt = await this.prepareOverall()
    const reviewer = await this.openOverall(attempt)
    try {
      const reportPath = join(attempt.artifacts.artifacts, 'review.json')
      const claim =
        attempt.prior && fs.existsSync(reportPath)
          ? {
              role: 'reviewer' as const,
              report: parseReviewReport(fs.readFileSync(reportPath, 'utf8')),
              reportPath,
            }
          : await capacity.run(() =>
              reviewer.prompt(
                JSON.stringify({
                  stage: 'review',
                  inputIdentity: attempt.bound,
                  ...attempt.inputs,
                  artifacts: attempt.artifacts.artifacts,
                }),
                request.signal,
              ),
            )
      if (claim.role !== 'reviewer')
        throw new CompositionError('invalid-review', attempt.inputPath)
      return this.acceptOverall(
        attempt,
        claim.report,
        claim.reportPath,
        reviewer,
      )
    } finally {
      await reviewer.close()
    }
  }
}
