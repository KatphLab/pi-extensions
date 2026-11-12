import * as fs from 'node:fs'
import { join } from 'node:path'
import { attemptLayout } from '@dag/state.js'
import { ContributionChecks } from '@dag/workspace/checks.js'
import { acceptReviewedHandoff } from '@dag/workspace/contribution.js'
import type {
  AcceptedContribution,
  ContributionRequest,
} from '@dag/workspace/types.js'
import { assertTarget, captureTarget } from '@dag/workspace/workspace.js'
import { assertEvidence, type Checkpoint, fileIdentity } from './checkpoint.js'
import { hash, normalize, pause, type RunContext } from './context.js'
import { RunError } from './error.js'
import type { RunExecution } from './execution.js'

export class RunChecks {
  constructor(
    private readonly run: RunContext,
    private readonly execution: RunExecution,
  ) {}
  private prepareChecks(cwd: string) {
    const id = this.run.automaticId('combined-checks')
    const pinned = captureTarget(cwd)
    const tree = this.run.revisionTree(pinned.expectedRevision)
    const checks = this.reviewedHandoffChecks(
      this.run.state.assignments[this.run.base.id]?.attempts.at(-1)?.artifacts,
    )
    const checkIdentity = hash(JSON.stringify(checks))
    const current = this.run.state.assignments[id]
    const previous = this.run.checkpoint.combined
    const resumed =
      previous !== undefined &&
      ['interrupted', 'checking'].includes(current?.stage ?? '') &&
      previous.revision === pinned.expectedRevision &&
      previous.worktree === cwd &&
      previous.checks === checkIdentity
    const number = resumed ? previous.number : (current?.attempts.length ?? 0)
    const layout = attemptLayout(this.run.directory, id, number)
    const identity = {
      number,
      revision: pinned.expectedRevision,
      tree,
      worktree: cwd,
      checks: checkIdentity,
    }
    if (resumed) {
      const { progress: _progress, ...saved } = previous
      if (JSON.stringify(saved) !== JSON.stringify(identity))
        throw new RunError('changed-check', layout.runner)
    }
    const combined: NonNullable<Checkpoint['combined']> = resumed
      ? previous
      : {
          ...identity,
          progress: {
            started: [],
            observations: {},
            repeat: {},
            completed: {},
          },
        }
    this.run.checkpoint = { ...this.run.checkpoint, combined }
    const continuing = resumed && current?.attempts.at(-1)?.number === number
    this.run.assignment(id, {
      stage: 'checking',
      retries: 0,
      attempts: continuing
        ? current.attempts
        : [
            ...(current?.attempts ?? []),
            {
              number,
              baseline: pinned.expectedRevision,
              worktree: cwd,
              ...layout,
              inputs: { checks: identity.checks },
              receipts: [],
            },
          ],
    })
    return { id, layout, pinned, checks, resumed, combined }
  }
  async checks(
    accepted: AcceptedContribution,
    cwd = this.run.state.target.root,
  ): Promise<readonly string[]> {
    this.run.request.signal.throwIfAborted()
    const prepared = this.prepareChecks(cwd)
    const { id, layout, pinned, checks, resumed } = prepared
    let { combined } = prepared
    const identities = this.run
      .currentContributions()
      .flatMap((entry) => entry.artifacts)
    assertTarget(pinned)
    assertEvidence(identities)
    const receipts = await new ContributionChecks(
      {
        target: this.run.state.target,
        worktree: cwd,
        baseline: pinned.expectedRevision,
        identity: {
          runId: this.run.request.runId,
          assignment: id,
          attempt: combined.number,
          revision: pinned.expectedRevision,
        },
        ...layout,
        checks,
        write: [],
        outputs: [],
        signal: this.run.request.signal,
        resumable: true,
        resume: resumed,
        durable: this.execution.durableChecks(
          id,
          () => combined.progress,
          (progress) => {
            combined = { ...combined, progress }
            this.run.checkpoint = { ...this.run.checkpoint, combined }
            this.run.save()
          },
        ),
      },
      {
        baseline: pinned.expectedRevision,
        revision: pinned.expectedRevision,
        tree: combined.tree,
        validationWorktree: cwd,
        changedPaths: [],
        artifacts: [],
      },
    )
      .run()
      .catch((value: unknown) => {
        const error = normalize(value)
        if (!this.run.request.signal.aborted && !pause(error))
          this.run.stage(id, 'failed')
        throw error
      })
    assertTarget(pinned)
    assertEvidence([...identities, ...accepted.artifacts])
    this.run.controls.push(
      ...receipts.flatMap((receipt) => [
        fileIdentity(receipt),
        fileIdentity(join(receipt, '..', 'stdout.log')),
        fileIdentity(join(receipt, '..', 'stderr.log')),
      ]),
    )
    this.run.stage(id, 'accepted', { receipts: [...receipts] })
    return receipts
  }
  private reviewedHandoffChecks(
    artifacts?: string,
  ): ContributionRequest['checks'] {
    return [
      ...Object.entries(this.run.request.definition.nodes).flatMap(
        ([id, node]) =>
          node.verify.map((check) => {
            const evidence =
              this.run.state.assignments[id]?.attempts.at(-1)?.artifacts
            if (!evidence) throw new RunError('missing-artifacts', id)
            return {
              ...check,
              id: `${id}/${check.id}`,
              artifacts: evidence,
              artifactInputs: this.execution.artifactInputs(id),
            }
          }),
      ),
      ...this.run.request.definition.verify.map((check) => ({
        ...check,
        id: `dag/${check.id}`,
        ...(artifacts ? { artifacts } : {}),
      })),
    ]
  }
  private handoffLayout(number: number) {
    const retained = this.run.checkpoint.handoff
    if (!retained) {
      const root = join(
        this.run.directory,
        'evidence',
        this.run.automaticId('reviewed-handoff'),
        String(number),
      )
      return {
        artifacts: join(root, 'artifacts'),
        runner: join(root, 'runner'),
      }
    }
    for (const path of [retained.artifacts, retained.runner])
      if (
        !fs.existsSync(path) ||
        fs.realpathSync(path) !== path ||
        !fs.lstatSync(path).isDirectory()
      )
        throw new RunError('missing-reviewed-handoff', path)
    return { artifacts: retained.artifacts, runner: retained.runner }
  }
  private pinHandoff(
    handoff: Pick<
      NonNullable<Checkpoint['handoff']>,
      | 'branch'
      | 'final'
      | 'number'
      | 'worktree'
      | 'runner'
      | 'artifacts'
      | 'checks'
    >,
  ): void {
    if (this.run.checkpoint.handoff) {
      const {
        candidate: _candidate,
        started: _started,
        observations: _observations,
        repeat: _repeat,
        completed: _completed,
        publishing: _publishing,
        worktreeStarted: _worktreeStarted,
        unobserved: _unobserved,
        ...identity
      } = this.run.checkpoint.handoff
      if (JSON.stringify(identity) !== JSON.stringify(handoff))
        throw new RunError('changed-reviewed-handoff', handoff.runner)
      return
    }
    this.run.checkpoint = {
      ...this.run.checkpoint,
      handoff: {
        ...handoff,
        started: [],
        observations: {},
        repeat: {},
        completed: {},
      },
    }
    this.run.save()
    for (const path of [handoff.artifacts, handoff.runner])
      if (fs.lstatSync(path, { throwIfNoEntry: false }))
        throw new RunError('existing-reviewed-handoff', path)
    attemptLayout(
      this.run.directory,
      this.run.automaticId('reviewed-handoff'),
      handoff.number,
    )
  }
  private handoffProgress(
    id: string,
  ): NonNullable<ContributionRequest['durable']> {
    const saved = this.run.checkpoint.handoff
    if (!saved) throw new RunError('missing-reviewed-handoff', id)
    let handoff = saved
    return this.execution.durableChecks(
      id,
      () => handoff,
      (progress) => {
        handoff = { ...handoff, ...progress }
        this.run.checkpoint = { ...this.run.checkpoint, handoff }
        this.run.save()
      },
    )
  }
  async reviewedHandoff(accepted: AcceptedContribution): Promise<void> {
    if (!this.run.managed || this.run.writeScope.length === 0) return
    const branch = this.run.preparations.get(this.run.branchPreparationId)
    const final = this.run.preparations.get('final')
    const code = this.run.contributions.find(
      (item) => item.revision === branch?.revision,
    )
    if (!branch || !final || !code)
      throw new RunError('missing-reviewed-branch', this.run.directory)
    if (accepted.changedPaths.length === 0 && !final.reconciliation) return
    const number = this.run.reviewRound() - 1
    const layout = this.handoffLayout(number)
    const handoffId = this.run.automaticId('reviewed-handoff')
    const checks = this.reviewedHandoffChecks()
    const handoff = {
      branch: code.revision,
      final: accepted.revision,
      number,
      worktree: join(
        this.run.state.target.root,
        '.pi/dags/wt',
        this.run.request.runId,
        `${handoffId}-${number}-assignment`,
      ),
      runner: layout.runner,
      artifacts: layout.artifacts,
      checks: hash(JSON.stringify(checks)),
    }
    this.pinHandoff(handoff)
    if (this.run.checkpoint.reviewed) return
    const current = this.run.state.assignments[handoffId]
    const continuing = current?.attempts.at(-1)?.number === number
    this.run.assignment(handoffId, {
      stage: 'checking',
      retries: 0,
      attempts: continuing
        ? current.attempts
        : [
            ...(current?.attempts ?? []),
            {
              number,
              baseline: code.revision,
              worktree: handoff.worktree,
              ...layout,
              inputs: { checks: handoff.checks },
              receipts: [],
            },
          ],
    })
    const durable = this.handoffProgress(handoffId)
    const reviewed = await this.run.capacity.run(() => {
      this.run.request.signal.throwIfAborted()
      return acceptReviewedHandoff(
        {
          target: this.run.state.target,
          branch: code,
          final: accepted,
          preparation: final,
          identity: {
            runId: this.run.request.runId,
            assignment: handoffId,
            attempt: number,
            revision: code.revision,
          },
          write: this.run.writeScope,
          checks,
          outputs: [],
          ...layout,
          signal: this.run.request.signal,
          durable,
        },
        this.run.recovering,
      )
    })
    this.run.contributions.push(reviewed)
    this.run.checkpoint = { ...this.run.checkpoint, reviewed }
    this.run.stage(handoffId, 'accepted', {
      acceptedRevision: reviewed.revision,
      receipts: [...reviewed.receipts, reviewed.receipt],
    })
    this.run.save()
  }
}
