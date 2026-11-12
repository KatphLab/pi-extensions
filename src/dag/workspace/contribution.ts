import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { type CommandIdentity, commandClaim } from '@dag/command.js'
import { isWithin } from '@dag/files.js'
import { identifyTarget, type TargetIdentity } from '@dag/state.js'
import {
  acceptedInput,
  bindAcceptance,
  fileIdentity,
  preparedTargets,
  reconciliationMerges,
  verifyInput,
} from './capabilities.js'
import { ContributionChecks } from './checks.js'
import type {
  AcceptedContribution,
  Candidate,
  ContributionRequest,
  IntegrationAuthorization,
  ReviewedHandoffRequest,
  WorktreeRequest,
} from './types.js'
import {
  artifacts,
  assertRetainedValidation,
  assertTarget,
  git,
  literal,
  names,
  persist,
  prepareWorktree,
  revision,
  scopedPaths,
  settled,
  snapshot,
  WorkspaceError,
  workspaceFailure,
} from './workspace.js'

class ContributionAcceptance {
  constructor(
    private readonly request: ContributionRequest,
    private readonly resource: string,
  ) {}

  private producerClaim(): void {
    const { request } = this
    const producer = request.producer
    if (!producer) return
    const { identity } = request
    if (
      producer.cwd !== fs.realpathSync(request.worktree) ||
      producer.identity.runId !== identity.runId ||
      producer.identity.assignment !== identity.assignment ||
      producer.identity.attempt !== identity.attempt ||
      producer.identity.revision !== request.baseline ||
      commandClaim(producer).outcome !== 'claimed-complete'
    )
      throw new WorkspaceError('producer-failed', producer.receipt)
  }
  private preflight(): void {
    const { request } = this
    const { target, identity, baseline, artifacts: output, runner } = request
    names({ ...identity, baseline, role: 'assignment' })
    if (identity.revision !== baseline)
      throw new WorkspaceError('stale-baseline', baseline)
    assertTarget(target)
    revision(target.root, baseline)
    const worker = identifyTarget(request.worktree)
    if (
      worker.root === target.root ||
      worker.commonDirectory !== target.commonDirectory ||
      worker.root !==
        fs.realpathSync(
          git(request.worktree, ['rev-parse', '--show-toplevel']).trim(),
        )
    )
      throw new WorkspaceError('worker-identity', request.worktree)
    settled(request.worktree)
    if (isWithin(worker.root, runner) || isWithin(worker.root, output))
      throw new WorkspaceError('evidence-in-worktree', runner)
    for (const path of request.write) literal(path)
    if (
      new Set(request.checks.map((entry) => entry.id)).size !==
      request.checks.length
    )
      throw new WorkspaceError('duplicate-check', runner)
    this.producerClaim()
    if (request.signal.aborted) throw new WorkspaceError('interrupted', runner)
  }
  private prepareCandidate(): Candidate {
    const { request } = this
    const { target, identity, baseline } = request
    const tree = snapshot(request.worktree, baseline)
    const changedPaths = scopedPaths(request, tree)
    const acceptedArtifacts = artifacts(request.artifacts, request.outputs)
    const candidate = git(
      request.worktree,
      [
        '-c',
        'user.name=DAG runner',
        '-c',
        'user.email=dag@localhost',
        'commit-tree',
        tree,
        '-p',
        baseline,
      ],
      {
        input: `DAG candidate ${identity.runId}/${identity.assignment}/${identity.attempt}\n`,
      },
    ).trim()
    git(target.root, [
      'update-ref',
      `${refPrefix(identity)}/candidate`,
      candidate,
      '0'.repeat(candidate.length),
    ])
    const validationWorktree = prepareWorktree(target, {
      ...identity,
      baseline: candidate,
      role: 'validation',
    })
    const result: Candidate = Object.freeze({
      baseline,
      revision: candidate,
      tree,
      changedPaths,
      validationWorktree,
      artifacts: Object.freeze(acceptedArtifacts),
    })
    const record = join(request.runner, 'candidate.json')
    persist(record, { ...result, checks: request.checks })
    if (request.durable)
      request.durable.write({
        ...request.durable.read(),
        candidate: fileIdentity(record),
      })
    return result
  }
  private retainedCandidate(): Candidate {
    const { request } = this
    const { target, identity, baseline, runner } = request
    const ref = `${refPrefix(identity)}/candidate`
    const saved = git(target.root, [
      'for-each-ref',
      '--format=%(objectname)',
      ref,
    ]).trim()
    const path = join(runner, 'candidate.json')
    const validationWorktree = join(
      target.root,
      '.pi/dags/wt',
      identity.runId,
      `${identity.assignment}-${identity.attempt}-validation`,
    )
    if (!saved) {
      if (
        request.durable?.read().candidate ||
        fs.existsSync(path) ||
        fs.existsSync(validationWorktree)
      )
        throw new WorkspaceError('missing-candidate', path)
      return this.prepareCandidate()
    }
    const tree = snapshot(request.worktree, baseline)
    const candidate: Candidate = {
      baseline,
      revision: saved,
      tree,
      changedPaths: scopedPaths(request, tree),
      validationWorktree,
      artifacts: artifacts(request.artifacts, request.outputs),
    }
    if (
      git(target.root, ['rev-list', '--parents', '-1', saved]).trim() !==
        `${saved} ${baseline}` ||
      git(target.root, ['rev-parse', `${saved}^{tree}`]).trim() !== tree
    )
      throw new WorkspaceError('changed-candidate', ref)
    assertRetainedValidation(target, validationWorktree)
    new ContributionChecks(request, candidate).assertFixed()
    this.assertCandidateRecord(candidate, path)
    return candidate
  }
  private assertCandidateRecord(candidate: Candidate, path: string): void {
    const { request } = this
    const record = { ...candidate, checks: request.checks }
    if (fs.existsSync(path)) {
      if (
        fs.realpathSync(path) !== path ||
        !fs.lstatSync(path).isFile() ||
        fs.readFileSync(path, 'utf8') !== `${JSON.stringify(record, null, 2)}\n`
      )
        throw new WorkspaceError('changed-candidate', path)
    } else throw new WorkspaceError('missing-candidate', path)
    const expected = request.durable?.read().candidate
    if (
      expected &&
      JSON.stringify(fileIdentity(path)) !== JSON.stringify(expected)
    )
      throw new WorkspaceError('changed-candidate', path)
    if (!expected && request.durable)
      throw new WorkspaceError('uncertain-candidate', path)
  }
  private recoverPublication(
    candidate: Candidate,
    receipts: readonly string[],
  ): AcceptedContribution {
    const { request } = this
    const path = join(request.runner, 'accepted.json')
    const expected: AcceptedContribution = {
      ...candidate,
      receipts: [...receipts],
      acceptedRef: `${refPrefix(request.identity)}/accepted`,
      receipt: path,
      handoff: join(request.runner, 'accepted-handoff.md'),
    }
    if (!fs.existsSync(path)) {
      if (
        fs.existsSync(expected.handoff) ||
        git(request.target.root, [
          'for-each-ref',
          '--format=%(objectname)',
          expected.acceptedRef,
        ]).trim()
      )
        throw new WorkspaceError('incomplete-publication', path)
      if (request.durable?.read().publishing)
        throw new WorkspaceError('incomplete-publication', path)
      return this.publish(candidate, receipts)
    }
    if (
      fs.realpathSync(path) !== path ||
      !fs.lstatSync(path).isFile() ||
      fs.readFileSync(path, 'utf8') !== `${JSON.stringify(expected, null, 2)}\n`
    )
      throw new WorkspaceError('changed-acceptance', path)
    const handoff = `Outcome: accepted\nRevision: ${expected.revision}\nTree: ${expected.tree}\nBaseline: ${expected.baseline}\nReceipt: ${expected.receipt}\nArtifacts: ${expected.artifacts.map((entry) => entry.path).join(', ')}\nChecks: ${expected.receipts.join(', ')}\n`
    if (
      !fs.existsSync(expected.handoff) ||
      fs.realpathSync(expected.handoff) !== expected.handoff ||
      fs.readFileSync(expected.handoff, 'utf8') !== handoff ||
      git(request.target.root, [
        'for-each-ref',
        '--format=%(objectname)',
        expected.acceptedRef,
      ]).trim() !== expected.revision
    )
      throw new WorkspaceError('incomplete-publication', expected.receipt)
    bindAcceptance(expected, request.write)
    return expected
  }
  private publish(
    candidate: Candidate,
    receipts: readonly string[],
  ): AcceptedContribution {
    const { request } = this
    const result: AcceptedContribution = Object.freeze({
      ...candidate,
      receipts: Object.freeze([...receipts]),
      acceptedRef: `${refPrefix(request.identity)}/accepted`,
      receipt: join(request.runner, 'accepted.json'),
      handoff: join(request.runner, 'accepted-handoff.md'),
    })
    if (request.durable)
      request.durable.write({ ...request.durable.read(), publishing: true })
    persist(result.receipt, result)
    fs.writeFileSync(
      result.handoff,
      `Outcome: accepted\nRevision: ${result.revision}\nTree: ${result.tree}\nBaseline: ${result.baseline}\nReceipt: ${result.receipt}\nArtifacts: ${result.artifacts.map((entry) => entry.path).join(', ')}\nChecks: ${result.receipts.join(', ')}\n`,
      { flag: 'wx', mode: 0o600 },
    )
    git(request.target.root, [
      'update-ref',
      result.acceptedRef,
      result.revision,
      '0'.repeat(result.revision.length),
    ])
    bindAcceptance(result, request.write)
    return result
  }
  async accept(): Promise<AcceptedContribution> {
    const canonical = this.request
    const runner = canonical.runner
    let candidate: Candidate | null = null
    try {
      this.preflight()
      candidate = canonical.resume
        ? this.retainedCandidate()
        : this.prepareCandidate()
      const receipts = await new ContributionChecks(canonical, candidate).run()
      return canonical.resume
        ? this.recoverPublication(candidate, receipts)
        : this.publish(candidate, receipts)
    } catch (error) {
      const failure = workspaceFailure(error, 'acceptance', this.resource)
      persist(join(runner, `rejected-${randomUUID()}.json`), {
        code: failure.code,
        resource: failure.resource,
        diagnostic:
          failure.cause instanceof Error ? failure.cause.message : null,
        candidate,
        receipts: (canonical.resumable
          ? fs
              .readdirSync(runner)
              .filter((entry) => entry.startsWith('check-'))
              .map((entry) => join(runner, entry))
          : [runner]
        )
          .filter((directory) => fs.existsSync(directory))
          .flatMap((directory) =>
            fs
              .readdirSync(directory)
              .filter((entry) => entry.startsWith('command-'))
              .map((entry) => join(directory, entry, 'receipt.json'))
              .filter((receipt) => fs.existsSync(receipt)),
          ),
      })
      throw failure
    }
  }
}

/** No worker HEAD/history or on-disk success claim can establish acceptance. */
export async function acceptContribution(
  request: ContributionRequest,
): Promise<AcceptedContribution> {
  const runner = fs.realpathSync(request.runner)
  const artifactRoot = fs.realpathSync(request.artifacts)
  if (isWithin(artifactRoot, runner) || isWithin(runner, artifactRoot))
    throw new WorkspaceError('overlapping-evidence', runner)
  const canonical = {
    ...request,
    worktree: fs.realpathSync(request.worktree),
    artifacts: artifactRoot,
    runner,
  }
  return await new ContributionAcceptance(canonical, request.worktree).accept()
}

function refPrefix(identity: CommandIdentity): string {
  return `refs/pi-dags/${identity.runId}/${identity.assignment}/${identity.attempt}`
}

function prepareHandoffWorktree(
  request: ReviewedHandoffRequest,
  paths: readonly string[],
  recovering: boolean,
): { readonly worktree: string; readonly retained: boolean } {
  const { target, branch, final, identity } = request
  const expected = join(
    target.root,
    '.pi/dags/wt',
    identity.runId,
    `${identity.assignment}-${identity.attempt}-assignment`,
  )
  const retained = recovering && fs.existsSync(expected)
  const progress = request.durable?.read()
  if (
    recovering &&
    !retained &&
    (progress?.worktreeStarted ||
      progress?.candidate ||
      progress?.started.length ||
      progress?.publishing ||
      fs.lstatSync(expected, { throwIfNoEntry: false }) ||
      git(target.root, ['worktree', 'list', '--porcelain', '-z'])
        .split('\0')
        .includes(`worktree ${expected}`) ||
      fs.existsSync(join(request.runner, 'candidate.json')) ||
      git(target.root, [
        'for-each-ref',
        '--format=%(objectname)',
        `${refPrefix(identity)}/candidate`,
      ]).trim())
  )
    throw new WorkspaceError('missing-worktree', expected)
  if (!retained && request.durable)
    request.durable.write({ ...request.durable.read(), worktreeStarted: true })
  const worktree = retained
    ? expected
    : prepareWorktree(target, {
        ...identity,
        baseline: branch.revision,
        role: 'assignment',
      })
  if (retained) verifyRetainedHandoff(request, worktree, paths)
  else if (paths.length > 0)
    git(worktree, [
      'restore',
      '--source',
      final.revision,
      '--staged',
      '--worktree',
      '--',
      ...paths,
    ])
  return { worktree, retained }
}
function verifyRetainedHandoff(
  request: Pick<ContributionRequest, 'target' | 'write'> & {
    readonly branch: AcceptedContribution
    readonly final: AcceptedContribution
  },
  worktree: string,
  paths: readonly string[],
): void {
  const { target, branch, final, write } = request
  const current = identifyTarget(worktree)
  if (
    fs.realpathSync(worktree) !== worktree ||
    current.root !== worktree ||
    current.commonDirectory !== target.commonDirectory ||
    current.expectedRevision !== branch.revision
  )
    throw new WorkspaceError('changed-worktree', worktree)
  settled(worktree)
  const tree = snapshot(worktree, branch.revision)
  if (
    !fs
      .lstatSync(
        git(worktree, [
          'rev-parse',
          '--path-format=absolute',
          '--git-path',
          'index',
        ]).trim(),
        { throwIfNoEntry: false },
      )
      ?.isFile() ||
    git(worktree, [
      'diff',
      '--cached',
      '--name-only',
      '--no-renames',
      '-z',
      tree,
      '--',
    ]) !== '' ||
    scopedPaths({ worktree, baseline: branch.revision, write }, tree).some(
      (path) => !paths.includes(path),
    ) ||
    paths.some(
      (path) =>
        git(worktree, ['ls-tree', '-z', tree, '--', path]) !==
        git(worktree, ['ls-tree', '-z', final.revision, '--', path]),
    )
  )
    throw new WorkspaceError('changed-worktree', worktree)
}
/** Reapply only this cycle's reviewed target delta onto its logical code ancestry. */
export function acceptReviewedHandoff(
  request: ReviewedHandoffRequest,
  recovering = false,
): Promise<AcceptedContribution> {
  const { target, branch, final, preparation, identity, write } = request
  verifyInput(target, acceptedInput(branch))
  verifyInput(target, acceptedInput(final))
  const merged = preparation.reconciliation?.contribution
  if (preparation.reconciliation)
    verifyInput(target, preparation.reconciliation)
  const previous = merged
    ? git(target.root, ['rev-list', '--parents', '-1', merged.baseline])
        .trim()
        .split(' ')[1]
    : final.baseline
  if (!previous || target.expectedRevision !== final.revision)
    throw new WorkspaceError('reviewed-handoff-input', final.receipt)
  git(target.root, ['merge-base', '--is-ancestor', previous, final.revision])
  git(target.root, [
    'merge-base',
    '--is-ancestor',
    branch.revision,
    final.revision,
  ])
  const changed = git(target.root, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    previous,
    final.revision,
  ])
    .split('\0')
    .filter(Boolean)
  const paths = [...new Set([...branch.changedPaths, ...changed])].filter(
    (path) =>
      git(target.root, ['ls-tree', '-z', branch.revision, '--', path]) !== '' ||
      git(target.root, ['ls-tree', '-z', final.revision, '--', path]) !== '',
  )
  for (const path of changed) {
    literal(path)
    if (
      !write.some((scope) =>
        scope.endsWith('/') ? path.startsWith(scope) : path === scope,
      )
    )
      throw new WorkspaceError('out-of-scope', path)
  }
  const { worktree, retained } = prepareHandoffWorktree(
    request,
    paths,
    recovering,
  )
  return acceptContribution({
    ...request,
    worktree,
    baseline: branch.revision,
    identity: { ...identity, revision: branch.revision },
    resumable: true,
    resume: recovering && retained,
  })
}

function integrationInput(
  target: TargetIdentity,
  contribution: AcceptedContribution,
  authorization?: IntegrationAuthorization,
): void {
  if (
    git(target.root, ['rev-parse', contribution.acceptedRef]).trim() !==
      contribution.revision ||
    git(target.root, [
      'rev-parse',
      `${contribution.revision}^{tree}`,
    ]).trim() !== contribution.tree ||
    git(target.root, [
      'rev-list',
      '--parents',
      '-1',
      contribution.revision,
    ]).trim() !== `${contribution.revision} ${contribution.baseline}`
  )
    throw new WorkspaceError('integration-input', contribution.receipt)
  // The accepted bundle must still hash to its evidence even when no live
  // integration authorization is supplied.
  verifyInput(target, acceptedInput(contribution))
  if (authorization) {
    verifyPreparedIntegration(target, contribution, authorization)
  } else if (contribution.baseline !== target.expectedRevision) {
    throw new WorkspaceError('integration-input', contribution.receipt)
  }
}
function verifyPreparedIntegration(
  target: TargetIdentity,
  contribution: AcceptedContribution,
  authorization: IntegrationAuthorization,
): void {
  const { prerequisites, write } = authorization
  if (
    preparedTargets.get(prerequisites) !== JSON.stringify(target) ||
    (contribution.revision !== prerequisites.revision &&
      contribution.baseline !== prerequisites.revision)
  )
    throw new WorkspaceError('integration-input', contribution.receipt)
  const inputs = [
    ...prerequisites.inputs,
    ...(prerequisites.reconciliation ? [prerequisites.reconciliation] : []),
    acceptedInput(contribution),
  ]
  for (const input of inputs) verifyInput(target, input)
  git(target.root, [
    'merge-base',
    '--is-ancestor',
    target.expectedRevision,
    prerequisites.revision,
  ])
  git(target.root, [
    'merge-base',
    '--is-ancestor',
    prerequisites.revision,
    contribution.revision,
  ])
  const accepted = new Set(inputs.map((input) => input.contribution.revision))
  // Every imported commit must be an evidenced canonical acceptance or a runner-created merge.
  for (const commit of git(target.root, [
    'rev-list',
    `${target.expectedRevision}..${contribution.revision}`,
  ])
    .trim()
    .split('\n')
    .filter(Boolean))
    if (!accepted.has(commit) && !reconciliationMerges.has(commit))
      throw new WorkspaceError('untrusted-integration-history', commit)
  for (const path of write) literal(path)
  scopedPaths(
    { worktree: target.root, baseline: target.expectedRevision, write },
    contribution.tree,
  )
}

/** Stage an accepted snapshot; descendant preparation requires explicit runner authorization. */
export function prepareIntegration(
  target: TargetIdentity,
  contribution: AcceptedContribution,
  request: WorktreeRequest,
  authorization?: IntegrationAuthorization,
): string {
  assertTarget(target)
  if (request.baseline !== target.expectedRevision)
    throw new WorkspaceError('integration-input', contribution.receipt)
  integrationInput(target, contribution, authorization)
  const worktree = prepareWorktree(target, request)
  git(worktree, [
    'merge',
    '--ff-only',
    '--no-edit',
    '--no-overwrite-ignore',
    contribution.revision,
  ])
  assertTarget(target)
  return worktree
}

/** The only target write: checked fast-forward, with no reset, force or adoption of drift. */
export function applyIntegration(
  target: TargetIdentity,
  contribution: AcceptedContribution,
  authorization?: IntegrationAuthorization,
  onApplied?: (target: TargetIdentity) => void,
): TargetIdentity {
  assertTarget(target)
  integrationInput(target, contribution, authorization)
  git(target.root, [
    'merge-base',
    '--is-ancestor',
    target.expectedRevision,
    contribution.revision,
  ])
  git(target.root, [
    'merge',
    '--ff-only',
    '--no-edit',
    '--no-overwrite-ignore',
    contribution.revision,
  ])
  const updated = { ...target, expectedRevision: contribution.revision }
  onApplied?.(updated)
  assertTarget(updated)
  return updated
}

/** Recognize a completed runner fast-forward only at its exact clean intended identity. */
export function recoverAppliedIntegration(
  target: TargetIdentity,
  contribution: AcceptedContribution,
  authorization?: IntegrationAuthorization,
): TargetIdentity {
  const updated = { ...target, expectedRevision: contribution.revision }
  assertTarget(updated)
  integrationInput(target, contribution, authorization)
  git(target.root, [
    'merge-base',
    '--is-ancestor',
    target.expectedRevision,
    contribution.revision,
  ])
  // Observe the checkout directly: a live target authority must not stand in
  // for proof that the accepted revision was actually applied.
  const observed = identifyTarget(target.root)
  if (
    observed.expectedRevision !== contribution.revision ||
    observed.branch !== target.branch
  )
    throw new WorkspaceError('unapplied-integration', contribution.receipt)
  return updated
}
