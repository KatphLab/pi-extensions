import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { join } from 'node:path'
import type { TargetIdentity } from '@dag/state.js'
import {
  acceptedInput,
  preparedTargets,
  reconciliationMerges,
  sameCheckoutIdentity,
  sameFile,
  verifyInput,
} from './capabilities.js'
import { acceptContribution } from './contribution.js'
import type {
  AcceptedInput,
  HandoffProgress,
  Prerequisite,
  PrerequisiteBaseline,
  PrerequisiteProgress,
  PrerequisiteRequest,
} from './types.js'
import {
  assertRetainedValidation,
  assertTarget,
  git,
  persist,
  prepareWorktree,
  revision,
  scopedPaths,
  settled,
  snapshot,
  WorkspaceError,
  workspaceFailure,
} from './workspace.js'

function prerequisiteClosure(
  request: PrerequisiteRequest,
): readonly Prerequisite[] {
  const nodes = new Map(request.accepted.map((entry) => [entry.id, entry]))
  if (nodes.size !== request.accepted.length)
    throw new WorkspaceError('duplicate-input', request.runner)
  const visited = new Set<string>()
  const active = new Set<string>()
  const closure: Prerequisite[] = []
  const visit = (id: string): void => {
    if (active.has(id)) throw new WorkspaceError('cyclic-input', id)
    if (visited.has(id)) return
    const node = nodes.get(id)
    if (!node) throw new WorkspaceError('missing-input', id)
    active.add(id)
    for (const dependency of [...node.needs].sort((a, b) => a.localeCompare(b)))
      visit(dependency)
    active.delete(id)
    verifyInput(request.target, node.input)
    if (node.reviewVerdict && !sameFile(node.reviewVerdict))
      throw new WorkspaceError('stale-input-evidence', node.reviewVerdict.path)
    visited.add(id)
    closure.push(node)
  }
  for (const id of [...request.needs].sort((a, b) => a.localeCompare(b)))
    visit(id)
  return closure
}
/** Reduce code tips only. Reports remain in the closure even when their revision is represented. */
export function contributingTips(
  target: TargetIdentity,
  inputs: readonly AcceptedInput[],
  reviewedCode: ReadonlySet<string> = new Set(),
): readonly string[] {
  const revisions = [
    ...new Set(
      [...inputs]
        .sort((a, b) =>
          a.contribution.acceptedRef.localeCompare(b.contribution.acceptedRef),
        )
        .filter(
          (entry) =>
            entry.contribution.changedPaths.length > 0 ||
            reviewedCode.has(entry.contribution.revision),
        )
        .map((entry) => revision(target.root, entry.contribution.revision)),
    ),
  ]
  return Object.freeze(
    revisions.filter(
      (tip) =>
        !revisions.some(
          (other) =>
            tip !== other &&
            git(target.root, ['merge-base', tip, other]).trim() === tip,
        ),
    ),
  )
}
class PrerequisiteReconciliation {
  private readonly write: readonly string[]
  private readonly worktree: string
  private progress: PrerequisiteProgress
  private readonly reconcile: NonNullable<PrerequisiteRequest['reconcile']>

  constructor(
    private readonly request: PrerequisiteRequest,
    private readonly stage: {
      readonly closure: readonly Prerequisite[]
      readonly tips: readonly string[]
      readonly inputs: readonly AcceptedInput[]
    },
  ) {
    const { closure, tips } = stage
    const saved = request.durable?.read()
    this.progress =
      saved ??
      initialPrerequisiteProgress(tips, request.target.expectedRevision)
    if (!request.reconcile)
      throw new WorkspaceError('integrator-required', request.runner)
    this.reconcile = request.reconcile
    this.write = Object.freeze(
      [...new Set(closure.flatMap((node) => node.write))].sort((a, b) =>
        a.localeCompare(b),
      ),
    )
    this.worktree = saved
      ? this.restorePrerequisiteStage(saved)
      : prepareWorktree(request.target, {
          ...request.identity,
          baseline: this.progress.baseline,
          role: 'assignment',
        })
    if (!saved) this.save(this.progress)
  }

  private save(progress: PrerequisiteProgress): void {
    this.progress = progress
    this.request.durable?.write(progress)
  }

  private mergePrerequisite(tip: string, baseline: string): void {
    const { worktree } = this
    const pending = join(
      git(worktree, ['rev-parse', '--absolute-git-dir']).trim(),
      'MERGE_HEAD',
    )
    if (fs.existsSync(pending)) {
      if (fs.readFileSync(pending, 'utf8').trim() !== tip)
        throw new WorkspaceError('changed-preparation', worktree)
      return
    }
    settled(worktree)
    const tree = git(worktree, ['rev-parse', `${baseline}^{tree}`]).trim()
    if (
      snapshot(worktree, baseline) !== tree ||
      git(worktree, ['write-tree']).trim() !== tree
    )
      throw new WorkspaceError('changed-preparation', worktree)
    try {
      git(worktree, [
        '-c',
        'user.name=DAG runner',
        '-c',
        'user.email=dag@localhost',
        'merge',
        '--no-commit',
        '--no-ff',
        tip,
      ])
    } catch (error) {
      if (
        !(error instanceof WorkspaceError) ||
        !git(worktree, ['ls-files', '-u']).trim()
      )
        throw error
    }
  }
  private retainReconciliationMerge(
    commit: string,
    baseline: string,
    tip: string | undefined,
  ): string {
    const { request, write } = this
    if (
      !tip ||
      git(request.target.root, [
        'rev-list',
        '--parents',
        '-1',
        commit,
      ]).trim() !== `${commit} ${baseline} ${tip}`
    )
      throw new WorkspaceError('changed-preparation', request.runner)
    const tree = git(request.target.root, [
      'rev-parse',
      `${commit}^{tree}`,
    ]).trim()
    const scopeBase = request.targetTip
      ? request.target.expectedRevision
      : request.target.launchRevision
    scopedPaths(
      { worktree: request.target.root, baseline: scopeBase, write },
      tree,
    )
    reconciliationMerges.set(commit, { scopeBase, write })
    return tree
  }
  private restorePrerequisiteStage(progress: PrerequisiteProgress): string {
    const { request } = this
    const { tips } = this.stage
    if (
      JSON.stringify(progress.tips) !== JSON.stringify(tips) ||
      progress.next < 1 ||
      progress.next > tips.length ||
      progress.merges.length !== progress.next - 1 ||
      (progress.phase === 'checks') !== (progress.next === tips.length)
    )
      throw new WorkspaceError('changed-preparation', request.runner)
    let baseline = tips[0] ?? request.target.expectedRevision
    for (const [index, commit] of progress.merges.entries()) {
      this.retainReconciliationMerge(commit, baseline, tips[index + 1])
      baseline = commit
    }
    if (progress.baseline !== baseline)
      throw new WorkspaceError('changed-preparation', request.runner)
    const worktree = join(
      request.target.root,
      '.pi/dags/wt',
      request.identity.runId,
      `${request.identity.assignment}-${request.identity.attempt}-assignment`,
    )
    assertRetainedValidation(request.target, worktree)
    const head = git(worktree, ['rev-parse', 'HEAD']).trim()
    if (head !== progress.baseline && head !== progress.pending)
      throw new WorkspaceError('changed-worktree', worktree)
    return worktree
  }
  private applyReconciliationCommit(): PrerequisiteProgress {
    const { request, worktree, progress } = this
    const { pending, ...previous } = progress
    if (!pending)
      throw new WorkspaceError('changed-preparation', request.runner)
    settled(worktree)
    const tree = this.retainReconciliationMerge(
      pending,
      progress.baseline,
      progress.tips[progress.next],
    )
    if (snapshot(worktree, progress.baseline) !== tree)
      throw new WorkspaceError('changed-worktree', worktree)
    const head = git(worktree, ['rev-parse', 'HEAD']).trim()
    if (head !== pending)
      git(worktree, ['update-ref', 'HEAD', pending, progress.baseline])
    // The canonical commit includes every submitted byte before replacing its index.
    git(worktree, ['read-tree', pending])
    const next = progress.next + 1
    return {
      ...previous,
      baseline: pending,
      next,
      phase: next === progress.tips.length ? 'checks' : 'merge',
      merges: [...progress.merges, pending],
    }
  }
  private createReconciliationCommit(baseline: string, tip: string): string {
    const { request, worktree, write } = this
    if (git(worktree, ['ls-files', '-u']).trim())
      throw new WorkspaceError('unresolved-prerequisites', worktree)
    git(worktree, ['merge', '--quit'])
    const tree = snapshot(worktree, baseline)
    scopedPaths(
      {
        worktree,
        baseline: request.targetTip
          ? request.target.expectedRevision
          : request.target.launchRevision,
        write,
      },
      tree,
    )
    return git(
      worktree,
      [
        '-c',
        'user.name=DAG runner',
        '-c',
        'user.email=dag@localhost',
        'commit-tree',
        tree,
        '-p',
        baseline,
        '-p',
        tip,
      ],
      { input: 'DAG prerequisite reconciliation\n' },
    ).trim()
  }
  async run(): Promise<AcceptedInput> {
    const { request, worktree, write } = this
    const { closure, tips, inputs } = this.stage
    while (this.progress.phase !== 'checks') {
      const { baseline, next } = this.progress
      const tip = tips[next]
      if (!tip) throw new WorkspaceError('changed-preparation', request.runner)
      switch (this.progress.phase) {
        case 'merge':
          this.mergePrerequisite(tip, baseline)
          this.save({ ...this.progress, phase: 'reconcile' })
          break
        case 'reconcile':
          await this.reconcile.call(request, {
            index: next - 1,
            worktree,
            baseline,
            tips,
            write,
            inputs,
            signal: request.signal,
          })
          this.save({
            ...this.progress,
            phase: 'commit',
            pending: this.createReconciliationCommit(baseline, tip),
          })
          break
        case 'commit':
          this.save(this.applyReconciliationCommit())
          break
      }
    }
    const { durable, ...contributionRequest } = request
    const accepted = await acceptContribution({
      ...contributionRequest,
      worktree,
      baseline: this.progress.baseline,
      identity: { ...request.identity, revision: this.progress.baseline },
      write,
      outputs: [],
      ...(durable
        ? {
            resumable: true,
            resume: true,
            durable: {
              read: () => durable.read()?.checks ?? this.progress.checks,
              write: (checks: HandoffProgress) =>
                this.save({ ...this.progress, checks }),
              repeat: durable.repeat,
            },
          }
        : {}),
      checks: closure.flatMap((node) =>
        node.checks.map((check) => ({
          ...check,
          id: `${node.id}/${check.id}`,
          ...(node.artifacts ? { artifacts: node.artifacts } : {}),
        })),
      ),
    })
    return acceptedInput(accepted)
  }
}

function directHandoffs(
  closure: readonly Prerequisite[],
  needs: readonly string[],
): PrerequisiteBaseline['direct'] {
  return Object.freeze(
    closure
      .filter((node) => needs.includes(node.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => {
        const { revision, handoff, artifacts } = node.input.contribution
        return Object.freeze({
          id: node.id,
          revision,
          handoff,
          artifacts,
          ...(node.reviewVerdict ? { reviewVerdict: node.reviewVerdict } : {}),
        })
      }),
  )
}
function prerequisiteInputs(
  closure: readonly Prerequisite[],
  target: TargetIdentity,
): readonly AcceptedInput[] {
  return Object.freeze([
    ...new Map(
      closure
        .flatMap((node) => {
          const prepared = node.preparation
          if (
            prepared &&
            (!sameCheckoutIdentity(preparedTargets.get(prepared), target) ||
              node.input.contribution.baseline !== prepared.revision)
          )
            throw new WorkspaceError(
              'integration-input',
              node.input.contribution.receipt,
            )
          return [
            ...(prepared?.inputs ?? []),
            ...(prepared?.reconciliation ? [prepared.reconciliation] : []),
            node.input,
          ]
        })
        .map((input) => [input.contribution.revision, input]),
    ).values(),
  ])
}
/** Prepare code and evidence, never launch a session or coordinate workflow state. Failures retain the stage. */
export async function preparePrerequisites(
  request: PrerequisiteRequest,
): Promise<PrerequisiteBaseline> {
  try {
    assertTarget(request.target)
    if (request.signal.aborted)
      throw new WorkspaceError('interrupted', request.runner)
    const closure = prerequisiteClosure(request)
    const inputs = prerequisiteInputs(closure, request.target)
    for (const input of inputs) verifyInput(request.target, input)
    const reviewedCode = new Set(
      closure
        .filter((node) => node.reviewedCode === true)
        .map((node) => node.input.contribution.revision),
    )
    const codeTips = contributingTips(request.target, inputs, reviewedCode)
    const tips = request.targetTip
      ? [
          request.target.expectedRevision,
          ...codeTips.filter(
            (tip) =>
              git(request.target.root, [
                'merge-base',
                tip,
                request.target.expectedRevision,
              ]).trim() !== tip,
          ),
        ]
      : codeTips
    let baseline =
      tips[0] ?? request.emptyBaseline ?? request.target.expectedRevision
    let reconciliation: AcceptedInput | undefined
    if (tips.length > 1) {
      reconciliation = await new PrerequisiteReconciliation(request, {
        closure,
        tips,
        inputs,
      }).run()
      baseline = reconciliation.contribution.revision
    }
    for (const input of inputs) verifyInput(request.target, input)
    const direct = directHandoffs(closure, request.needs)
    const result = Object.freeze({
      revision: baseline,
      inputs,
      direct,
      ...(reconciliation ? { reconciliation } : {}),
    })
    persist(join(request.runner, 'prerequisites.json'), result)
    preparedTargets.set(result, JSON.stringify(request.target))
    return result
  } catch (error) {
    const failure = workspaceFailure(
      error,
      'prerequisite-evidence',
      request.runner,
    )
    persist(
      join(request.runner, `prerequisites-rejected-${randomUUID()}.json`),
      {
        code: failure.code,
        resource: failure.resource,
        diagnostic:
          failure.cause instanceof Error ? failure.cause.message : null,
      },
    )
    throw failure
  }
}

function initialPrerequisiteProgress(
  tips: readonly string[],
  baseline: string,
): PrerequisiteProgress {
  return {
    tips: [...tips],
    baseline: tips[0] ?? baseline,
    next: 1,
    phase: 'merge',
    merges: [],
    checks: { started: [], observations: {}, repeat: {}, completed: {} },
  }
}
