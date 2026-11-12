import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import {
  compile,
  num,
  obj,
  opt,
  type Static,
  str,
} from '@earendil-works/pi-schema'
import type { RunState } from './state.js'

const count = num({ minimum: 0 })
const usageSchema = compile(
  obj(
    {
      input: count,
      output: count,
      cacheRead: count,
      cacheWrite: count,
      cost: obj({ total: count }, { open: true }),
    },
    { open: true },
  ),
)
const entryContract = obj(
  {
    type: str(),
    id: str({ minLength: 1 }),
    message: opt(obj({ role: str() }, { open: true })),
  },
  { open: true },
)
const entrySchema = compile(entryContract)
type AccountingEntry = Static<typeof entryContract>
export type Usage = {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  estimatedCost: number
}

function emptyUsage(): Usage {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    estimatedCost: 0,
  }
}
function add(target: Usage, source: Usage): void {
  for (const key of [
    'requests',
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
    'totalTokens',
    'estimatedCost',
  ] as const)
    target[key] += source[key]
}
function property(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}
function readEntry(line: string) {
  const entry: unknown = JSON.parse(line)
  if (!entrySchema.check(entry)) throw new Error('Malformed session entry')
  return entry
}
function countEntry(
  entry: AccountingEntry,
  key: string,
  seen: Set<string>,
  usage: Usage,
) {
  if (seen.has(key)) return
  const message = entry.type === 'message' ? entry.message : undefined
  const recorded = property(message ?? entry, 'usage')
  if (recorded === undefined && message?.role !== 'assistant') return
  if (!usageSchema.check(recorded)) throw new Error('Missing or invalid usage')
  seen.add(key)
  usage.requests += message?.role === 'assistant' ? 1 : 0
  usage.input += recorded.input
  usage.output += recorded.output
  usage.cacheRead += recorded.cacheRead
  usage.cacheWrite += recorded.cacheWrite
  usage.totalTokens +=
    recorded.input + recorded.output + recorded.cacheRead + recorded.cacheWrite
  usage.estimatedCost += recorded.cost.total
}

function headerIdentity(
  entry: AccountingEntry,
  expectedId: string | undefined,
): string {
  if (entry.type !== 'session' || (expectedId && entry.id !== expectedId))
    throw new Error('Session identity mismatch')
  return entry.id
}

async function sessionUsage(
  path: string,
  expectedId: string | undefined,
  seen: Set<string>,
) {
  const usage = emptyUsage()
  let lineNumber = 0
  let sessionId: string | undefined
  const input = createReadStream(path)
  try {
    const lines = createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    })
    for await (const line of lines) {
      lineNumber++
      const entry = readEntry(line)
      if (lineNumber === 1) sessionId = headerIdentity(entry, expectedId)
      else countEntry(entry, `${sessionId}/${entry.id}`, seen, usage)
    }
    if (!sessionId) throw new Error('Empty session')
    return { usage, issue: null }
  } catch (value) {
    const error = value instanceof Error ? value : new Error(String(value))
    return {
      usage,
      issue: {
        path,
        line: lineNumber,
        message: `Incomplete session accounting: ${error.message}`,
      },
    }
  } finally {
    input.destroy()
  }
}

function states(state: RunState): RunState[] {
  return [
    state,
    ...Object.values(state.children ?? {}).flatMap(states),
    ...(state.approvals ?? []).flatMap((entry) => states(entry.child)),
  ]
}
function sessionSources(state: RunState) {
  const sources = new Map<
    string,
    { id: string | undefined; assignment: string }
  >()
  for (const current of states(state)) {
    const records = Object.entries(current.assignments).flatMap(
      ([id, assignment]) =>
        assignment.attempts.map((attempt) => ({
          path: attempt.sessionPath,
          id: attempt.sessionId,
          assignment: `${current.runId}/${id}`,
        })),
    )
    records.push(
      ...(current.restarts ?? []).map((restart) => ({
        path: restart.previousSessionPath,
        id: restart.previousSessionId,
        assignment: `${current.runId}/${restart.assignment}`,
      })),
    )
    for (const record of records)
      if (record.path && !sources.has(record.path))
        sources.set(record.path, record)
  }
  return sources
}

/** Counts persisted usage across every branch/attempt, never reconstructed model context. */
export async function runUsage(
  state: RunState,
  approvalSessions: readonly string[] = [],
) {
  const seen = new Set<string>()
  const execution = emptyUsage()
  const byAssignment: Record<string, Usage> = Object.create(null)
  const issues = []
  for (const [path, source] of sessionSources(state)) {
    const result = await sessionUsage(path, source.id, seen)
    const usage = byAssignment[source.assignment] ?? emptyUsage()
    add(usage, result.usage)
    byAssignment[source.assignment] = usage
    add(execution, result.usage)
    if (result.issue) issues.push(result.issue)
  }
  const approvals = emptyUsage()
  for (const path of new Set(approvalSessions)) {
    const result = await sessionUsage(path, undefined, seen)
    add(approvals, result.usage)
    if (result.issue) issues.push(result.issue)
  }
  const recordedTotal = { ...execution }
  add(recordedTotal, approvals)
  return {
    complete: issues.length === 0,
    execution,
    byAssignment,
    approvals: approvalSessions.length > 0 ? approvals : null,
    recordedTotal,
    issues,
    costBasis: 'Persisted model-rate estimates, not billing charges',
    exclusions: [
      'Coordinator conversation',
      'Readiness probes',
      ...(approvalSessions.length > 0
        ? []
        : ['External workflow approval sessions (supply --approval-session)']),
    ],
  }
}

function activeDuration(
  events: NonNullable<RunState['lifecycle']>['events'],
  live: boolean,
  now: number,
) {
  let active = 0
  for (const [index, event] of events.entries()) {
    if (event.status !== 'running') continue
    const next = events.at(index + 1)
    if (!next && !live) return null
    active += Math.max(
      0,
      (next ? Date.parse(next.at) : now) - Date.parse(event.at),
    )
  }
  return active
}
export type RunTiming = {
  readonly complete: boolean
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly events: NonNullable<RunState['lifecycle']>['events']
  readonly elapsedMs: number | null
  readonly activeMs: number | null
}
export function runTiming(
  state: RunState,
  live: boolean,
  now = Date.now(),
): RunTiming {
  const events = state.lifecycle?.events ?? []
  const first = events[0]
  const last = events.at(-1)
  const complete =
    state.lifecycle?.complete === true && first?.status === 'running'
  const finished = state.status === 'succeeded' || state.status === 'failed'
  const startedAt = complete ? first.at : null
  const finishedAt = finished ? (last?.at ?? null) : null
  const activeMs = complete ? activeDuration(events, live, now) : null
  return {
    complete: complete && activeMs !== null,
    startedAt,
    finishedAt,
    events,
    elapsedMs: startedAt
      ? Math.max(
          0,
          (finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt),
        )
      : null,
    activeMs,
  }
}
