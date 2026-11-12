import * as fs from 'node:fs'
import { dirname, join, sep } from 'node:path'
import {
  type ArtifactIdentity,
  type CommandObservation,
  commandClaim,
  executeCommand,
} from '@dag/command.js'
import type { VerifyCheck } from '@dag/definition/schema.js'
import { fileIdentity, sameFile } from './capabilities.js'
import type {
  Candidate,
  ContributionRequest,
  HandoffProgress,
} from './types.js'
import {
  artifacts,
  assertTarget,
  git,
  persist,
  settled,
  snapshot,
  WorkspaceError,
} from './workspace.js'
export class ContributionChecks {
  constructor(
    readonly request: ContributionRequest,
    private readonly candidate: Candidate,
  ) {}

  assertFixed(): void {
    const { request, candidate } = this
    const { validationWorktree: root, revision: commit, tree } = candidate
    settled(root)
    if (
      snapshot(root, commit, root !== request.target.root) !== tree ||
      git(root, ['rev-parse', 'HEAD']).trim() !== commit ||
      git(root, ['write-tree']).trim() !== tree
    )
      throw new WorkspaceError('source-mutating-check', root)
    if (
      JSON.stringify(artifacts(request.artifacts, request.outputs)) !==
      JSON.stringify(candidate.artifacts)
    )
      throw new WorkspaceError('artifact-mutating-check', request.artifacts)
    assertTarget(request.target)
  }
  private retainedCheck(
    check: ContributionRequest['checks'][number],
    directory: string,
    unobserved: readonly string[] = this.request.durable?.read().unobserved?.[
      this.request.checks.indexOf(check)
    ] ?? [],
  ): string | undefined {
    if (!fs.existsSync(directory))
      throw new WorkspaceError('uncertain-check', directory)
    const entries = fs
      .readdirSync(directory)
      .filter((entry) => !unobserved.includes(entry))
    const commands = entries.filter((entry) => entry.startsWith('command-'))
    const records = entries.filter((entry) =>
      /^observed-[0-9]+\.json$/.test(entry),
    )
    if (commands.length !== records.length || records.length === 0)
      throw new WorkspaceError('uncertain-check', directory)
    let receipt: string | undefined
    for (const number of records
      .map((entry) => Number(entry.slice(9, -5)))
      .sort((a, b) => a - b)) {
      if (receipt) throw new WorkspaceError('uncertain-check', directory)
      const path = join(directory, `observed-${number}.json`)
      const recorded = recordedCheck(path, directory, commands)
      if (this.validCheckObservation(recorded, check)) receipt = recorded
    }
    return receipt
  }
  private validCheckObservation(receipt: string, check: VerifyCheck): boolean {
    const { request, candidate } = this
    const observed: unknown = JSON.parse(fs.readFileSync(receipt, 'utf8'))
    if (
      !observed ||
      typeof observed !== 'object' ||
      !('identity' in observed) ||
      JSON.stringify(observed.identity) !==
        JSON.stringify({ ...request.identity, revision: candidate.revision }) ||
      !('argv' in observed) ||
      JSON.stringify(observed.argv) !== JSON.stringify(check.argv) ||
      !('cwd' in observed) ||
      observed.cwd !== candidate.validationWorktree ||
      !('receipt' in observed) ||
      observed.receipt !== receipt ||
      !('status' in observed) ||
      !('exitCode' in observed) ||
      (observed.status !== 'completed' && observed.status !== 'interrupted') ||
      (observed.status === 'completed' && observed.exitCode !== 0)
    )
      throw new WorkspaceError('changed-check', receipt)
    return observed.status === 'completed'
  }
  private async executeCandidateCheck(
    check: ContributionRequest['checks'][number],
    directory: string,
  ): Promise<CommandObservation> {
    const { request, candidate } = this
    const observed = await executeCommand({
      argv: check.argv,
      cwd: candidate.validationWorktree,
      artifacts: check.artifacts ?? request.artifacts,
      runner: directory,
      outputs: [],
      identity: { ...request.identity, revision: candidate.revision },
      signal: request.signal,
      artifactInputs: check.artifactInputs ?? request.artifactInputs ?? [],
    })
    if (request.resumable) {
      const number = fs
        .readdirSync(directory)
        .filter((entry) => entry.startsWith('observed-')).length
      const record = join(directory, `observed-${number}.json`)
      persist(record, {
        receipt: observed.receipt,
        evidence: [observed.receipt, observed.stdout, observed.stderr].map(
          fileIdentity,
        ),
      })
      if (request.durable) {
        const index = request.checks.indexOf(check)
        const progress = request.durable.read()
        const bound = fileIdentity(record)
        const { [index]: _decision, ...repeat } = progress.repeat
        request.durable.write({
          ...progress,
          repeat,
          observations: {
            ...progress.observations,
            [index]: [...(progress.observations[index] ?? []), bound],
          },
          ...(observed.status === 'completed' && observed.exitCode === 0
            ? { completed: { ...progress.completed, [index]: bound } }
            : {}),
        })
      }
    }
    this.assertFixed()
    return observed
  }
  private finalizeCandidateChecks(checks: {
    readonly receipts: readonly string[]
    readonly fresh: readonly CommandObservation[]
  }): readonly string[] {
    const { request, candidate } = this
    const { receipts, fresh } = checks
    for (const observation of fresh)
      if (commandClaim(observation).outcome !== 'claimed-complete')
        throw new WorkspaceError('failed-check', observation.receipt)
    if (request.resume && request.resumable)
      for (const [index, check] of request.checks.entries()) {
        const directory = join(request.runner, `check-${index}`)
        if (this.retainedCheck(check, directory) !== receipts[index])
          throw new WorkspaceError('changed-check', directory)
      }
    if (request.signal.aborted)
      throw new WorkspaceError('interrupted', request.runner)
    if (
      snapshot(
        request.worktree,
        request.baseline,
        request.worktree !== request.target.root,
      ) !== candidate.tree
    )
      throw new WorkspaceError('changed-submission', request.worktree)
    this.assertFixed()
    return receipts
  }
  private resumeCandidateCheck(
    check: ContributionRequest['checks'][number],
    index: number,
    directory: string,
  ): string | undefined {
    const { request } = this
    if (!request.durable) throw new WorkspaceError('uncertain-check', directory)
    const progress = request.durable.read()
    if (!checkWasStarted(progress, index, directory)) return undefined
    const observed = progress.observations[index] ?? []
    const unobserved = progress.unobserved?.[index] ?? []
    const extra = unobservedCheckEntries(directory, observed, unobserved)
    const expected = progress.completed[index]
    if (
      expected &&
      JSON.stringify(expected) !== JSON.stringify(observed.at(-1))
    )
      throw new WorkspaceError('changed-check', expected.path)
    const receipt =
      observed.length > 0
        ? this.retainedCheck(check, directory, [...unobserved, ...extra])
        : undefined
    if (Boolean(receipt) !== Boolean(expected))
      throw new WorkspaceError('uncertain-check', directory)
    if (receipt) {
      if (extra.length > 0) throw new WorkspaceError('changed-check', directory)
      return receipt
    }
    request.durable.repeat(index, observed.at(-1))
    if (extra.length === 0) return undefined
    const current = request.durable.read()
    request.durable.write({
      ...current,
      unobserved: {
        ...current.unobserved,
        [index]: [...unobserved, ...extra],
      },
    })
    return undefined
  }
  private beginCandidateCheck(index: number, directory: string): void {
    const durable = this.request.durable
    if (durable) {
      const progress = durable.read()
      if (!progress.started.includes(index))
        durable.write({ ...progress, started: [...progress.started, index] })
    }
    fs.mkdirSync(directory, { recursive: true })
  }
  async run(): Promise<readonly string[]> {
    const { request } = this
    this.assertFixed()
    const receipts: string[] = []
    const fresh: CommandObservation[] = []
    for (const [index, check] of request.checks.entries()) {
      if (request.signal.aborted)
        throw new WorkspaceError('interrupted', request.runner)
      const directory = request.resumable
        ? join(request.runner, `check-${index}`)
        : request.runner
      const receipt =
        request.resume && request.resumable
          ? this.resumeCandidateCheck(check, index, directory)
          : undefined
      if (receipt) {
        receipts.push(receipt)
        this.assertFixed()
        continue
      }
      this.beginCandidateCheck(index, directory)
      const observed = await this.executeCandidateCheck(check, directory)
      fresh.push(observed)
      receipts.push(observed.receipt)
    }
    return this.finalizeCandidateChecks({ receipts, fresh })
  }
}

function recordedCheck(
  path: string,
  directory: string,
  commands: readonly string[],
): string {
  if (
    !fs.existsSync(path) ||
    fs.realpathSync(path) !== path ||
    !fs.lstatSync(path).isFile()
  )
    throw new WorkspaceError('changed-check', path)
  const record: unknown = JSON.parse(fs.readFileSync(path, 'utf8'))
  if (
    !record ||
    typeof record !== 'object' ||
    !('receipt' in record) ||
    typeof record.receipt !== 'string' ||
    !('evidence' in record) ||
    !Array.isArray(record.evidence) ||
    record.evidence.length !== 3
  )
    throw new WorkspaceError('changed-check', path)
  const receipt = record.receipt
  if (
    !commands.includes(dirname(receipt).split(sep).at(-1) ?? '') ||
    dirname(dirname(receipt)) !== directory ||
    receipt !== join(dirname(receipt), 'receipt.json')
  )
    throw new WorkspaceError('changed-check', path)
  for (const entry of record.evidence) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('path' in entry) ||
      typeof entry.path !== 'string' ||
      !('sha256' in entry) ||
      !('bytes' in entry) ||
      !fs.existsSync(entry.path) ||
      fs.realpathSync(entry.path) !== entry.path ||
      JSON.stringify(fileIdentity(entry.path)) !== JSON.stringify(entry)
    )
      throw new WorkspaceError('changed-check', path)
  }
  return receipt
}
function unobservedCheckEntries(
  directory: string,
  observed: readonly ArtifactIdentity[],
  unobserved: readonly string[],
): readonly string[] {
  const entries = fs.existsSync(directory) ? fs.readdirSync(directory) : []
  const records = entries.filter(
    (name) =>
      /^observed-[0-9]+\.json$/.test(name) && !unobserved.includes(name),
  )
  if (
    observed.some(
      (item) =>
        !records.some((name) => item.path === join(directory, name)) ||
        !sameFile(item),
    )
  )
    throw new WorkspaceError('changed-check', directory)
  const commands = entries.filter((name) => name.startsWith('command-'))
  const receipts = observed.map((item) =>
    recordedCheck(item.path, directory, commands),
  )
  return [
    ...records.filter(
      (name) => !observed.some((item) => item.path === join(directory, name)),
    ),
    ...commands.filter(
      (name) =>
        !unobserved.includes(name) &&
        !receipts.includes(join(directory, name, 'receipt.json')),
    ),
  ]
}
function checkWasStarted(
  progress: HandoffProgress,
  index: number,
  directory: string,
): boolean {
  const started = progress.started.includes(index)
  if (!started && fs.existsSync(directory))
    throw new WorkspaceError('uncertain-check', directory)
  return started
}
