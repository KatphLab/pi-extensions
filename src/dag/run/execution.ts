import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  type ArtifactInput,
  type CommandObservation,
  executeCommand,
} from '@dag/command.js'
import { validateReferences } from '@dag/definition/definition.js'
import {
  type EffectiveAssignment,
  parseWorkerReport,
  type WorkerReport,
} from '@dag/definition/schema.js'
import { reportPaths } from '@dag/policy.js'
import { type AttemptState, atomicWrite, attemptLayout } from '@dag/state.js'
import { createWorker, WorkerError } from '@dag/worker.js'
import { acceptedInput } from '@dag/workspace/capabilities.js'
import {
  acceptContribution,
  prepareIntegration,
} from '@dag/workspace/contribution.js'
import type {
  AcceptedContribution,
  ContributionRequest,
  HandoffProgress,
  PrerequisiteBaseline,
} from '@dag/workspace/types.js'
import {
  assertTarget,
  prepareWorktree,
  WorkspaceError,
} from '@dag/workspace/workspace.js'
import { fileIdentity } from './checkpoint.js'
import {
  diagnostic,
  hash,
  normalize,
  pause,
  pendingRestart,
  type RunContext,
} from './context.js'
import { RunError } from './error.js'

function safeCitation(root: string, path: string): boolean {
  const delta = relative(root, path)
  return (
    delta !== '' &&
    !isAbsolute(delta) &&
    delta !== '..' &&
    !delta.startsWith(`..${sep}`) &&
    !delta.split(sep).some((part) => ['.git', 'runner'].includes(part)) &&
    !delta.startsWith('.pi/dags/')
  )
}
export class RunExecution {
  constructor(readonly run: RunContext) {}
  artifactInputs(id: string): readonly ArtifactInput[] {
    return (this.run.preparations.get(id)?.direct ?? []).flatMap((source) =>
      source.artifacts.map((artifact) => ({
        assignment: source.id,
        path: relative(
          join(dirname(source.handoff), '..', 'artifacts'),
          artifact.path,
        ),
        artifact,
      })),
    )
  }
  retryable(error: Error): Error {
    if (this.run.request.signal.aborted || pause(error)) throw error
    return error
  }
  contribution(
    assignment: EffectiveAssignment,
    context: unknown,
    seed?: AcceptedContribution,
  ): Promise<AcceptedContribution | undefined> {
    return this.run.capacity.run(() =>
      new RunAssignment(this, assignment, seed).execute(context),
    )
  }
  durableChecks(
    id: string,
    read: () => HandoffProgress,
    write: (progress: HandoffProgress) => void,
  ): NonNullable<ContributionRequest['durable']> {
    return {
      read,
      write,
      repeat: (index, settled) => {
        const decision = pendingRestart(this.run.state, id)
        if (decision?.effect !== 'repeat-command')
          throw new WorkspaceError('uncertain-check', id)
        const checkpoint = this.run.state.snapshots['recovery']
        if (!checkpoint) throw new RunError('missing-checkpoint', id)
        write({
          ...read(),
          repeat: {
            ...read().repeat,
            [index]: settled ?? fileIdentity(checkpoint),
          },
        })
        this.run.consumeRestart(decision)
      },
    }
  }
  acceptNode(
    assignment: EffectiveAssignment,
    result: AcceptedContribution,
    prepared: PrerequisiteBaseline | undefined,
  ): void {
    const id = assignment.id
    const previous = this.run.acceptedNodes.get(id)
    const attempt = this.run.state.assignments[id]?.attempts.at(-1)
    if (!attempt) throw new RunError('missing-attempt', id)
    this.run.acceptedNodes.set(id, {
      id,
      needs: assignment.node.needs,
      write: assignment.node.write,
      checks: assignment.node.verify.map((check) => ({
        ...check,
        artifactInputs: this.artifactInputs(id),
      })),
      artifacts: attempt.artifacts,
      input: acceptedInput(result),
      ...(prepared && attempt.baseline === prepared.revision
        ? { preparation: prepared }
        : {}),
    })
    if (
      previous &&
      (previous.input.contribution.revision !== result.revision ||
        JSON.stringify(previous.input.contribution.artifacts) !==
          JSON.stringify(result.artifacts))
    )
      this.invalidateConsumers(id)
  }
  invalidateConsumers(producer: string): void {
    const changed = new Set([producer])
    // Walk the authored acyclic graph to a fixed point, independent of map order.
    let added = true
    while (added) {
      added = false
      for (const [id, node] of Object.entries(
        this.run.request.definition.nodes,
      )) {
        if (!changed.has(id) && node.needs.some((need) => changed.has(need))) {
          changed.add(id)
          added = true
        }
      }
    }
    for (const id of changed) {
      if (id === producer) continue
      const current = this.run.state.assignments[id]
      if (!current) continue
      this.run.acceptedNodes.delete(id)
      this.run.preparations.delete(id)
      this.run.preparationRecords.delete(id)
      this.run.assignment(id, { ...current, stage: 'ready' })
    }
  }
}
class RunAssignment {
  private readonly run: RunContext
  constructor(
    private readonly execution: RunExecution,
    private readonly assignment: EffectiveAssignment,
    private readonly seed?: AcceptedContribution,
  ) {
    this.run = execution.run
  }
  private replaceResources(attempt: AttemptState): AttemptState {
    const { assignment, seed } = this
    const identity = {
      runId: this.run.request.runId,
      assignment: `${assignment.id}.restart-${this.run.state.restarts?.length ?? 0}`,
      attempt: attempt.number,
      baseline: attempt.baseline,
      role: 'assignment' as const,
    }
    const worktree = seed
      ? prepareIntegration(this.run.state.target, seed, identity)
      : prepareWorktree(this.run.state.target, identity)
    const {
      sessionId: _id,
      sessionPath: _path,
      report: _report,
      candidateRevision: _candidate,
      acceptedRevision: _accepted,
      ...retained
    } = attempt
    this.run.sessions.delete(assignment.id)
    this.run.resumedAssignments.delete(assignment.id)
    this.run.clearAcceptance(assignment.id)
    return {
      ...retained,
      ...attemptLayout(this.run.directory, identity.assignment, attempt.number),
      worktree,
      inputs: { ...attempt.inputs, executionAssignment: identity.assignment },
      receipts: [],
    }
  }
  private recoverAttempt(): AttemptState | undefined {
    const { assignment } = this
    if (!this.run.recovering) return undefined
    const current = this.run.state.assignments[assignment.id]
    const attempt = current?.attempts.at(-1)
    if (!current || !attempt || current.stage !== 'interrupted')
      return undefined
    if (
      pendingRestart(this.run.state, assignment.id)?.effect !==
      'replace-resources'
    )
      this.run.resumedAssignments.add(assignment.id)
    const decision = pendingRestart(this.run.state, assignment.id)
    const restored =
      decision?.effect === 'replace-resources'
        ? this.replaceResources(attempt)
        : attempt
    if (
      decision &&
      (decision.effect === 'replace-resources' ||
        !this.run.checkpoint.acceptances?.[assignment.id]?.progress.candidate)
    )
      this.run.consumeRestart(decision)
    this.run.assignment(assignment.id, {
      ...current,
      stage: 'running',
      attempts: [...current.attempts.slice(0, -1), restored],
    })
    return restored
  }
  private admit(): AttemptState | undefined {
    const { assignment } = this
    this.run.request.signal.throwIfAborted()
    assertTarget(this.run.state.target)
    const recovered = this.recoverAttempt()
    if (recovered) return recovered
    const previous = this.run.state.assignments[assignment.id]
    const number = previous?.attempts.length ?? 0
    const retry =
      previous !== undefined &&
      (assignment.id !== this.run.integrationId || previous.stage === 'failed')
    if (
      retry &&
      previous.retries >= this.run.request.definition.limits.nodeRetries
    ) {
      if (
        this.run.parallel &&
        !this.run.checkpoint.repairs &&
        Object.hasOwn(this.run.request.definition.nodes, assignment.id)
      )
        return undefined
      this.run.needsAuthor('node-retries-exhausted', {
        assignment: assignment.id,
        retries: previous.retries,
      })
      return undefined
    }
    if (assignment.id === this.run.integrationId) this.run.cycle('integration')
    const attempt = this.prepareAttempt(number)
    this.run.clearAcceptance(assignment.id)
    this.run.assignment(assignment.id, {
      stage: 'running',
      retries: (previous?.retries ?? 0) + Number(retry),
      attempts: [...(previous?.attempts ?? []), attempt],
    })
    return attempt
  }
  private repairBaseline(prepared: string | undefined): string {
    const id = this.assignment.id
    const baseline = prepared ?? this.run.state.target.expectedRevision
    if (!this.run.checkpoint.repairs?.[id] || !prepared) return baseline
    if (this.run.managed && this.run.request.definition.nodes[id])
      return prepared
    const ancestry = spawnSync(
      'git',
      [
        '-C',
        this.run.state.target.root,
        'merge-base',
        '--is-ancestor',
        this.run.state.target.expectedRevision,
        baseline,
      ],
      {
        env: { ...process.env, GIT_MASTER: '1' },
        encoding: 'utf8',
      },
    )
    if (ancestry.status === 1) return this.run.state.target.expectedRevision
    if (ancestry.status !== 0)
      throw new RunError('repair-baseline', id, {
        cause: ancestry.error ?? new Error(ancestry.stderr),
      })
    return baseline
  }
  private prepareAttempt(number: number): AttemptState {
    const { assignment, seed } = this
    const prepared = this.run.preparations.get(assignment.id)
    const preparationRecord = this.run.preparationRecords.get(assignment.id)
    if (prepared && !preparationRecord)
      throw new RunError('missing-prerequisites', assignment.id)
    const baseline = this.repairBaseline(prepared?.revision)
    const layout = attemptLayout(this.run.directory, assignment.id, number)
    const identity = {
      runId: this.run.request.runId,
      assignment: assignment.id,
      attempt: number,
      baseline,
      role: 'assignment' as const,
    }
    const worktree = seed
      ? prepareIntegration(this.run.state.target, seed, identity)
      : prepareWorktree(this.run.state.target, identity)
    const attempt = {
      number,
      baseline,
      worktree,
      definitionIdentity: hash(JSON.stringify(assignment)),
      inputIdentities: Object.fromEntries(
        (prepared?.direct ?? []).map((input) => [input.id, input.revision]),
      ),
      ...layout,
      inputs:
        prepared && preparationRecord
          ? {
              prerequisites: preparationRecord.path,
              revision: prepared.revision,
              evidence: hash(
                JSON.stringify(prepared.direct.map((input) => input.artifacts)),
              ),
            }
          : seed
            ? { contribution: seed.revision, handoff: seed.handoff }
            : {},
      receipts: [],
    }
    return attempt
  }
  private retainedContribution(): AcceptedContribution | undefined {
    const id = this.assignment.id
    const previous = this.run.state.assignments[id]
    if (
      this.run.retainedAssignments.delete(id) &&
      previous?.stage === 'accepted'
    ) {
      const accepted = this.run.contributions.findLast(
        (item) => item.revision === previous.attempts.at(-1)?.acceptedRevision,
      )
      if (!accepted) throw new RunError('missing-accepted-contribution', id)
      return accepted
    }

    return undefined
  }
  async execute(context: unknown): Promise<AcceptedContribution | undefined> {
    const { assignment } = this
    const retained = this.retainedContribution()
    if (retained) return retained
    let failure = context
    while (this.run.state.status === 'running') {
      const attempt = this.admit()
      if (!attempt) return undefined
      const executionAttempt = new RunAttempt(
        this.execution,
        assignment,
        attempt,
      )
      try {
        const producer = await executionAttempt.produce(failure)
        if (this.run.state.status !== 'running') return undefined
        return await executionAttempt.accept(producer)
      } catch (value) {
        const error = this.execution.retryable(
          value instanceof Error ? value : normalize(value),
        )
        const path = join(attempt.runner, 'failure.json')
        atomicWrite(path, diagnostic(error))
        this.run.stage(assignment.id, 'failed')
        failure = {
          failure: path,
          diagnostic: Object.fromEntries(
            Object.entries(diagnostic(error)).map(([key, value]) => [
              key,
              value?.slice(0, 2048) ?? null,
            ]),
          ),
          context,
        }
      }
    }
    return undefined
  }
}
export class RunAttempt {
  private readonly run: RunContext
  constructor(
    private readonly execution: RunExecution,
    private readonly assignment: EffectiveAssignment,
    private readonly attempt: AttemptState,
  ) {
    this.run = execution.run
  }
  private recoveredClaim() {
    const { assignment, attempt } = this
    if (!this.run.resumedAssignments.has(assignment.id)) return
    const reportPath = join(attempt.artifacts, 'outcome.json')
    const handoffPath = join(attempt.artifacts, 'handoff.md')
    if (!fs.existsSync(reportPath) || !fs.existsSync(handoffPath)) return
    const handoff = fs.readFileSync(handoffPath, 'utf8')
    if (!handoff.trim()) throw new RunError('invalid-handoff', handoffPath)
    const report = parseWorkerReport(fs.readFileSync(reportPath, 'utf8'))
    for (const path of reportPaths(report)) {
      const absolute = resolve(
        assignment.node.outputs.includes(path)
          ? attempt.artifacts
          : attempt.worktree,
        path,
      )
      const physical = fs.realpathSync(absolute)
      if (
        ![attempt.worktree, attempt.artifacts].some((root) =>
          [absolute, physical].every((candidate) =>
            safeCitation(root, candidate),
          ),
        )
      )
        throw new RunError('invalid-claim-evidence', path)
    }
    return { role: 'worker' as const, report, reportPath, handoffPath }
  }
  async produce(context: unknown): Promise<CommandObservation | undefined> {
    const { assignment, attempt } = this
    if (this.run.checkpoint.acceptances?.[assignment.id]?.progress.candidate)
      return undefined
    await validateReferences(assignment.node, attempt.worktree)
    switch (assignment.node.kind) {
      case 'agent':
        return this.produceAgent(context)
      case 'command': {
        const result = await executeCommand({
          argv: assignment.node.argv,
          cwd: attempt.worktree,
          ...attempt,
          identity: {
            runId: this.run.request.runId,
            assignment: attempt.inputs['executionAssignment'] ?? assignment.id,
            attempt: attempt.number,
            revision: attempt.baseline,
          },
          outputs: assignment.node.outputs,
          signal: this.run.request.signal,
          artifactInputs: this.execution.artifactInputs(assignment.id),
        })
        this.run.controls.push(
          ...[result.receipt, result.stdout, result.stderr].map(fileIdentity),
        )
        this.run.stage(assignment.id, 'claimed', {
          receipts: [...attempt.receipts, result.receipt],
        })
        return result
      }
      default:
        throw new RunError('invalid-node', assignment.node satisfies never)
    }
  }
  private continuation() {
    const { assignment, attempt } = this
    const saved = this.run.sessions.get(assignment.id)
    if (!saved) return {}
    if (
      this.run.resumedAssignments.has(assignment.id) &&
      saved.cwd === attempt.worktree
    )
      return { reopen: saved }
    return { continuation: saved }
  }
  private processClaim(claim: {
    readonly report: WorkerReport
    readonly reportPath: string
    readonly handoffPath: string
  }): void {
    const { assignment } = this
    this.run.controls.push(
      fileIdentity(claim.reportPath),
      fileIdentity(claim.handoffPath),
    )
    this.run.stage(assignment.id, 'claimed', { report: claim.reportPath })
    if (
      claim.report.findings.some((finding) => finding.needsAuthor) ||
      claim.report.evidence.some(
        (item) => !Object.hasOwn(assignment.criteria, item.criterion),
      )
    ) {
      this.run.needsAuthor('worker-new-scope', claim.report)
      return
    }
    switch (claim.report.outcome) {
      case 'claimed-complete':
        return
      case 'blocked':
      case 'failed':
        throw new WorkerError('failed-claim', claim.report.summary)
      default:
        throw new RunError(
          'invalid-outcome',
          claim.report.outcome satisfies never,
        )
    }
  }
  async produceAgent(context: unknown): Promise<undefined> {
    const { assignment, attempt } = this
    const worker = await createWorker({
      cwd: attempt.worktree,
      artifacts: attempt.artifacts,
      artifactInputs: this.execution.artifactInputs(assignment.id),
      sessionsDirectory: join(this.run.directory, 'sessions'),
      agentDirectory: join(this.run.directory, 'agent'),
      runtime: this.run.request.runtime,
      assignment,
      role: 'worker',
      ...this.continuation(),
    })
    this.run.sessions.set(assignment.id, worker.identity)
    this.run.stage(assignment.id, 'running', {
      sessionId: worker.identity.id,
      sessionPath: worker.identity.path,
    })
    try {
      const claim =
        this.recoveredClaim() ??
        (await worker.prompt(
          JSON.stringify({
            stage: assignment.id,
            baseline: attempt.baseline,
            cwd: attempt.worktree,
            artifacts: attempt.artifacts,
            continuation: this.run.sessions.get(assignment.id),
            context,
            previousAttempts: this.run.state.assignments[
              assignment.id
            ]?.attempts.slice(0, -1),
          }),
          this.run.request.signal,
        ))
      if (claim.role !== 'worker')
        throw new RunError('unexpected-review', assignment.id)
      this.processClaim(claim)
      return undefined
    } finally {
      await worker.close()
    }
  }
  async accept(
    producer: CommandObservation | undefined,
  ): Promise<AcceptedContribution> {
    const { assignment, attempt } = this
    await validateReferences(assignment.node, attempt.worktree)
    this.run.stage(assignment.id, 'checking')
    const previous = this.run.checkpoint.acceptances?.[assignment.id]
    const resumed = this.run.resumedAssignments.has(assignment.id)
    let acceptance = previous ?? {
      number: attempt.number,
      progress: { started: [], observations: {}, repeat: {}, completed: {} },
    }
    if (!previous) {
      this.run.checkpoint = {
        ...this.run.checkpoint,
        acceptances: {
          ...this.run.checkpoint.acceptances,
          [assignment.id]: acceptance,
        },
      }
      this.run.save()
    }
    const durable = this.execution.durableChecks(
      assignment.id,
      () => acceptance.progress,
      (progress) => {
        acceptance = { number: attempt.number, progress }
        this.run.checkpoint = {
          ...this.run.checkpoint,
          acceptances: {
            ...this.run.checkpoint.acceptances,
            [assignment.id]: acceptance,
          },
        }
        this.run.save()
      },
    )
    const accepted = await acceptContribution({
      target: this.run.state.target,
      worktree: attempt.worktree,
      baseline: attempt.baseline,
      identity: {
        runId: this.run.request.runId,
        assignment: attempt.inputs['executionAssignment'] ?? assignment.id,
        attempt: attempt.number,
        revision: attempt.baseline,
      },
      write: assignment.node.write,
      outputs: assignment.node.outputs,
      artifactInputs: this.execution.artifactInputs(assignment.id),
      checks: assignment.node.verify,
      artifacts: attempt.artifacts,
      runner: attempt.runner,
      signal: this.run.request.signal,
      resumable: true,
      resume: resumed,
      durable,
      ...(producer ? { producer } : {}),
    })
    this.run.contributions.push(accepted)
    this.run.controls.push(
      ...[accepted.receipt, accepted.handoff, ...accepted.receipts].map(
        fileIdentity,
      ),
    )
    if (Object.hasOwn(this.run.request.definition.nodes, assignment.id)) {
      const prepared = this.run.preparations.get(assignment.id)
      if (this.run.parallel && !prepared)
        throw new RunError('missing-prerequisites', assignment.id)
      this.execution.acceptNode(assignment, accepted, prepared)
    }
    this.run.stage(assignment.id, 'accepted', {
      acceptedRevision: accepted.revision,
      candidateRevision: accepted.revision,
      receipts: [
        ...attempt.receipts,
        ...(producer ? [producer.receipt] : []),
        ...accepted.receipts,
        accepted.receipt,
      ],
    })
    return accepted
  }
}
