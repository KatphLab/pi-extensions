import type {
  AssignmentSnapshots,
  DagDefinition,
  ReviewReport,
} from '@dag/definition/schema.js'
import type { ExecutionCapacity } from '@dag/scheduler.js'
import type { RunState } from '@dag/state.js'
import type { AcceptedInput, Prerequisite } from '@dag/workspace/types.js'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

export interface RunRequest {
  readonly projectRoot: string
  readonly runId: string
  readonly ownership?: RunState['ownership']
  readonly definition: DagDefinition
  readonly assignments: AssignmentSnapshots
  readonly source: Readonly<Record<string, string>>
  readonly runtime: ModelRuntime
  readonly signal: AbortSignal
}
export interface RunResult {
  readonly runDirectory: string
  readonly state: RunState
}
export interface ManagedDag {
  readonly managedResult: {
    readonly state: RunState
    readonly needsWorkers: boolean
    readonly inputs: readonly AcceptedInput[]
    readonly merges: readonly string[]
  }
  reviewedResult(name: string): {
    readonly handoff: Prerequisite
    readonly target: Prerequisite
  }
  executeWorkers(): Promise<RunResult>
  executeCycle(): Promise<RunResult>
  restoreManaged(state: RunState, retained?: boolean): Promise<void>
  repairFromOverall(verdict: ReviewReport): Promise<void>
  invalidateForUpstream(amended?: boolean, affected?: readonly string[]): void
}
export interface ManagedBindings {
  readonly capacity: ExecutionCapacity
  readonly prerequisites: readonly Prerequisite[]
  readonly integrated: () => readonly Prerequisite[]
  readonly imports: () => readonly AcceptedInput[]
  readonly importedMerges: () => readonly string[]
}
