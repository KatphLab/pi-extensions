import type {
  ArtifactIdentity,
  ArtifactInput,
  CommandIdentity,
  CommandObservation,
} from '@dag/command.js'
import type { VerifyCheck } from '@dag/definition/schema.js'
import type { TargetIdentity } from '@dag/state.js'
export interface WorktreeRequest {
  readonly runId: string
  readonly assignment: string
  readonly attempt: number
  readonly baseline: string
  readonly role: 'assignment' | 'validation'
}
export interface ContributionRequest {
  readonly target: TargetIdentity
  readonly worktree: string
  readonly baseline: string
  readonly identity: CommandIdentity
  readonly write: readonly string[]
  readonly outputs: readonly string[]
  readonly artifactInputs?: readonly ArtifactInput[]
  readonly checks: readonly (VerifyCheck & {
    readonly artifacts?: string
    readonly artifactInputs?: readonly ArtifactInput[]
  })[]
  readonly artifacts: string
  readonly runner: string
  readonly signal: AbortSignal
  readonly producer?: CommandObservation
  readonly resume?: boolean
  readonly resumable?: boolean
  readonly durable?: {
    readonly read: () => HandoffProgress
    readonly write: (progress: HandoffProgress) => void
    readonly repeat: (index: number, settled?: ArtifactIdentity) => void
  }
}
export interface HandoffProgress {
  readonly worktreeStarted?: true
  readonly candidate?: ArtifactIdentity
  readonly started: number[]
  readonly observations: Record<string, ArtifactIdentity[]>
  readonly unobserved?: Record<string, string[]>
  readonly repeat: Record<string, ArtifactIdentity>
  readonly completed: Record<string, ArtifactIdentity>
  readonly publishing?: true
}
export interface AcceptedContribution {
  readonly baseline: string
  readonly revision: string
  readonly tree: string
  readonly changedPaths: readonly string[]
  readonly validationWorktree: string
  readonly artifacts: readonly ArtifactIdentity[]
  readonly receipts: readonly string[]
  readonly acceptedRef: string
  readonly receipt: string
  readonly handoff: string
}
export type Candidate = Omit<
  AcceptedContribution,
  'receipts' | 'acceptedRef' | 'receipt' | 'handoff'
>
/** Persist this value in the runner's hash-bound checkpoint, never in worker reports. */
export interface AcceptedInput {
  readonly contribution: AcceptedContribution
  readonly evidence: readonly ArtifactIdentity[]
}
export interface Prerequisite {
  readonly id: string
  readonly needs: readonly string[]
  readonly write: readonly string[]
  readonly checks: ContributionRequest['checks']
  /** A completed DAG code result remains a tip even if its integrator added no edits. */
  readonly reviewedCode?: boolean
  readonly reviewVerdict?: ArtifactIdentity
  readonly input: AcceptedInput
  readonly artifacts?: string
  /** Runner preparation retains intermediate checked merge ancestry for final integration. */
  readonly preparation?: PrerequisiteBaseline
}
export interface PrerequisiteBaseline {
  readonly revision: string
  readonly inputs: readonly AcceptedInput[]
  readonly direct: readonly {
    readonly id: string
    readonly revision: string
    readonly handoff: string
    readonly artifacts: readonly ArtifactIdentity[]
    readonly reviewVerdict?: ArtifactIdentity
  }[]
  readonly reconciliation?: AcceptedInput
}
export interface PrerequisiteProgress {
  readonly tips: readonly string[]
  readonly baseline: string
  readonly next: number
  readonly phase: 'merge' | 'reconcile' | 'commit' | 'checks'
  readonly merges: readonly string[]
  readonly pending?: string
  readonly checks: HandoffProgress
}
export interface PrerequisiteRequest {
  readonly target: TargetIdentity
  readonly identity: CommandIdentity
  readonly needs: readonly string[]
  readonly accepted: readonly Prerequisite[]
  readonly runner: string
  readonly artifacts: string
  readonly signal: AbortSignal
  readonly emptyBaseline?: string
  /** Parent-owned target tip, only for the final serialized integration. */
  readonly targetTip?: boolean
  readonly durable?: {
    readonly read: () => PrerequisiteProgress | undefined
    readonly write: (progress: PrerequisiteProgress) => void
    readonly repeat: (index: number, settled?: ArtifactIdentity) => void
  }
  /** The caller supplies the designated integrator, not the consumer. Called even for clean merges. */
  readonly reconcile?: (stage: {
    readonly index: number
    readonly worktree: string
    readonly baseline: string
    readonly tips: readonly string[]
    readonly write: readonly string[]
    readonly inputs: readonly AcceptedInput[]
    readonly signal: AbortSignal
  }) => Promise<void>
}
/** A live preparation plus the runner's complete final integration scope. Not worker-authored. */
export interface IntegrationAuthorization {
  readonly prerequisites: PrerequisiteBaseline
  readonly write: readonly string[]
}

export type ReviewedHandoffRequest = Omit<
  ContributionRequest,
  'worktree' | 'baseline' | 'producer'
> & {
  readonly branch: AcceptedContribution
  readonly final: AcceptedContribution
  readonly preparation: PrerequisiteBaseline
}
