import { applyIntegration } from '@dag/workspace/contribution.js'
import type { AcceptedContribution } from '@dag/workspace/types.js'
import { RunChecks } from './checks.js'
import { automatic, normalize, type RunContext } from './context.js'
import { RunError } from './error.js'
import { RunExecution } from './execution.js'
import { RunFrontier } from './frontier.js'
import { RunReview } from './review.js'

export class RunCycle {
  readonly execution: RunExecution
  readonly checks: RunChecks
  readonly review: RunReview
  readonly frontier: RunFrontier
  constructor(private readonly run: RunContext) {
    this.execution = new RunExecution(run)
    this.checks = new RunChecks(run, this.execution)
    this.review = new RunReview(run, this.execution, this.checks)
    this.frontier = new RunFrontier(run, this.execution)
  }
  async produceStep(): Promise<void> {
    if (this.run.parallel) return this.frontier.frontier()
    const progress = this.run.checkpoint.progress
    const result = await this.execution.contribution(
      this.run.base,
      progress?.feedback ?? { goal: this.run.request.definition.goal },
    )
    if (!result) return
    this.run.move('integration', {
      progress: {
        accepted: result,
        route: 'worker',
        feedback: JSON.stringify({ handoff: result.handoff }),
      },
    })
  }
  private async integrationStep(): Promise<void> {
    const progress = this.run.checkpoint.progress
    if (!progress) throw new RunError('missing-progress', this.run.directory)
    if (this.run.writeScope.length === 0) {
      this.run.move('checks', { accepted: progress.accepted })
      return
    }
    const profile = this.run.request.assignments.integration
    if (!profile)
      throw new RunError('missing-integrator', this.run.integrationId)
    const assignment = automatic(this.run.base, {
      id: this.run.integrationId,
      profile,
      write: this.run.writeScope,
    })
    const result = await this.execution.contribution(
      assignment,
      progress.feedback,
      !this.run.parallel &&
        progress.accepted.baseline === this.run.state.target.expectedRevision
        ? progress.accepted
        : undefined,
    )
    if (!result) return
    this.run.move('staged-checks', { accepted: result })
  }
  private async stagedChecksStep(): Promise<void> {
    const progress = this.run.checkpoint.progress
    const accepted = this.run.checkpoint.accepted
    if (!accepted || !progress)
      throw new RunError('missing-progress', this.run.directory)
    try {
      await this.run.capacity.run(() =>
        this.checks.checks(accepted, accepted.validationWorktree),
      )
    } catch (value) {
      const error = this.execution.retryable(
        value instanceof Error ? value : normalize(value),
      )
      this.run.cycle('repair')
      this.run.stage(this.run.integrationId, 'failed')
      this.run.move('integration', {
        progress: {
          ...progress,
          feedback: error.message,
          route: 'integration',
        },
      })
      return
    }
    this.run.cycle('integration', {
      intendedRevision: accepted.revision,
      intendedTree: accepted.tree,
    })
    this.run.move('apply')
  }
  private applyStep(): void {
    this.run.request.signal.throwIfAborted()
    const accepted = this.run.checkpoint.accepted
    if (!accepted) throw new RunError('missing-progress', this.run.directory)
    this.run.save({
      target: applyIntegration(
        this.run.state.target,
        accepted,
        this.run.authorization(),
        this.run.owner.advanceTarget?.bind(this.run.owner),
      ),
    })
    this.run.finalPreparation = undefined
    this.run.preparations.delete(this.run.integrationId)
    this.run.move('checks')
  }
  private async checksStep(): Promise<void> {
    const progress = this.run.checkpoint.progress
    const accepted = this.run.checkpoint.accepted
    if (!accepted || !progress)
      throw new RunError('missing-progress', this.run.directory)
    this.run.cycle('checks')
    try {
      const receipts = await this.run.capacity.run(() =>
        this.checks.checks(accepted),
      )
      this.run.move('review', { receipts })
    } catch (value) {
      this.checkFailure(accepted, value)
    }
  }
  private checkFailure(accepted: AcceptedContribution, value: unknown): void {
    const error = this.execution.retryable(
      value instanceof Error ? value : normalize(value),
    )
    this.run.cycle('repair')
    const routable =
      this.run.acceptedNodes.size <
      Object.keys(this.run.request.definition.nodes).length
    // No worker or integrator can act on this failure: every node is already
    // accepted and the DAG has no write scope. Repeating the same pass would
    // burn work without progress, so retain the evidence and ask the author.
    if (this.run.parallel && this.run.writeScope.length === 0 && !routable) {
      this.run.needsAuthor('unrepairable-check-failure', {
        error: error.message,
        accepted: Object.keys(this.run.acceptedNodes),
      })
      return
    }
    if (this.run.writeScope.length > 0)
      this.run.stage(this.run.integrationId, 'failed')
    this.run.move(this.run.writeScope.length > 0 ? 'integration' : 'worker', {
      progress: {
        accepted,
        route: this.run.writeScope.length > 0 ? 'integration' : 'worker',
        feedback: error.message,
      },
    })
  }
  private async reviewStep(): Promise<void> {
    const accepted = this.run.checkpoint.accepted
    if (!accepted || !this.run.checkpoint.receipts)
      throw new RunError('missing-progress', this.run.directory)
    const receipts = this.run.checkpoint.receipts
    const verdict = await this.run.capacity.run(() =>
      this.review.review(accepted, receipts),
    )
    this.run.move('decision', { verdict: JSON.stringify(verdict) })
  }
  private step(): Promise<void> | void {
    switch (this.run.checkpoint.phase) {
      case 'worker':
        return this.produceStep()
      case 'integration':
        return this.integrationStep()
      case 'staged-checks':
        return this.stagedChecksStep()
      case 'apply':
        return this.run.capacity.run(async () => this.applyStep())
      case 'checks':
        return this.checksStep()
      case 'review':
        return this.reviewStep()
      case 'decision':
        return this.review.decisionStep()
      case 'repair':
        return this.review.repairStep()
      default:
        throw new RunError(
          'invalid-phase',
          this.run.checkpoint.phase satisfies never,
        )
    }
  }
  async drive(): Promise<void> {
    while (this.run.state.status === 'running') {
      this.run.request.signal.throwIfAborted()
      await this.step()
    }
  }
}
