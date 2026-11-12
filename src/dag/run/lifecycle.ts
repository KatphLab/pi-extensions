import { join } from 'node:path'
import type { ReviewReport } from '@dag/definition/schema.js'
import { atomicWrite, type RunState } from '@dag/state.js'
import { restoreWorkspace } from '@dag/workspace/checkpoint.js'
import { recoverAppliedIntegration } from '@dag/workspace/contribution.js'
import type { AcceptedContribution } from '@dag/workspace/types.js'
import { assertTarget, captureTarget } from '@dag/workspace/workspace.js'
import {
  assertEvidence,
  checkpointSchema,
  fileIdentity,
  readBound,
  type SavedCheckpoint,
} from './checkpoint.js'
import { diagnostic, normalize, pause, type RunContext } from './context.js'
import { RunCycle } from './cycle.js'
import { RunError } from './error.js'
import { reviewedResult } from './handoff.js'
import {
  inspectRecoveryAttempts,
  inspectRecoveryReview,
  inspectRecoveryTarget,
  sessionIdentity,
} from './inspection.js'
import type { ManagedDag, RunResult } from './types.js'

export class RunLifecycle implements ManagedDag {
  private readonly cycle: RunCycle
  constructor(private readonly run: RunContext) {
    this.cycle = new RunCycle(run)
  }
  get managedResult() {
    return this.run.managedResult
  }
  reviewedResult(name: string) {
    return reviewedResult(this.run, name)
  }
  private restoreRun(state: RunState, checkpoint: SavedCheckpoint): void {
    this.restoreCoordinator(state, checkpoint)
    if (checkpoint.phase === 'apply' && this.run.checkpoint.accepted) {
      const actual = captureTarget(state.target.root)
      if (actual.expectedRevision === this.run.checkpoint.accepted.revision) {
        this.run.state = {
          ...this.run.state,
          target: recoverAppliedIntegration(
            state.target,
            this.run.checkpoint.accepted,
            this.run.authorization(),
          ),
        }
        this.run.checkpoint = { ...this.run.checkpoint, phase: 'checks' }
        this.run.finalPreparation = undefined
        this.run.preparations.delete(this.run.integrationId)
      }
    }
  }
  private freeze(amended = false): void {
    const path = join(
      this.run.directory,
      amended
        ? `snapshot-revision-${this.run.state.revisions.length}.json`
        : 'snapshot.json',
    )
    atomicWrite(path, {
      source: this.run.request.source,
      definition: JSON.stringify(
        (({ stages: _stages, ...body }) => body)(this.run.request.definition),
      ),
      profiles: JSON.stringify({
        profiles: this.run.request.assignments.profiles,
      }),
      resources: Object.fromEntries(
        Object.entries(this.run.request.assignments.nodes).map(([id, item]) => [
          id,
          { skills: item.skills, instructions: item.instructions },
        ]),
      ),
    })
    const identity = fileIdentity(path)
    this.run.controls.push(identity)
    this.run.save({
      snapshots: {
        ...this.run.state.snapshots,
        effective: path,
        effectiveSha256: identity.sha256,
      },
      revisions: [
        ...this.run.state.revisions,
        {
          identity: identity.sha256,
          source: path,
          expanded: path,
          reason: 'initial admitted DAG',
          review:
            Object.keys(this.run.request.source).find((path) =>
              path.endsWith('.review.json'),
            ) ?? null,
        },
      ],
    })
  }
  private restoreAcceptedNodes(
    state: RunState,
    checkpoint: SavedCheckpoint,
  ): void {
    for (const [id, assignment] of Object.entries(
      this.run.request.assignments.nodes,
    )) {
      if (state.assignments[id]?.stage !== 'accepted') continue
      const saved = checkpoint.acceptedNodes[id]
      const contribution = this.run.contributions.findLast(
        (entry) => entry.receipt === saved?.receipt,
      )
      if (
        !saved ||
        !contribution ||
        contribution.revision !==
          state.assignments[id]?.attempts.at(-1)?.acceptedRevision
      )
        throw new RunError('missing-accepted-contribution', id)
      const preparation = saved.preparation
        ? this.run.preparations.get(saved.preparation)
        : undefined
      if (saved.preparation && !preparation)
        throw new RunError('missing-prerequisites', id)
      this.cycle.execution.acceptNode(assignment, contribution, preparation)
    }
  }
  private restoreCoordinator(
    state: RunState,
    checkpoint: SavedCheckpoint,
  ): void {
    this.run.state = state
    this.run.checkpoint = checkpoint
    const restored = restoreWorkspace(
      this.run.owner,
      this.run.managed?.imports(),
      this.run.managed?.importedMerges(),
    )
    this.run.restoredInputs = restored.inputs
    this.run.restoredMerges = restored.merges
    const canonical = (contribution: AcceptedContribution) => {
      const accepted = restored.contributions.get(contribution.receipt)
      if (
        !accepted ||
        JSON.stringify(accepted) !== JSON.stringify(contribution)
      )
        throw new RunError(
          'missing-accepted-contribution',
          contribution.receipt,
        )
      return accepted
    }
    this.run.checkpoint = {
      ...checkpoint,
      ...(checkpoint.accepted
        ? { accepted: canonical(checkpoint.accepted) }
        : {}),
      ...(checkpoint.progress
        ? {
            progress: {
              ...checkpoint.progress,
              accepted: canonical(checkpoint.progress.accepted),
            },
          }
        : {}),
      ...(checkpoint.reviewed
        ? { reviewed: canonical(checkpoint.reviewed) }
        : {}),
    }
    this.run.contributions.length = 0
    this.run.contributions.push(...checkpoint.contributions.map(canonical))
    this.run.controls.push(...checkpoint.controls)
    this.run.preparationNumber = checkpoint.preparationNumber
    for (const [id, preparation] of restored.preparations)
      this.run.preparations.set(id, preparation)
    for (const [id, record] of Object.entries(checkpoint.preparationRecords)) {
      assertEvidence([record])
      this.run.preparationRecords.set(id, record)
    }
    if (checkpoint.finalPreparation)
      this.run.finalPreparation = this.run.preparations.get(
        checkpoint.finalPreparation,
      )
    this.restoreAcceptedNodes(state, checkpoint)
    for (const id of Object.keys(state.assignments)) {
      const identity = sessionIdentity(state, id)
      if (identity) this.run.sessions.set(id, identity)
    }
  }
  async resume(
    state: RunState,
    checkpoint: SavedCheckpoint,
  ): Promise<RunResult> {
    this.restoreRun(state, checkpoint)
    if (state.revisionPending) {
      this.invalidateForUpstream(
        false,
        state.revisionAffected ? state.revisionAffectedNodes : [],
      )
      return await this.executeResumed()
    }
    if (checkpoint.phase === 'worker' && !this.run.parallel)
      this.run.retainedAssignments.add(this.run.base.id)
    if (checkpoint.phase === 'integration')
      this.run.retainedAssignments.add(this.run.integrationId)
    return await this.executeResumed()
  }
  private async executeResumed(): Promise<RunResult> {
    this.run.recovering = true
    this.run.save({
      status: 'running',
      revisionPending: false,
      revisionAffected: false,
      revisionAffectedNodes: [],
    })
    return await this.observe(() => this.cycle.drive())
  }
  private fail(error: Error): void {
    let observed = error
    try {
      assertTarget(this.run.state.target)
    } catch (drift) {
      observed = drift instanceof Error ? drift : normalize(drift)
    }
    const path = join(this.run.directory, 'failure.json')
    atomicWrite(path, diagnostic(observed))
    const interrupted = this.run.externalSignal.aborted
    const assignments = Object.fromEntries(
      Object.entries(this.run.state.assignments).map(([id, current]) => [
        id,
        ['running', 'claimed', 'checking'].includes(current.stage)
          ? { ...current, stage: 'interrupted' as const }
          : current,
      ]),
    )
    this.run.save({
      status: interrupted || pause(observed) ? 'paused' : 'failed',
      assignments,
    })
  }
  async restoreManaged(state: RunState, retained = false): Promise<void> {
    if (!this.run.managed) throw new RunError('not-managed', this.run.directory)
    const checkpoint = readBound(state, 'recovery')
    if (!checkpointSchema.check(checkpoint))
      throw new RunError('invalid-checkpoint', this.run.directory)
    inspectRecoveryTarget(state, checkpoint)
    await inspectRecoveryAttempts(
      { state, definition: this.run.request.definition },
      checkpoint,
    )
    inspectRecoveryReview(state, checkpoint)
    assertEvidence(checkpoint.controls)
    assertEvidence(checkpoint.contributions.flatMap((item) => item.artifacts))
    this.restoreRun(state, checkpoint)
    if (retained) return
    if (checkpoint.phase === 'integration')
      this.run.retainedAssignments.add(this.run.integrationId)
    this.run.recovering = true
    this.run.save({ status: 'running' })
  }
  invalidateForUpstream(amended = false, affected?: readonly string[]): void {
    if (
      !['succeeded', 'needs-author', 'paused'].includes(this.run.state.status)
    )
      throw new RunError('upstream-not-admissible', this.run.directory)
    const changed = new Set(
      affected ?? Object.keys(this.run.request.definition.nodes),
    )
    const assignments = { ...this.run.state.assignments }
    for (const id of changed) {
      const prior = assignments[id]
      if (prior) assignments[id] = { ...prior, stage: 'ready' }
      this.run.acceptedNodes.delete(id)
    }
    if (changed.size > 0) {
      const integrator = assignments[this.run.integrationId]
      if (integrator?.stage === 'interrupted')
        assignments[this.run.integrationId] = { ...integrator, stage: 'ready' }
    }
    const reviewer = assignments[this.run.reviewId]
    if (reviewer?.stage === 'interrupted')
      assignments[this.run.reviewId] = { ...reviewer, stage: 'ready' }
    this.run.sessions.delete(this.run.reviewId)
    this.invalidateCycle(
      changed.size === 0 && Boolean(this.run.checkpoint.accepted),
    )
    this.run.recovering = true
    this.run.save({
      status: 'running',
      target: this.run.managed ? this.run.owner.target : this.run.state.target,
      assignments,
      cycle: null,
    })
    if (amended) this.freeze(true)
  }
  private invalidateCycle(retain: boolean): void {
    if (retain) {
      const {
        combined: _combined,
        handoff: _handoff,
        receipts: _receipts,
        verdict: _verdict,
        ...retained
      } = this.run.checkpoint
      this.run.checkpoint = {
        ...retained,
        reviewed: undefined,
        phase: ['staged-checks', 'apply'].includes(this.run.checkpoint.phase)
          ? 'staged-checks'
          : ['checks', 'review', 'decision'].includes(this.run.checkpoint.phase)
            ? 'checks'
            : this.run.checkpoint.phase,
      }
      return
    }
    for (const [id, node] of this.run.acceptedNodes) {
      const { preparation: _preparation, ...retained } = node
      this.run.acceptedNodes.set(id, retained)
    }
    this.run.preparations.clear()
    this.run.preparationRecords.clear()
    this.run.finalPreparation = undefined
    this.run.checkpoint = {
      phase: 'worker',
      contributions: this.run.checkpoint.contributions,
      controls: this.run.checkpoint.controls,
    }
  }
  async repairFromOverall(verdict: ReviewReport): Promise<void> {
    if (!this.run.managed || this.run.state.status !== 'succeeded')
      throw new RunError('repair-not-admissible', this.run.directory)
    this.run.checkpoint = {
      ...this.run.checkpoint,
      phase: 'decision',
      verdict: JSON.stringify(verdict),
    }
    this.run.save({ status: 'running', target: this.run.owner.target })
    await this.cycle.review.decisionStep()
    if (this.run.checkpoint.phase === 'repair') this.cycle.review.repairStep()
    this.run.recovering = true
  }
  private async observe(action: () => Promise<void>): Promise<RunResult> {
    try {
      await action()
    } catch (value) {
      this.fail(normalize(value))
    }
    return { runDirectory: this.run.directory, state: this.run.state }
  }
  async executeWorkers(): Promise<RunResult> {
    return await this.observe(async () => {
      if (!this.run.recovering) this.freeze()
      while (
        this.run.state.status === 'running' &&
        this.run.checkpoint.phase === 'worker'
      ) {
        this.run.request.signal.throwIfAborted()
        await this.cycle.produceStep()
      }
    })
  }
  async executeCycle(): Promise<RunResult> {
    if (!this.run.managed)
      throw new RunError('cycle-ownership', this.run.directory)
    return await this.observe(async () => {
      this.run.state = { ...this.run.state, target: this.run.owner.target }
      this.run.save()
      if (
        this.run.parallel &&
        !this.run.finalPreparation &&
        this.run.checkpoint.phase === 'integration' &&
        !this.run.checkpoint.progress
      )
        await this.cycle.frontier.prepareFinal()
      await this.cycle.drive()
    })
  }
  async execute(): Promise<RunResult> {
    return await this.observe(async () => {
      this.freeze()
      await this.cycle.drive()
    })
  }
}
