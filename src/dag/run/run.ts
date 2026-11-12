import * as fs from 'node:fs'
import { join } from 'node:path'
import { type DagRunOwner, RunOwner } from '@dag/state.js'
import { captureTarget } from '@dag/workspace/workspace.js'
import { assertRunOwnership, RunContext } from './context.js'
import { RunError } from './error.js'
import { RunLifecycle } from './lifecycle.js'
import type {
  ManagedBindings,
  ManagedDag,
  RunRequest,
  RunResult,
} from './types.js'

/** Accepted-frontier dispatch followed by the owned integration/review cycle. */
export async function runDag(request: RunRequest): Promise<RunResult> {
  const definition = structuredClone(request.definition)
  const assignments = structuredClone(request.assignments)
  const entries = Object.entries(definition.nodes)
  const first = entries[0]
  if (
    !first ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(request.runId) ||
    ['.', '..'].includes(request.runId)
  )
    throw new RunError('invalid-run', request.runId)
  const base = assignments.nodes[first[0]]
  if (
    !base ||
    entries.some(
      ([id, node]) =>
        JSON.stringify(assignments.nodes[id]?.node) !== JSON.stringify(node),
    ) ||
    JSON.stringify(base.node) !== JSON.stringify(first[1]) ||
    base.goal !== definition.goal ||
    JSON.stringify(base.criteria) !== JSON.stringify(definition.criteria)
  )
    throw new RunError('assignment-mismatch', first[0])
  if (
    assignments.review.size !== 'large' ||
    (entries.some(([, node]) => node.write.length > 0) &&
      !assignments.integration)
  )
    throw new RunError('stage-profile', first[0])
  assertRunOwnership(definition, request.ownership)
  const target = captureTarget(request.projectRoot)
  const runDirectory = join(target.root, '.pi/dags/runs', request.runId)
  if (fs.existsSync(runDirectory))
    throw new RunError('existing-run', runDirectory)
  const owner = RunOwner.acquire({
    runDirectory,
    target,
    ownership: request.ownership,
  })
  const coordinator = new RunContext(
    { ...request, definition, assignments },
    owner,
    base,
  )
  try {
    return await new RunLifecycle(coordinator).execute()
  } finally {
    owner.release()
  }
}

/** A managed instance uses the same assignment, acceptance, integration and review engine. */
export function managedDag(
  request: RunRequest,
  owner: DagRunOwner,
  managed: ManagedBindings,
): ManagedDag {
  const first = Object.values(request.assignments.nodes)[0]
  if (!first) throw new RunError('missing-assignment', request.runId)
  fs.mkdirSync(owner.runDirectory, { recursive: true })
  const coordinator = new RunContext(request, owner, first, managed)
  return new RunLifecycle(coordinator)
}
