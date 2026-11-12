import { sep } from 'node:path'
import { isWithin } from '@dag/files.js'
import {
  type DagRunOwner,
  identifyTarget,
  type TargetIdentity,
} from '@dag/state.js'
import {
  arr,
  compile,
  int,
  map,
  obj,
  opt,
  str,
} from '@earendil-works/pi-schema'
import {
  acceptedEvidence,
  acceptedInput,
  acceptedScopes,
  preparedTargets,
  reconciliationMerges,
  sameFile,
  verifyInput,
} from './capabilities.js'
import type {
  AcceptedContribution,
  AcceptedInput,
  PrerequisiteBaseline,
} from './types.js'
import {
  assertTarget,
  git,
  revision,
  scopedPaths,
  WorkspaceError,
} from './workspace.js'

const checkpointText = str({ minLength: 1 })
const evidenceContract = obj({
  path: checkpointText,
  sha256: checkpointText,
  bytes: int({ minimum: 0 }),
})
export const acceptedContract = obj({
  baseline: checkpointText,
  revision: checkpointText,
  tree: checkpointText,
  changedPaths: arr(checkpointText),
  validationWorktree: checkpointText,
  artifacts: arr(evidenceContract),
  receipts: arr(checkpointText),
  acceptedRef: checkpointText,
  receipt: checkpointText,
  handoff: checkpointText,
})
const inputContract = obj({
  contribution: acceptedContract,
  evidence: arr(evidenceContract),
})
const preparationContract = obj({
  revision: checkpointText,
  inputs: arr(inputContract),
  direct: arr(
    obj({
      id: checkpointText,
      revision: checkpointText,
      handoff: checkpointText,
      artifacts: arr(evidenceContract),
      reviewVerdict: opt(evidenceContract),
    }),
  ),
  reconciliation: opt(inputContract),
})
export const workspaceCheckpointContract = obj({
  accepted: arr(obj({ input: inputContract, write: arr(checkpointText) })),
  preparations: map(
    obj({ baseline: preparationContract, targetRevision: checkpointText }),
  ),
  merges: arr(
    obj({
      revision: checkpointText,
      tree: checkpointText,
      parents: arr(checkpointText),
      scopeBase: checkpointText,
      write: arr(checkpointText),
    }),
  ),
})
interface WorkspaceCheckpoint {
  readonly accepted: readonly {
    readonly input: AcceptedInput
    readonly write: readonly string[]
  }[]
  readonly preparations: Readonly<
    Record<
      string,
      {
        readonly baseline: PrerequisiteBaseline
        readonly targetRevision: string
      }
    >
  >
  readonly merges: readonly {
    readonly revision: string
    readonly tree: string
    readonly parents: readonly string[]
    readonly scopeBase: string
    readonly write: readonly string[]
  }[]
}

/** Serialize only capabilities observed by this runner, never on-disk worker claims. */
export function checkpointWorkspace(
  target: TargetIdentity,
  resources: {
    readonly contributions: readonly AcceptedContribution[]
    readonly preparations: ReadonlyMap<string, PrerequisiteBaseline>
  },
): WorkspaceCheckpoint {
  const preparations = Object.fromEntries(
    [...resources.preparations].map(([id, baseline]) => {
      const identity = preparedTargets.get(baseline)
      if (!identity) throw new WorkspaceError('unobserved-preparation', id)
      const saved: unknown = JSON.parse(identity)
      if (
        typeof saved !== 'object' ||
        saved === null ||
        !('expectedRevision' in saved) ||
        typeof saved.expectedRevision !== 'string'
      )
        throw new WorkspaceError('unobserved-preparation', id)
      return [id, { baseline, targetRevision: saved.expectedRevision }]
    }),
  )
  const reachable = new Set(
    resources.contributions.length === 0
      ? []
      : git(target.root, [
          'rev-list',
          ...resources.contributions.map((item) => item.revision),
          '--not',
          target.launchRevision,
        ])
          .trim()
          .split('\n')
          .filter(Boolean),
  )
  return {
    accepted: resources.contributions.map((contribution) => {
      const write = acceptedScopes.get(contribution)
      if (!write)
        throw new WorkspaceError('unobserved-acceptance', contribution.receipt)
      return { input: acceptedInput(contribution), write: [...write] }
    }),
    preparations,
    merges: [...reconciliationMerges]
      .filter(([commit]) => reachable.has(commit))
      .map(([commit, scope]) => ({
        scopeBase: scope.scopeBase,
        write: [...scope.write],
        revision: commit,
        tree: git(target.root, ['rev-parse', `${commit}^{tree}`]).trim(),
        parents: git(target.root, ['rev-list', '--parents', '-1', commit])
          .trim()
          .split(' ')
          .slice(1),
      })),
  }
}

function validateCheckpointAcceptance(
  target: TargetIdentity,
  saved: WorkspaceCheckpoint['accepted'][number],
  directory: string,
): void {
  const { input, write } = saved
  const contribution = input.contribution
  const parts = directory.split(sep)
  const runId =
    parts.at(-2) === 'dags' ? `${parts.at(-3)}.${parts.at(-1)}` : parts.at(-1)
  if (
    !contribution.acceptedRef.startsWith(`refs/pi-dags/${runId}/`) ||
    !contribution.acceptedRef.endsWith('/accepted') ||
    !isWithin(directory, contribution.receipt) ||
    !contribution.receipt.includes(`${sep}runner${sep}`) ||
    input.evidence.some((entry) => !isWithin(directory, entry.path))
  )
    throw new WorkspaceError('checkpoint-provenance', contribution.receipt)
  verifyInput(target, input)
  if (
    git(target.root, [
      'rev-list',
      '--parents',
      '-1',
      contribution.revision,
    ]).trim() !== `${contribution.revision} ${contribution.baseline}`
  )
    throw new WorkspaceError('integration-input', contribution.receipt)
  const observed = scopedPaths(
    {
      worktree: contribution.validationWorktree,
      baseline: contribution.baseline,
      write,
    },
    contribution.tree,
  )
  if (JSON.stringify(observed) !== JSON.stringify(contribution.changedPaths))
    throw new WorkspaceError('integration-input', contribution.receipt)
  const validation = identifyTarget(contribution.validationWorktree)
  if (
    validation.commonDirectory !== target.commonDirectory ||
    validation.expectedRevision !== contribution.revision ||
    git(validation.root, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
    ]) !== ''
  )
    throw new WorkspaceError(
      'changed-worktree',
      contribution.validationWorktree,
    )
  assertTarget(validation)
}
function validateCheckpointMerge(
  target: TargetIdentity,
  merge: WorkspaceCheckpoint['merges'][number],
  trusted: ReadonlySet<string>,
): void {
  if (
    merge.scopeBase !== target.launchRevision &&
    !trusted.has(merge.scopeBase)
  )
    throw new WorkspaceError('untrusted-integration-history', merge.scopeBase)
  if (
    merge.parents.length < 2 ||
    git(target.root, ['rev-list', '--parents', '-1', merge.revision]).trim() !==
      [merge.revision, ...merge.parents].join(' ') ||
    git(target.root, ['rev-parse', `${merge.revision}^{tree}`]).trim() !==
      merge.tree
  )
    throw new WorkspaceError('untrusted-integration-history', merge.revision)
  scopedPaths(
    { worktree: target.root, baseline: merge.scopeBase, write: merge.write },
    merge.tree,
  )
}
function validateCheckpointPreparation(
  target: TargetIdentity,
  baseline: PrerequisiteBaseline,
  contributions: ReadonlyMap<string, AcceptedContribution>,
): void {
  for (const input of [
    ...baseline.inputs,
    ...(baseline.reconciliation ? [baseline.reconciliation] : []),
  ]) {
    verifyInput(target, input)
    if (
      JSON.stringify(contributions.get(input.contribution.receipt)) !==
      JSON.stringify(input.contribution)
    )
      throw new WorkspaceError(
        'checkpoint-provenance',
        input.contribution.receipt,
      )
  }
  for (const direct of baseline.direct) {
    const input = baseline.inputs.find(
      (entry) => entry.contribution.revision === direct.revision,
    )
    if (
      !input ||
      direct.handoff !== input.contribution.handoff ||
      JSON.stringify(direct.artifacts) !==
        JSON.stringify(input.contribution.artifacts) ||
      (direct.reviewVerdict !== undefined && !sameFile(direct.reviewVerdict))
    )
      throw new WorkspaceError('checkpoint-provenance', direct.id)
  }
}
function validateCheckpointHistory(
  target: TargetIdentity,
  trusted: ReadonlySet<string>,
  preparations: ReadonlyMap<string, PrerequisiteBaseline>,
): void {
  for (const commit of [
    ...trusted,
    ...[...preparations.values()].map((entry) => entry.revision),
  ]) {
    git(target.root, [
      'merge-base',
      '--is-ancestor',
      target.launchRevision,
      commit,
    ])
    for (const ancestor of git(target.root, [
      'rev-list',
      `${target.launchRevision}..${commit}`,
    ])
      .trim()
      .split('\n')
      .filter(Boolean))
      if (!trusted.has(ancestor))
        throw new WorkspaceError('untrusted-integration-history', ancestor)
  }
}
function validateImportedAcceptance(
  target: TargetIdentity,
  entry: WorkspaceCheckpoint['accepted'][number],
  previous: AcceptedInput,
): void {
  if (
    JSON.stringify(previous) !== JSON.stringify(entry.input) ||
    JSON.stringify(acceptedScopes.get(previous.contribution)) !==
      JSON.stringify(entry.write)
  )
    throw new WorkspaceError(
      'checkpoint-provenance',
      entry.input.contribution.receipt,
    )
  verifyInput(target, previous)
}
/** Read a runner checkpoint by bound identity before restoring any process-local trust. */
export function restoreWorkspace(
  owner: DagRunOwner,
  imported: readonly AcceptedInput[] = [],
  importedMerges: readonly string[] = [],
) {
  const { state, path, value } = owner.recoveryCheckpoint()
  const target = state.target
  const schema = compile(
    obj({ workspace: workspaceCheckpointContract }, { open: true }),
  )
  if (!schema.check(value)) throw new WorkspaceError('invalid-checkpoint', path)
  const saved = value.workspace
  const contributions = new Map<string, AcceptedContribution>()
  // Validate the entire batch before granting capabilities. No partial restore on failure.
  for (const entry of saved.accepted) {
    const previous = imported.find(
      (input) =>
        input.contribution.receipt === entry.input.contribution.receipt,
    )
    if (previous) validateImportedAcceptance(target, entry, previous)
    else if (!isWithin(owner.runDirectory, entry.input.contribution.receipt))
      throw new WorkspaceError(
        'checkpoint-provenance',
        entry.input.contribution.receipt,
        {
          cause: new Error(
            `Reviewed imports: ${imported.map((item) => item.contribution.receipt).join(', ')}`,
          ),
        },
      )
    else validateCheckpointAcceptance(target, entry, owner.runDirectory)
    contributions.set(
      entry.input.contribution.receipt,
      entry.input.contribution,
    )
  }
  const trusted = new Set([
    ...saved.accepted.map(({ input }) => input.contribution.revision),
    ...imported.map((input) => input.contribution.revision),
    ...importedMerges,
  ])
  for (const merge of saved.merges) {
    validateCheckpointMerge(target, merge, trusted)
    trusted.add(merge.revision)
  }
  const preparations = new Map<string, PrerequisiteBaseline>()
  for (const [id, { baseline, targetRevision }] of Object.entries(
    saved.preparations,
  )) {
    validateCheckpointPreparation(target, baseline, contributions)
    revision(target.root, targetRevision)
    preparations.set(id, baseline)
  }
  validateCheckpointHistory(target, trusted, preparations)
  for (const { input, write } of saved.accepted) {
    acceptedEvidence.set(input.contribution, input.evidence)
    acceptedScopes.set(input.contribution, write)
  }
  for (const entry of Object.values(saved.preparations)) {
    preparedTargets.set(
      entry.baseline,
      JSON.stringify({ ...target, expectedRevision: entry.targetRevision }),
    )
  }
  for (const merge of saved.merges)
    reconciliationMerges.set(merge.revision, {
      scopeBase: merge.scopeBase,
      write: merge.write,
    })
  return {
    contributions,
    preparations,
    inputs: saved.accepted.map((entry) => entry.input),
    merges: saved.merges.map((entry) => entry.revision),
  }
}
