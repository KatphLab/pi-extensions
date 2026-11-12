import * as fs from 'node:fs'
import { join } from 'node:path'
import type { ArtifactIdentity } from '@dag/command.js'
import { parseReviewReport, type ReviewReport } from '@dag/definition/schema.js'
import {
  type AttemptState,
  atomicWrite,
  attemptLayout,
  RunOwner,
} from '@dag/state.js'
import { createWorker } from '@dag/worker.js'
import type { AcceptedContribution } from '@dag/workspace/types.js'
import {
  assertTarget,
  captureTarget,
  prepareWorktree,
} from '@dag/workspace/workspace.js'
import { assertEvidence, fileIdentity, json } from './checkpoint.js'
import type { RunChecks } from './checks.js'
import { automatic, pendingRestart, type RunContext } from './context.js'
import { RunError } from './error.js'
import type { RunExecution } from './execution.js'

export class RunReview {
  constructor(
    private readonly run: RunContext,
    private readonly execution: RunExecution,
    private readonly checks: RunChecks,
  ) {}
  private reviewInputs(
    accepted: AcceptedContribution,
    receipts: readonly string[],
  ) {
    const baseline = this.run.state.target.expectedRevision
    return {
      goal: this.run.request.definition.goal,
      criteria: this.run.request.definition.criteria,
      revision: baseline,
      tree:
        accepted.revision === baseline
          ? accepted.tree
          : this.run.revisionTree(baseline),
      artifacts: this.run
        .currentContributions()
        .flatMap((entry) => entry.artifacts),
      evidence: [...this.run.controls],
      decisions: this.run.currentContributions().map((entry) => ({
        baseline: entry.baseline,
        revision: entry.revision,
        tree: entry.tree,
        changedPaths: entry.changedPaths,
        handoff: entry.handoff,
      })),
      checks: receipts,
    }
  }
  private bindReviewInputs(
    path: string,
    inputs: ReturnType<RunReview['reviewInputs']>,
    interrupted: AttemptState | undefined,
  ): ArtifactIdentity {
    if (interrupted) {
      if (
        fileIdentity(path)['sha256'] !== interrupted.inputs['sha256'] ||
        JSON.stringify(json(path)) !== JSON.stringify(inputs)
      )
        throw new RunError('changed-review-inputs', path)
    } else atomicWrite(path, inputs)
    return fileIdentity(path)
  }
  private prepareReview(
    accepted: AcceptedContribution,
    receipts: readonly string[],
  ) {
    const round = this.run.reviewRound()
    const baseline = this.run.state.target.expectedRevision
    const layout = attemptLayout(this.run.directory, this.run.reviewId, round)
    const interrupted =
      this.run.recovering &&
      this.run.state.assignments[this.run.reviewId]?.stage === 'interrupted'
        ? this.run.state.assignments[this.run.reviewId]?.attempts.at(-1)
        : undefined
    const decision = pendingRestart(this.run.state, this.run.reviewId)
    const replace = decision?.effect === 'replace-resources'
    const worktree =
      interrupted && !replace
        ? interrupted.worktree
        : prepareWorktree(this.run.state.target, {
            runId: this.run.request.runId,
            assignment: replace
              ? `${this.run.reviewId}.restart-${this.run.state.restarts?.length ?? 0}`
              : this.run.reviewId,
            attempt: round,
            baseline,
            role: 'validation',
          })
    if (decision) {
      this.run.sessions.delete(this.run.reviewId)
      this.run.consumeRestart(decision)
    }
    const pinned = captureTarget(worktree)
    const inputs = this.reviewInputs(accepted, receipts)
    const path = join(layout.runner, 'review-inputs.json')
    const bound = this.bindReviewInputs(path, inputs, interrupted)
    this.run.cycle('review', {
      path,
      sha256: bound.sha256,
      revision: baseline,
      tree: inputs.tree,
    })

    return {
      round,
      baseline,
      layout,
      interrupted,
      worktree,
      pinned,
      inputs,
      path,
      bound,
    }
  }
  async review(
    accepted: AcceptedContribution,
    receipts: readonly string[],
  ): Promise<ReviewReport> {
    const {
      round,
      baseline,
      layout,
      interrupted,
      worktree,
      pinned,
      inputs,
      path,
      bound,
    } = this.prepareReview(accepted, receipts)
    const assignment = automatic(this.run.base, {
      id: this.run.reviewId,
      profile: this.run.request.assignments.review,
      write: [],
    })
    const savedReview = interrupted
      ? this.run.sessions.get(this.run.reviewId)
      : undefined
    const reviewer = await createWorker({
      cwd: worktree,
      artifacts: layout.artifacts,
      sessionsDirectory: join(this.run.directory, 'sessions'),
      agentDirectory: join(this.run.directory, 'agent'),
      runtime: this.run.request.runtime,
      assignment,
      role: 'reviewer',
      ...(savedReview ? { reopen: savedReview } : {}),
    })
    this.run.assignment(this.run.reviewId, {
      stage: 'running',
      retries: 0,
      attempts: [
        ...(interrupted
          ? (this.run.state.assignments[this.run.reviewId]?.attempts.slice(
              0,
              -1,
            ) ?? [])
          : (this.run.state.assignments[this.run.reviewId]?.attempts ?? [])),
        {
          number: round,
          baseline,
          worktree,
          ...layout,
          inputs: { path, sha256: bound.sha256 },
          receipts: [],
          sessionId: reviewer.identity.id,
          sessionPath: reviewer.identity.path,
        },
      ],
    })
    try {
      const reportPath = join(layout.artifacts, 'review.json')
      const claim =
        interrupted && fs.existsSync(reportPath)
          ? {
              role: 'reviewer' as const,
              report: parseReviewReport(fs.readFileSync(reportPath, 'utf8')),
              reportPath,
            }
          : await reviewer.prompt(
              JSON.stringify({
                stage: 'review',
                ...inputs,
                inputIdentity: bound,
                artifacts: layout.artifacts,
              }),
              this.run.request.signal,
            )
      if (claim.role !== 'reviewer')
        throw new RunError('unexpected-worker', this.run.reviewId)
      assertTarget(this.run.state.target)
      assertTarget(pinned)
      assertEvidence([bound, ...inputs.artifacts, ...inputs.evidence])
      atomicWrite(join(layout.runner, 'verdict.json'), {
        input: bound,
        report: fileIdentity(claim.reportPath),
        verdict: claim.report,
      })
      this.run.stage(this.run.reviewId, 'accepted', {
        report: claim.reportPath,
      })
      if (this.run.state.cycle)
        this.run.save({
          cycle: {
            ...this.run.state.cycle,
            verdict: join(layout.runner, 'verdict.json'),
          },
        })
      return claim.report
    } finally {
      await reviewer.close()
      assertTarget(this.run.state.target)
      assertTarget(pinned)
      assertEvidence([bound, ...inputs.artifacts, ...inputs.evidence])
    }
  }
  private reviewDecision(
    verdict: ReviewReport,
  ): 'approved' | 'author' | 'worker' | 'integration' {
    if (
      verdict.findings.some(
        (finding) =>
          !Object.hasOwn(
            this.run.request.definition.criteria,
            finding.criterion,
          ) ||
          ![
            ...Object.keys(this.run.request.definition.nodes),
            this.run.integrationId,
          ].includes(finding.assignment),
      )
    )
      return 'author'
    switch (verdict.verdict) {
      case 'needs-author':
        return 'author'
      case 'approved':
        if (verdict.findings.every((finding) => finding.severity === 'note'))
          return 'approved'
        break
      case 'changes-requested':
        break
      default:
        throw new RunError('invalid-verdict', verdict.verdict satisfies never)
    }
    return this.run.writeScope.length === 0 ||
      verdict.findings.some(
        (finding) =>
          Object.hasOwn(
            this.run.request.definition.nodes,
            finding.assignment,
          ) && finding.severity === 'blocker',
      )
      ? 'worker'
      : 'integration'
  }
  async decisionStep(): Promise<void> {
    const accepted = this.run.checkpoint.accepted
    if (!accepted || !this.run.checkpoint.verdict)
      throw new RunError('missing-progress', this.run.directory)
    const verdict = parseReviewReport(this.run.checkpoint.verdict)
    const decision = this.reviewDecision(verdict)
    if (decision === 'approved') {
      await this.checks.reviewedHandoff(accepted)
      this.run.save({ status: 'succeeded', cycle: null })
      if (!this.run.managed && this.run.owner instanceof RunOwner)
        this.run.owner.releaseReservation()
      return
    }
    if (decision === 'author') {
      this.run.needsAuthor('review-new-scope', verdict)
      return
    }
    this.beginRepair(verdict, accepted, decision)
  }
  private beginRepair(
    verdict: ReviewReport,
    accepted: AcceptedContribution,
    decision: 'worker' | 'integration',
  ): void {
    const rounds =
      this.run.state.repairRounds[this.run.request.definition.name] ?? 0
    if (rounds >= this.run.request.definition.limits.repairCycles) {
      this.run.needsAuthor('repair-cycles-exhausted', verdict)
      return
    }
    const repairs = Object.fromEntries(
      Object.keys(this.run.request.definition.nodes)
        .filter((id) =>
          verdict.findings.some(
            (finding) =>
              finding.severity === 'blocker' && finding.assignment === id,
          ),
        )
        .map((id) => [
          id,
          JSON.stringify({
            verdict,
            revision: this.run.state.target.expectedRevision,
          }),
        ]),
    )
    for (const id of Object.keys(repairs)) {
      if (
        (this.run.state.assignments[id]?.retries ?? 0) >=
        this.run.request.definition.limits.nodeRetries
      ) {
        this.run.needsAuthor('node-retries-exhausted', {
          assignment: id,
          verdict,
        })
        return
      }
    }
    const { handoff: _previousHandoff, ...priorCheckpoint } =
      this.run.checkpoint
    this.run.checkpoint = {
      ...priorCheckpoint,
      phase: 'repair',
      reviewed: undefined,
      repairs,
      progress: {
        accepted,
        route: decision,
        feedback: JSON.stringify({
          verdict,
          revision: this.run.state.target.expectedRevision,
        }),
      },
    }
    this.run.save({
      repairRounds: {
        ...this.run.state.repairRounds,
        [this.run.request.definition.name]: rounds + 1,
      },
    })
  }
  private reopenRepairAssignments(
    repairs: Readonly<Record<string, string>>,
  ): void {
    if (Object.keys(repairs).length === 0) return
    // Old preparation objects bind the prior target. Retained acceptances and
    // immutable receipts remain valid; prepare fresh ancestry for changed inputs.
    for (const [id, node] of this.run.acceptedNodes) {
      const { preparation: _preparation, ...retained } = node
      this.run.acceptedNodes.set(id, retained)
    }
    const repairBase = this.run.preparations.get(
      this.run.branchPreparationId,
    )?.revision
    this.run.checkpoint = {
      ...this.run.checkpoint,
      ...(repairBase ? { repairBase } : {}),
    }
    this.run.preparations.delete(this.run.branchPreparationId)
    this.run.preparationRecords.delete(this.run.branchPreparationId)
    for (const id of Object.keys(repairs)) {
      this.execution.invalidateConsumers(id)
      const current = this.run.state.assignments[id]
      if (!current) throw new RunError('missing-assignment', id)
      this.run.assignment(id, { ...current, stage: 'ready' })
      this.run.preparations.delete(id)
      this.run.preparationRecords.delete(id)
    }
  }
  repairStep(): void {
    const progress = this.run.checkpoint.progress
    if (!progress) throw new RunError('missing-progress', this.run.directory)
    this.run.cycle('repair')
    const repairs = this.run.checkpoint.repairs
    if (this.run.parallel && repairs) this.reopenRepairAssignments(repairs)
    this.run.move(progress.route === 'worker' ? 'worker' : 'integration')
    return
  }
}
