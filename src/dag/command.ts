import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { artifactIdentity } from './files.js'

export interface CommandIdentity {
  readonly runId: string
  readonly assignment: string
  readonly attempt: number
  readonly revision: string
}
export interface ArtifactIdentity {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}
export interface ArtifactInput {
  readonly assignment: string
  readonly path: string
  readonly artifact: ArtifactIdentity
}
export interface CommandRequest {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly artifacts: string
  readonly runner: string
  readonly identity: CommandIdentity
  readonly outputs: readonly string[]
  readonly signal: AbortSignal
  readonly artifactInputs?: readonly ArtifactInput[]
}
export interface CommandObservation {
  readonly identity: CommandIdentity
  readonly argv: readonly string[]
  readonly cwd: string
  readonly pid: number | null
  readonly status: 'completed' | 'failed' | 'interrupted'
  readonly exitCode: number | null
  readonly signal: string | null
  readonly error: string | null
  readonly artifacts: readonly ArtifactIdentity[]
  readonly stdout: string
  readonly stderr: string
  readonly receipt: string
}
export class CommandError extends Error {
  constructor(
    readonly code: string,
    readonly resource: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${resource}`, options)
    this.name = 'CommandError'
  }
}
const observed = new WeakMap<CommandObservation, string>()
function within(root: string, path: string): boolean {
  const delta = relative(root, path)
  return (
    delta !== '' &&
    delta !== '..' &&
    !delta.startsWith(`..${sep}`) &&
    !isAbsolute(delta)
  )
}
function outputPath(root: string, path: string): string {
  if (
    isAbsolute(path) ||
    path
      .split(/[\\/]/)
      .some((part) =>
        ['..', 'runner', 'outcome.json', 'handoff.md', 'review.json'].includes(
          part,
        ),
      )
  )
    throw new CommandError('invalid-output', path)
  const absolute = resolve(root, path)
  if (!within(root, absolute)) throw new CommandError('invalid-output', path)
  return absolute
}
function artifact(root: string, path: string): ArtifactIdentity {
  const absolute = outputPath(root, path)
  if (
    !within(root, fs.realpathSync(absolute)) ||
    !fs.lstatSync(absolute).isFile()
  )
    throw new CommandError('invalid-artifact', path)
  return artifactIdentity(absolute)
}
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
      throw error
  }
}
interface ProcessExit {
  readonly pid: number | null
  readonly exitCode: number | null
  readonly signal: string | null
  readonly failure: Error | null
  readonly interrupted: boolean
}

function validateInputs(inputs: readonly ArtifactInput[]): void {
  for (const { artifact: input } of inputs) {
    if (
      fs.realpathSync(input.path) !== input.path ||
      !fs.lstatSync(input.path).isFile()
    )
      throw new CommandError('stale-input', input.path)
    const bytes = fs.readFileSync(input.path)
    if (
      bytes.length !== input.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== input.sha256
    )
      throw new CommandError('stale-input', input.path)
  }
}
function commandArtifacts(
  request: CommandRequest,
  inputs: readonly ArtifactInput[],
  manifest: { readonly path: string; readonly content: string },
): readonly ArtifactIdentity[] {
  validateInputs(inputs)
  if (fs.readFileSync(manifest.path, 'utf8') !== manifest.content)
    throw new CommandError('changed-input-manifest', manifest.path)
  return request.outputs.map((path) => artifact(request.artifacts, path))
}
async function observeProcess(
  request: CommandRequest,
  streams: { readonly out: number; readonly err: number },
  executable: string,
  inputsFile: string,
): Promise<ProcessExit> {
  let pid: number | null = null
  let exitCode: number | null = null
  let signal: string | null = null
  let failure: Error | null = null
  let interrupted = request.signal.aborted
  try {
    if (!interrupted) {
      const child = spawn(executable, request.argv.slice(1), {
        cwd: request.cwd,
        env: {
          ...process.env,
          DAG_EVIDENCE_DIR: request.artifacts,
          DAG_INPUTS_FILE: inputsFile,
        },
        detached: true,
        stdio: ['ignore', streams.out, streams.err],
      })
      const abort = () => {
        interrupted = true
        if (child.pid !== undefined) killGroup(child.pid)
      }
      request.signal.addEventListener('abort', abort, { once: true })
      try {
        if (request.signal.aborted) abort()
        await new Promise<void>((complete) => {
          child.once('error', (error) => {
            failure = error
          })
          child.once('spawn', () => {
            pid = child.pid ?? null
          })
          // Kill remaining inherited-group descendants even if the leader exits first.
          child.once('exit', () => {
            if (child.pid !== undefined) killGroup(child.pid)
          })
          child.once('close', (code, receivedSignal) => {
            exitCode = code
            signal = receivedSignal
            complete()
          })
        })
      } finally {
        request.signal.removeEventListener('abort', abort)
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
    if (pid !== null) killGroup(pid)
  } finally {
    fs.closeSync(streams.out)
    fs.closeSync(streams.err)
  }
  return { pid, exitCode, signal, failure, interrupted }
}

function prepareEvidence(request: CommandRequest) {
  const executable = request.argv[0]
  if (
    executable === undefined ||
    request.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    executable === ''
  )
    throw new CommandError('invalid-argv', request.cwd)
  const cwd = fs.realpathSync(request.cwd)
  const artifactsDirectory = fs.realpathSync(request.artifacts)
  const runnerDirectory = fs.realpathSync(request.runner)
  if (
    artifactsDirectory === runnerDirectory ||
    within(artifactsDirectory, runnerDirectory) ||
    within(runnerDirectory, artifactsDirectory)
  )
    throw new CommandError('overlapping-evidence', runnerDirectory)
  for (const path of request.outputs) outputPath(artifactsDirectory, path)
  return { cwd, artifactsDirectory, runnerDirectory, executable }
}

/** One invocation only. Interrupted receipts require an explicit coordinator repeat decision. */
export async function executeCommand(
  request: CommandRequest,
): Promise<CommandObservation> {
  const { cwd, artifactsDirectory, runnerDirectory, executable } =
    prepareEvidence(request)
  const { artifactInputs = [] } = request
  const inputs = structuredClone(artifactInputs)
  validateInputs(inputs)
  const directory = join(runnerDirectory, `command-${randomUUID()}`)
  fs.mkdirSync(directory)
  const inputsFile = join(directory, 'inputs.json')
  const inputsContent = `${JSON.stringify(inputs, null, 2)}\n`
  fs.writeFileSync(inputsFile, inputsContent, { flag: 'wx', mode: 0o400 })
  const stdout = join(directory, 'stdout.log')
  const stderr = join(directory, 'stderr.log')
  const out = fs.openSync(stdout, 'wx', 0o600)
  const err = fs.openSync(stderr, 'wx', 0o600)
  let { pid, exitCode, signal, failure, interrupted } = await observeProcess(
    { ...request, cwd, artifacts: artifactsDirectory },
    { out, err },
    executable,
    inputsFile,
  )
  let outputs: readonly ArtifactIdentity[] = []
  if (!interrupted && !failure && exitCode === 0) {
    try {
      outputs = commandArtifacts(
        { ...request, artifacts: artifactsDirectory },
        inputs,
        { path: inputsFile, content: inputsContent },
      )
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
  }
  const receipt = join(directory, 'receipt.json')
  const result: CommandObservation = Object.freeze({
    identity: Object.freeze({ ...request.identity }),
    argv: Object.freeze([...request.argv]),
    cwd,
    pid,
    status: interrupted
      ? 'interrupted'
      : failure || exitCode !== 0
        ? 'failed'
        : 'completed',
    exitCode,
    signal,
    error: failure?.message ?? null,
    artifacts: Object.freeze(outputs),
    stdout,
    stderr,
    receipt,
  })
  const serialized = `${JSON.stringify(result, null, 2)}\n`
  fs.writeFileSync(receipt, serialized, {
    flag: 'wx',
    mode: 0o600,
  })
  observed.set(result, serialized)
  return result
}

/** Process success is only a claim; the workspace owner must still check full scope/checks. */
export function commandClaim(result: CommandObservation): {
  readonly outcome: 'claimed-complete' | 'failed'
  readonly deliverables: readonly string[]
  readonly receipt: string
  readonly revision: string
} {
  if (!observed.has(result))
    throw new CommandError('unobserved-receipt', result.receipt)
  if (observed.get(result) !== fs.readFileSync(result.receipt, 'utf8'))
    throw new CommandError('stale-receipt', result.receipt)
  let outcome: 'claimed-complete' | 'failed' = 'failed'
  switch (result.status) {
    case 'completed':
      outcome = 'claimed-complete'
      for (const identity of result.artifacts) {
        const current = fs.readFileSync(identity.path)
        if (
          fs.realpathSync(identity.path) !== identity.path ||
          !fs.lstatSync(identity.path).isFile() ||
          createHash('sha256').update(current).digest('hex') !== identity.sha256
        )
          throw new CommandError('stale-artifact', identity.path)
      }
      break
    case 'failed':
    case 'interrupted':
      break
    default:
      throw new CommandError('invalid-status', result.status satisfies never)
  }
  const claim = {
    outcome,
    deliverables: result.artifacts.map((entry) => entry.path),
    receipt: result.receipt,
    revision: result.identity.revision,
  } as const
  const directory = resolve(result.receipt, '..')
  fs.writeFileSync(
    join(directory, 'outcome.json'),
    `${JSON.stringify(claim, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  )
  fs.writeFileSync(
    join(directory, 'handoff.md'),
    `Outcome: ${claim.outcome}\nRevision: ${claim.revision}\nReceipt: ${claim.receipt}\nArtifacts: ${claim.deliverables.join(', ')}\nScope/check acceptance remains pending.\n`,
    { flag: 'wx', mode: 0o600 },
  )
  return claim
}
