import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { dirname, join } from 'node:path'
import type { ArtifactIdentity } from '@dag/command.js'
import type { TargetIdentity } from '@dag/state.js'
import type {
  AcceptedContribution,
  AcceptedInput,
  PrerequisiteBaseline,
} from './types.js'
import { git, WorkspaceError } from './workspace.js'
export const acceptedScopes = new WeakMap<
  AcceptedContribution,
  readonly string[]
>()
export const acceptedEvidence = new WeakMap<
  AcceptedContribution,
  readonly ArtifactIdentity[]
>()
export function fileIdentity(path: string): ArtifactIdentity {
  const bytes = fs.readFileSync(path)
  if (!fs.lstatSync(path).isFile() || fs.realpathSync(path) !== path)
    throw new WorkspaceError('invalid-evidence', path)
  return Object.freeze({
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}
/** Only a live runner acceptance can mint an input; restored inputs require a trusted checkpoint. */
export function acceptedInput(
  contribution: AcceptedContribution,
): AcceptedInput {
  const evidence = acceptedEvidence.get(contribution)
  if (!evidence)
    throw new WorkspaceError('unobserved-acceptance', contribution.receipt)
  return Object.freeze({ contribution, evidence })
}
export const preparedTargets = new WeakMap<PrerequisiteBaseline, string>()
export const reconciliationMerges = new Map<
  string,
  { readonly scopeBase: string; readonly write: readonly string[] }
>()
export function bindAcceptance(
  result: AcceptedContribution,
  write: readonly string[],
): void {
  acceptedScopes.set(result, Object.freeze([...write]))
  acceptedEvidence.set(
    result,
    Object.freeze([
      ...result.artifacts,
      ...[
        result.receipt,
        result.handoff,
        ...result.receipts.flatMap((receipt) => [
          receipt,
          join(dirname(receipt), 'stdout.log'),
          join(dirname(receipt), 'stderr.log'),
        ]),
      ].map(fileIdentity),
    ]),
  )
}
export function sameFile(expected: ArtifactIdentity): boolean {
  const actual = fileIdentity(expected.path)
  return actual.sha256 === expected.sha256 && actual.bytes === expected.bytes
}
export function verifyInput(
  target: TargetIdentity,
  input: AcceptedInput,
): void {
  const contribution = input.contribution
  for (const path of [
    contribution.receipt,
    contribution.handoff,
    ...contribution.receipts,
    ...contribution.artifacts.map((entry) => entry.path),
  ])
    if (!input.evidence.some((entry) => entry.path === path))
      throw new WorkspaceError('missing-input-evidence', path)
  for (const expected of input.evidence)
    if (!sameFile(expected))
      throw new WorkspaceError('stale-input-evidence', expected.path)
  if (
    !fs.readFileSync(contribution.handoff, 'utf8').trim() ||
    fs.readFileSync(contribution.receipt, 'utf8') !==
      `${JSON.stringify(contribution, null, 2)}\n` ||
    git(target.root, ['rev-parse', contribution.acceptedRef]).trim() !==
      contribution.revision ||
    git(target.root, [
      'rev-parse',
      `${contribution.revision}^{tree}`,
    ]).trim() !== contribution.tree
  )
    throw new WorkspaceError('incompatible-input', contribution.receipt)
}
export function sameCheckoutIdentity(
  saved: string | undefined,
  current: TargetIdentity,
): boolean {
  if (!saved) return false
  const value: unknown = JSON.parse(saved)
  return (
    typeof value === 'object' &&
    value !== null &&
    'root' in value &&
    value.root === current.root &&
    'commonDirectory' in value &&
    value.commonDirectory === current.commonDirectory &&
    'gitDirectory' in value &&
    value.gitDirectory === current.gitDirectory &&
    'branch' in value &&
    value.branch === current.branch &&
    'launchRevision' in value &&
    value.launchRevision === current.launchRevision
  )
}
