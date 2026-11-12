import type { DagNode } from '@dag/definition/schema.js'
import type { AssignmentState } from './state.js'

export interface ReadyFrontier {
  readonly ready: readonly string[]
  /** Direct failed/blocked inputs, including transitively blocked nodes. */
  readonly blocked: Readonly<Record<string, readonly string[]>>
}

/** Pure admission decision; the coordinator persists blocked transitions.
 * Missing assignment state means not yet attempted. Only accepted inputs count.
 * Repair invalidation and interrupted-attempt reconciliation precede this call.
 */
export function readyFrontier(
  nodes: Readonly<Record<string, Pick<DagNode, 'needs'>>>,
  assignments: Readonly<Record<string, Pick<AssignmentState, 'stage'>>>,
): ReadyFrontier {
  const entries = Object.entries(nodes).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  const eligible = entries.filter(([id]) => {
    const stage = assignments[id]?.stage
    return stage === undefined || stage === 'ready'
  })
  const failed = new Set(
    Object.entries(assignments)
      .filter(([, value]) => ['failed', 'blocked'].includes(value.stage))
      .map(([id]) => id),
  )
  // Validated DAGs may be authored in any order; reach a fixed point before admission.
  let changed = true
  while (changed) {
    changed = false
    for (const [id, node] of eligible) {
      if (!failed.has(id) && node.needs.some((input) => failed.has(input))) {
        failed.add(id)
        changed = true
      }
    }
  }
  const ready: string[] = []
  const blocked: Record<string, readonly string[]> = {}
  for (const [id, node] of eligible) {
    const unavailable = node.needs.filter((input) => failed.has(input))
    if (unavailable.length > 0) blocked[id] = unavailable
    else if (
      node.needs.every((input) => assignments[input]?.stage === 'accepted')
    )
      ready.push(id)
  }
  return { ready, blocked }
}

/** One pool per whole run, shared by authored and automatic executing stages.
 * Acquire only for execution, after readiness/cycle ownership is available.
 * Never wrap an idle cycle lease or await another pool.run inside an active slot.
 * Queueing is FIFO; the coordinator owns cancellation and persisted transitions.
 */
export class ExecutionCapacity {
  private executing = 0
  private readonly queue: (() => void)[] = []

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('Execution capacity must be a positive safe integer')
  }

  get active(): number {
    return this.executing
  }

  get pending(): number {
    return this.queue.length
  }

  async run<T>(execute: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.executing += 1
        resolve()
      })
      this.admit()
    })
    try {
      return await execute()
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error(typeof error === 'string' ? error : JSON.stringify(error))
    } finally {
      this.executing -= 1
      this.admit()
    }
  }

  private admit(): void {
    while (this.executing < this.limit && this.queue.length > 0)
      this.queue.shift()?.()
  }
}
