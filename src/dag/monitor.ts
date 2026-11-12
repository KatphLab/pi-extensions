import * as fs from 'node:fs'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { compile, int, obj, str, union } from '@earendil-works/pi-schema'
import { runTiming, runUsage } from './accounting.js'
import {
  type AttemptState,
  inspectOwner,
  type RunState,
  readRunState,
} from './state.js'

const limitsSchema = obj(
  {
    nodeRetries: int({ minimum: 0 }),
    repairCycles: int({ minimum: 0 }),
  },
  { open: true },
)
const frozenSchema = compile(
  union([
    obj({ definition: str() }, { open: true }),
    obj(
      { plan: obj({ limits: limitsSchema }, { open: true }) },
      { open: true },
    ),
  ]),
)
const definitionLimits = compile(obj({ limits: limitsSchema }, { open: true }))

function retryLimits(state: RunState) {
  const path = state.snapshots['effective'] ?? state.snapshots['plan']
  if (!path) return null
  const frozen: unknown = JSON.parse(fs.readFileSync(path, 'utf8'))
  if (!frozenSchema.check(frozen)) return null
  if ('plan' in frozen) return frozen.plan.limits
  const definition: unknown = JSON.parse(frozen.definition)
  return definitionLimits.check(definition) ? definition.limits : null
}

function currentTasks(state: RunState): unknown[] {
  const pending = Object.entries(state.assignments).filter(
    ([, assignment]) =>
      assignment.stage !== 'accepted' && assignment.stage !== 'ready',
  )
  const limits = pending.length > 0 ? retryLimits(state) : null
  return [
    ...pending.flatMap(([id, assignment]) => {
      const attempt = assignment.attempts.at(-1)
      return [
        {
          task: `${state.runId}/${id}`,
          stage: assignment.stage,
          worktree: attempt?.worktree ?? null,
          retryBudget: {
            used: assignment.retries,
            limit: limits?.nodeRetries ?? null,
            remaining: limits
              ? Math.max(0, limits.nodeRetries - assignment.retries)
              : null,
          },
        },
      ]
    }),
    ...Object.values(state.children ?? {}).flatMap(currentTasks),
  ]
}

/** A concise projection of state.json, the durable coordinator context. */
export function runStatus(directory: string) {
  const state = readRunState(directory)
  return {
    runId: state.runId,
    status: state.status,
    context: {
      state: join(directory, 'state.json'),
      runDirectory: directory,
      worktree: state.target.root,
      candidateRevision: state.target.expectedRevision,
      evidence: join(directory, 'evidence'),
      snapshots: state.snapshots,
    },
    currentTasks: currentTasks(state),
    blocker: state.needsAuthor,
    reports: acceptedReports(state),
  }
}

export function executionExit(state: RunState): number {
  switch (state.status) {
    case 'succeeded':
      return 0
    case 'needs-author':
      return 3
    case 'paused':
    case 'failed':
    case 'running':
      return 1
    default:
      return state.status satisfies never
  }
}

function latestFailure(attempts: readonly AttemptState[]) {
  for (const attempt of attempts.toReversed()) {
    const path = join(attempt.runner, 'failure.json')
    if (fs.existsSync(path))
      return { path, diagnostic: fs.readFileSync(path, 'utf8').slice(0, 2048) }
  }
  return null
}

function ownerStatus(directory: string) {
  try {
    return inspectOwner(join(directory, 'owner.lock')).status
  } catch (value) {
    const error = value instanceof Error ? value : new Error(String(value))
    if ('code' in error && error.code === 'ENOENT') return 'absent'
    throw error
  }
}

function progress(state: RunState): unknown {
  return {
    status: state.status,
    assignments: Object.fromEntries(
      Object.entries(state.assignments).map(([id, assignment]) => [
        id,
        {
          stage: assignment.stage,
          retries: assignment.retries,
          attempt: assignment.attempts.at(-1)?.number ?? null,
          failure: latestFailure(assignment.attempts),
        },
      ]),
    ),
    cycle: state.cycle,
    needsAuthor: state.needsAuthor,
    children: Object.fromEntries(
      Object.entries(state.children ?? {}).map(([id, child]) => [
        id,
        progress(child),
      ]),
    ),
  }
}

export async function summarizeRun(
  directory: string,
  approvalSessions: readonly string[] = [],
) {
  const state = readRunState(directory)
  const owner = ownerStatus(directory)
  return {
    runId: state.runId,
    runDirectory: directory,
    owner,
    progress: progress(state),
    timing: runTiming(state, owner === 'live'),
    usage: await runUsage(state, approvalSessions),
    acceptedReports: acceptedReports(state),
  }
}

function acceptedReports(state: RunState): unknown[] {
  return [
    ...Object.entries(state.assignments).flatMap(([id, assignment]) => {
      const attempt = assignment.attempts.at(-1)
      return assignment.stage === 'accepted' && attempt
        ? [
            {
              assignment: `${state.runId}/${id}`,
              artifacts: attempt.artifacts,
              report: attempt.report ?? null,
              revision: attempt.acceptedRevision ?? null,
            },
          ]
        : []
    }),
    ...Object.values(state.children ?? {}).flatMap(acceptedReports),
  ]
}

function compactEntries(state: RunState): Record<string, unknown> {
  return Object.assign(
    {
      [state.runId]: {
        status: state.status,
        needsAuthor: state.needsAuthor,
        cycle: state.cycle,
      },
    },
    Object.fromEntries(
      Object.entries(state.assignments).map(([id, assignment]) => [
        `${state.runId}/${id}`,
        {
          stage: assignment.stage,
          retries: assignment.retries,
          attempt: assignment.attempts.at(-1)?.number ?? null,
          failure: latestFailure(assignment.attempts)?.path ?? null,
        },
      ]),
    ),
    ...Object.values(state.children ?? {}).map(compactEntries),
  )
}

/** Observe durable state, never own or resume execution. */
export async function watchRun(
  directory: string,
  signal: AbortSignal,
  output: (value: unknown) => void,
  compact = false,
): Promise<number> {
  let previous = ''
  let priorEntries: Record<string, unknown> = {}
  for (;;) {
    signal.throwIfAborted()
    const owner = ownerStatus(directory)
    const state = readRunState(directory)
    const value = {
      runId: state.runId,
      runDirectory: directory,
      owner,
      progress: progress(state),
    }
    const serialized = JSON.stringify(value)
    if (serialized !== previous) {
      if (compact) {
        const entries = compactEntries(state)
        const changes = Object.fromEntries(
          Object.entries(entries).filter(
            ([key, entry]) =>
              JSON.stringify(priorEntries[key]) !== JSON.stringify(entry),
          ),
        )
        const removed = Object.keys(priorEntries).filter(
          (key) => !Object.hasOwn(entries, key),
        )
        output({
          runId: state.runId,
          owner,
          status: state.status,
          changes,
          removed,
        })
        priorEntries = entries
      } else output(value)
    }
    previous = serialized
    if (state.status !== 'running') return executionExit(state)
    if (owner !== 'live') return 1
    await setTimeout(250, undefined, { signal })
  }
}
