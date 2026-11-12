import * as fs from 'node:fs'
import type { ArtifactIdentity } from '@dag/command.js'
import { artifactIdentity } from '@dag/files.js'
import type { RunState } from '@dag/state.js'
import {
  acceptedContract,
  workspaceCheckpointContract,
} from '@dag/workspace/checkpoint.js'
import type {
  AcceptedContribution,
  PrerequisiteProgress,
} from '@dag/workspace/types.js'
import {
  arr,
  compile,
  int,
  map,
  obj,
  oneOf,
  opt,
  type Static,
  str,
} from '@earendil-works/pi-schema'
import { RunError } from './error.js'

const text = str({ minLength: 1 })
const artifactSchema = obj({
  path: text,
  sha256: text,
  bytes: int({ minimum: 0 }),
})
const acceptedSchema = acceptedContract
const progressSchema = obj({
  accepted: acceptedSchema,
  route: oneOf(['worker', 'integration']),
  feedback: str(),
})
const checkProgressContract = obj({
  candidate: opt(artifactSchema),
  started: arr(int({ minimum: 0 })),
  observations: map(arr(artifactSchema)),
  repeat: map(artifactSchema),
  completed: map(artifactSchema),
  unobserved: opt(map(arr(str()))),
  publishing: opt(oneOf([true])),
  worktreeStarted: opt(oneOf([true])),
})
const acceptanceContract = obj({
  number: int({ minimum: 0 }),
  progress: checkProgressContract,
})
const combinedContract = obj({
  number: int({ minimum: 0 }),
  revision: text,
  tree: text,
  worktree: text,
  checks: text,
  progress: checkProgressContract,
})
const handoffSchema = obj({
  branch: str(),
  final: str(),
  number: int({ minimum: 0 }),
  worktree: str(),
  runner: str(),
  artifacts: str(),
  checks: str(),
  candidate: opt(artifactSchema),
  started: arr(int({ minimum: 0 })),
  observations: map(arr(artifactSchema)),
  repeat: map(artifactSchema),
  completed: map(artifactSchema),
  publishing: opt(oneOf([true])),
  worktreeStarted: opt(oneOf([true])),
  unobserved: opt(map(arr(str()))),
})
const prerequisiteProgressContract = obj({
  tips: arr(text),
  baseline: text,
  next: int({ minimum: 0 }),
  phase: oneOf(['merge', 'reconcile', 'commit', 'checks']),
  merges: arr(text),
  pending: opt(text),
  checks: checkProgressContract,
})
const pendingPreparationContract = obj({
  number: int({ minimum: 0 }),
  reconciliations: arr(text),
  progress: opt(prerequisiteProgressContract),
})
const checkpointContract = obj({
  phase: oneOf([
    'worker',
    'integration',
    'staged-checks',
    'apply',
    'checks',
    'review',
    'decision',
    'repair',
  ]),
  contributions: arr(acceptedSchema),
  controls: arr(artifactSchema),
  progress: opt(progressSchema),
  accepted: opt(acceptedSchema),
  reviewed: opt(acceptedSchema),
  handoff: opt(handoffSchema),
  acceptances: opt(map(acceptanceContract)),
  combined: opt(combinedContract),
  pendingPreparations: opt(map(pendingPreparationContract)),
  receipts: opt(arr(text)),
  verdict: opt(str()),
  repairs: opt(map(str())),
  repairBase: opt(text),
  workspace: workspaceCheckpointContract,
  preparationNumber: int({ minimum: 0 }),
  preparationRecords: map(artifactSchema),
  acceptedNodes: map(obj({ receipt: text, preparation: opt(text) })),
  finalPreparation: opt(str()),
})
export const checkpointSchema = compile(checkpointContract)
export type Checkpoint = {
  readonly phase: Static<typeof checkpointContract>['phase']
  readonly contributions: readonly AcceptedContribution[]
  readonly controls: readonly ArtifactIdentity[]
  readonly progress?: {
    readonly accepted: AcceptedContribution
    readonly route: 'worker' | 'integration'
    readonly feedback: string
  }
  readonly accepted?: AcceptedContribution
  readonly reviewed?: AcceptedContribution | undefined
  readonly handoff?: Static<typeof handoffSchema>
  readonly acceptances?: Readonly<
    Record<string, Static<typeof acceptanceContract>>
  >
  readonly combined?: Static<typeof combinedContract>
  readonly pendingPreparations?: Readonly<
    Record<
      string,
      {
        readonly number: number
        readonly reconciliations: string[]
        readonly progress?: PrerequisiteProgress
      }
    >
  >
  readonly receipts?: readonly string[]
  readonly verdict?: string
  readonly repairs?: Readonly<Record<string, string>>
  readonly repairBase?: string
}
export type SavedCheckpoint = Static<typeof checkpointContract>
export function fileIdentity(path: string): ArtifactIdentity {
  if (fs.realpathSync(path) !== path || !fs.lstatSync(path).isFile())
    throw new RunError('changed-evidence', path)
  return artifactIdentity(path)
}
export function assertEvidence(identities: readonly ArtifactIdentity[]): void {
  for (const identity of identities) {
    const actual = fileIdentity(identity.path)
    if (actual.sha256 !== identity.sha256 || actual.bytes !== identity.bytes)
      throw new RunError('changed-evidence', identity.path)
  }
}
export function json(path: string): unknown {
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}
export function readBound(state: RunState, key: string): unknown {
  const path = state.snapshots[key]
  if (!path || fileIdentity(path).sha256 !== state.snapshots[`${key}Sha256`])
    throw new RunError('changed-checkpoint', path ?? key)
  return json(path)
}

type FileIdentity = { readonly path: string; readonly sha256: string }
export function verdictEnvelope(
  source: string,
): { input: FileIdentity; report: FileIdentity; verdict: string } | undefined {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  if (!('input' in value) || !('report' in value) || !('verdict' in value))
    return undefined
  const input = fileIdentityField(value.input)
  const report = fileIdentityField(value.report)
  const verdict = value.verdict
  if (!input || !report) return undefined
  if (typeof verdict !== 'object' || verdict === null) return undefined
  if (!('verdict' in verdict) || typeof verdict.verdict !== 'string')
    return undefined
  return { input, report, verdict: verdict.verdict }
}
function fileIdentityField(value: unknown): FileIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('path' in value) || typeof value.path !== 'string') return undefined
  if (!('sha256' in value) || typeof value.sha256 !== 'string') return undefined
  return { path: value.path, sha256: value.sha256 }
}
