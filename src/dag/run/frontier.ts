import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { EffectiveAssignment } from '@dag/definition/schema.js'
import { readyFrontier } from '@dag/scheduler.js'
import { type AttemptState, atomicWrite, attemptLayout } from '@dag/state.js'
import { WorkerError } from '@dag/worker.js'
import { preparePrerequisites } from '@dag/workspace/prerequisites.js'
import type {
  Prerequisite,
  PrerequisiteBaseline,
  PrerequisiteProgress,
  PrerequisiteRequest,
} from '@dag/workspace/types.js'
import { fileIdentity } from './checkpoint.js'
import {
  automatic,
  diagnostic,
  normalize,
  pause,
  type RunContext,
} from './context.js'
import { RunError } from './error.js'
import { RunAttempt, type RunExecution } from './execution.js'

export class RunFrontier {
  constructor(
    private readonly run: RunContext,
    private readonly execution: RunExecution,
  ) {}
  private stageResolution(worktree: string): void {
    const staged = spawnSync('git', ['-C', worktree, 'add', '--update'], {
      env: { ...process.env, GIT_MASTER: '1' },
      encoding: 'utf8',
    })
    if (staged.status !== 0)
      throw new RunError('reconciliation-index', worktree, {
        cause: new Error(staged.stderr),
      })
  }
  private recordPreparation(
    id: string,
    result: PrerequisiteBaseline,
    runner: string,
  ): void {
    const record = fileIdentity(join(runner, 'prerequisites.json'))
    this.run.preparationRecords.set(id, record)
    this.run.preparations.set(id, result)
    this.run.controls.push(record)
    this.run.save()
  }
  private async reconcilePrepared(
    stage: Parameters<NonNullable<PrerequisiteRequest['reconcile']>>[0],
    context: {
      readonly id: string
      readonly number: number
      readonly reconciliations: string[]
    },
  ): Promise<void> {
    const profile = this.run.request.assignments.integration
    if (!profile) throw new RunError('missing-integrator', context.id)
    const assignment = automatic(this.run.base, {
      id: this.run.automaticId(
        `reconcile.${context.id}.${context.number}.${stage.index}`,
      ),
      profile,
      write: stage.write,
    })
    const previous = this.run.state.assignments[assignment.id]
    const restored = previous?.attempts.at(-1)
    const layout = attemptLayout(this.run.directory, assignment.id, 0)
    const attempt: AttemptState = restored ?? {
      number: 0,
      baseline: stage.baseline,
      worktree: stage.worktree,
      ...layout,
      inputs: Object.fromEntries(
        stage.inputs.map((input) => [
          input.contribution.acceptedRef,
          input.contribution.revision,
        ]),
      ),
      receipts: [],
    }
    if (restored) this.run.resumedAssignments.add(assignment.id)
    if (!context.reconciliations.includes(assignment.id))
      context.reconciliations.push(assignment.id)
    this.run.assignment(assignment.id, {
      stage: 'running',
      retries: previous?.retries ?? 0,
      attempts: previous?.attempts ?? [attempt],
    })
    await new RunAttempt(this.execution, assignment, attempt).produceAgent({
      prerequisites: stage.inputs.map((input) => ({
        revision: input.contribution.revision,
        handoff: input.contribution.handoff,
        artifacts: input.contribution.artifacts,
      })),
    })
    if (this.run.state.status !== 'running')
      throw new WorkerError('failed-claim', assignment.id)
    this.stageResolution(stage.worktree)
    this.run.stage(assignment.id, 'checking')
  }
  private preparationProgress(
    id: string,
    number: number,
    reconciliations: string[],
  ): NonNullable<PrerequisiteRequest['durable']> {
    const write = (progress: PrerequisiteProgress) => {
      this.run.checkpoint = {
        ...this.run.checkpoint,
        pendingPreparations: {
          ...this.run.checkpoint.pendingPreparations,
          [id]: { number, reconciliations, progress },
        },
      }
      this.run.save()
    }
    return {
      read: () => this.run.checkpoint.pendingPreparations?.[id]?.progress,
      write,
      repeat: (index, settled) => {
        const assignment = reconciliations.at(-1)
        const progress = this.run.checkpoint.pendingPreparations?.[id]?.progress
        if (!assignment || !progress)
          throw new RunError('incomplete-preparation', id)
        this.execution
          .durableChecks(
            assignment,
            () => progress.checks,
            (checks) => write({ ...progress, checks }),
          )
          .repeat(index, settled)
      },
    }
  }
  private importedPrerequisites(id: string): readonly Prerequisite[] {
    if (!this.run.managed) return []
    return id === 'final'
      ? this.run.managed.integrated()
      : this.run.managed.prerequisites
  }
  private async prepare(
    id: string,
    needs: readonly string[],
  ): Promise<PrerequisiteBaseline> {
    const pending = this.run.checkpoint.pendingPreparations?.[id]
    const number = pending?.number ?? this.run.preparationNumber++
    const preparationId = this.run.automaticId(`prerequisites.${id}`)
    const layout = attemptLayout(this.run.directory, preparationId, number)
    const reconciliations = pending?.reconciliations ?? []
    if (!pending) {
      this.run.checkpoint = {
        ...this.run.checkpoint,
        pendingPreparations: {
          ...this.run.checkpoint.pendingPreparations,
          [id]: { number, reconciliations },
        },
      }
      this.run.save()
    }
    const imported = this.importedPrerequisites(id)
    for (const entry of imported)
      if (
        !this.run.contributions.some(
          (item) => item.receipt === entry.input.contribution.receipt,
        )
      )
        this.run.contributions.push(entry.input.contribution)
    const result = await this.run.capacity
      .run(() =>
        preparePrerequisites({
          target: this.run.state.target,
          identity: {
            runId: this.run.request.runId,
            assignment: preparationId,
            attempt: number,
            revision: this.run.state.target.expectedRevision,
          },
          needs: [...needs, ...imported.map((entry) => entry.id)],
          accepted: [...this.run.acceptedNodes.values(), ...imported],
          ...(this.run.managed && id !== 'final'
            ? {
                emptyBaseline:
                  this.run.checkpoint.repairBase ??
                  this.run.state.target.launchRevision,
              }
            : {}),
          ...(id === 'final' &&
          (this.run.managed ||
            this.run.state.target.expectedRevision !==
              this.run.state.target.launchRevision)
            ? { targetTip: true }
            : {}),
          ...layout,
          signal: this.run.request.signal,
          durable: this.preparationProgress(id, number, reconciliations),
          reconcile: (stage) =>
            this.reconcilePrepared(stage, { id, number, reconciliations }),
        }),
      )
      .catch((value: unknown) => {
        const error = normalize(value)
        for (const assignment of reconciliations)
          this.run.stage(
            assignment,
            this.run.request.signal.aborted || pause(error)
              ? 'interrupted'
              : 'failed',
          )
        throw error
      })
    if (result.reconciliation) {
      this.run.contributions.push(result.reconciliation.contribution)
      this.run.controls.push(...result.reconciliation.evidence)
      for (const id of reconciliations)
        this.run.stage(id, 'accepted', {
          acceptedRevision: result.reconciliation.contribution.revision,
          receipts: [
            ...result.reconciliation.contribution.receipts,
            result.reconciliation.contribution.receipt,
          ],
        })
    }
    const { [id]: _completed, ...pendingPreparations } =
      this.run.checkpoint.pendingPreparations ?? {}
    this.run.checkpoint = { ...this.run.checkpoint, pendingPreparations }
    this.recordPreparation(id, result, layout.runner)
    return result
  }
  private interruptCancelled(id: string): void {
    const current = this.run.state.assignments[id]
    if (
      this.run.request.signal.aborted &&
      current &&
      ['running', 'claimed', 'checking'].includes(current.stage)
    )
      this.run.assignment(id, { ...current, stage: 'interrupted' })
  }
  private async dispatch(
    assignment: EffectiveAssignment,
  ): Promise<Error | undefined> {
    const id = assignment.id
    try {
      const prepared =
        this.run.preparations.get(id) ??
        (await this.prepare(id, assignment.node.needs))
      await this.execution.contribution(assignment, {
        goal: this.run.request.definition.goal,
        prerequisites: prepared.direct,
        feedback: this.run.checkpoint.repairs?.[id],
      })
    } catch (value) {
      const error = value instanceof Error ? value : normalize(value)
      if (this.run.state.status !== 'running') return undefined
      if (this.run.request.signal.aborted || pause(error)) return error
      atomicWrite(
        join(this.run.directory, `frontier-${id}-failure.json`),
        diagnostic(error),
      )
      const previous = this.run.state.assignments[id]
      this.run.assignment(id, {
        stage: 'failed',
        retries: previous?.retries ?? 0,
        attempts: previous?.attempts ?? [],
      })
    } finally {
      this.interruptCancelled(id)
    }
    return undefined
  }
  private startReady(
    active: Map<string, Promise<void>>,
    errors: Error[],
  ): void {
    const frontier = readyFrontier(
      this.run.request.definition.nodes,
      this.run.state.assignments,
    )
    for (const id of Object.keys(frontier.blocked)) {
      const current = this.run.state.assignments[id]
      this.run.assignment(id, {
        stage: 'blocked',
        retries: current?.retries ?? 0,
        attempts: current?.attempts ?? [],
      })
    }
    const interrupted = Object.entries(this.run.state.assignments)
      .filter(
        ([id, assignment]) =>
          Object.hasOwn(this.run.request.definition.nodes, id) &&
          assignment.stage === 'interrupted',
      )
      .map(([id]) => id)
    for (const id of [...interrupted, ...frontier.ready]) {
      if (active.has(id)) continue
      const assignment = this.run.request.assignments.nodes[id]
      if (!assignment) throw new RunError('missing-assignment', id)
      const pending = this.dispatch(assignment)
        .then((error) => {
          if (error) errors.push(error)
        })
        .finally(() => {
          active.delete(id)
        })
      active.set(id, pending)
    }
  }
  async frontier(): Promise<void> {
    const active = new Map<string, Promise<void>>()
    const errors: Error[] = []
    while (this.run.state.status === 'running') {
      if (errors.length === 0 && !this.run.request.signal.aborted)
        this.startReady(active, errors)
      if (active.size === 0) break
      await Promise.race(active.values())
      if (errors.length > 0 || this.run.state.status !== 'running')
        this.run.stopController.abort()
    }
    await Promise.all(active.values())
    await this.completeFrontier(errors[0])
  }
  private async completeFrontier(fatal: Error | undefined): Promise<void> {
    if (fatal) throw fatal
    if (this.run.state.status !== 'running') return
    this.run.request.signal.throwIfAborted()
    if (
      this.run.acceptedNodes.size !==
      Object.keys(this.run.request.definition.nodes).length
    ) {
      this.run.needsAuthor(
        'unaccepted-prerequisites',
        this.run.state.assignments,
      )
      return
    }
    if (this.run.managed) {
      if (!this.run.preparations.has(this.run.branchPreparationId))
        await this.prepare(
          this.run.branchPreparationId,
          Object.keys(this.run.request.definition.nodes),
        )
      if (!this.run.checkpoint.repairs) this.run.move('integration')
      else await this.prepareFinal()
    } else await this.prepareFinal()
  }
  async prepareFinal(): Promise<void> {
    this.run.cycle('integration')
    let prepared: PrerequisiteBaseline
    try {
      prepared = await this.prepare(
        'final',
        Object.keys(this.run.request.definition.nodes),
      )
    } catch (value) {
      const error = this.execution.retryable(
        value instanceof Error ? value : normalize(value),
      )
      this.run.needsAuthor(
        'final-prerequisite-reconciliation',
        diagnostic(error),
      )
      return
    }
    this.run.finalPreparation = prepared
    this.run.preparations.set(this.run.integrationId, prepared)
    const record = this.run.preparationRecords.get('final')
    if (!record) throw new RunError('missing-prerequisites', this.run.directory)
    this.run.preparationRecords.set(this.run.integrationId, record)
    const result = this.run.acceptedNodes.get(this.run.base.id)?.input
      .contribution
    if (!result) throw new RunError('missing-progress', this.run.directory)
    this.run.move('integration', {
      progress: {
        accepted: result,
        route: 'worker',
        feedback: JSON.stringify({ prerequisites: prepared.direct }),
      },
    })
  }
}
