import type { PlanRevision } from '@dag/definition/schema.js'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
export interface PlanRunRequest {
  readonly revision: PlanRevision
  readonly runId: string
  readonly runtime: ModelRuntime
  readonly signal: AbortSignal
}
