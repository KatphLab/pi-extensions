import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attemptLayout, RunOwner } from '@dag/state.js'
import { acceptedInput } from './capabilities.js'
import { acceptContribution } from './contribution.js'
import type {
  ContributionRequest,
  HandoffProgress,
  Prerequisite,
  PrerequisiteRequest,
} from './types.js'
import {
  captureTarget,
  prepareWorktree,
  git as workspaceGit,
} from './workspace.js'

const roots: string[] = []
const owners: RunOwner[] = []
export function cleanupWorkspace(): void {
  for (const owner of owners.splice(0)) owner.release()
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
}

export function git(root: string, args: readonly string[]): string {
  return workspaceGit(root, args).trim()
}
export function fixture(): ContributionRequest {
  const root = fs.mkdtempSync(join(tmpdir(), 'workspace-'))
  roots.push(root)
  git(root, ['init', '-b', 'fixture'])
  git(root, ['config', 'user.name', 'Fixture'])
  git(root, ['config', 'user.email', 'fixture@localhost'])
  fs.mkdirSync(join(root, 'allowed'))
  for (const [path, bytes] of Object.entries({
    'allowed/edit': 'before',
    'allowed/delete': 'delete me',
    'allowed/rename': 'rename me',
    outside: 'user original',
  }))
    fs.writeFileSync(join(root, path), bytes)
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'fixture baseline'])
  const target = captureTarget(root)
  const identity = {
    runId: 'run',
    assignment: 'maker',
    attempt: 0,
    revision: target.launchRevision,
  }
  const worktree = prepareWorktree(target, {
    ...identity,
    baseline: identity.revision,
    role: 'assignment',
  })
  const layout = attemptLayout(join(root, '.pi/dags/runs/run'), 'maker', 0)
  fs.writeFileSync(join(layout.artifacts, 'result.txt'), 'required output')
  return {
    target,
    identity,
    baseline: identity.revision,
    worktree,
    ...layout,
    write: ['allowed/'],
    outputs: ['result.txt'],
    checks: [
      {
        id: 'read',
        argv: [
          process.execPath,
          '-e',
          "if (await Bun.file('allowed/edit').text() !== 'before') process.exit(1)",
        ],
      },
    ],
    signal: new AbortController().signal,
  }
}
export function acceptedRefs(request: ContributionRequest): string {
  return git(request.target.root, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/pi-dags/run/maker/0/accepted',
  ])
}
export function check(source: string): ContributionRequest['checks'] {
  return [{ id: 'check', argv: [process.execPath, '-e', source] }]
}
export function checkpointOwner(request: ContributionRequest, runId = 'run') {
  const runDirectory = join(request.target.root, '.pi/dags/runs', runId)
  const owner = RunOwner.acquire({ target: request.target, runDirectory })
  owners.push(owner)
  return {
    owner,
    save: (workspace: unknown): void => {
      const path = join(runDirectory, 'recovery-workspace.json')
      const bytes = JSON.stringify({ workspace })
      fs.writeFileSync(path, bytes)
      owner.write({
        schema: 1,
        runId,
        status: 'paused',
        target: request.target,
        snapshots: {
          recovery: path,
          recoverySha256: createHash('sha256').update(bytes).digest('hex'),
        },
        revisions: [],
        assignments: {},
        repairRounds: {},
        cycle: null,
        needsAuthor: null,
      })
    },
  }
}
export async function prerequisite(
  request: ContributionRequest,
  node: {
    readonly id: string
    readonly needs: readonly string[]
    readonly baseline: string
    readonly path: string
    readonly bytes: string
    readonly checks?: ContributionRequest['checks']
  },
): Promise<Prerequisite> {
  const { id, needs, baseline, path, bytes } = node
  const identity = { ...request.identity, assignment: id, revision: baseline }
  const worktree = prepareWorktree(request.target, {
    ...identity,
    baseline,
    role: 'assignment',
  })
  const layout = attemptLayout(
    join(request.target.root, '.pi/dags/runs/run'),
    id,
    0,
  )
  fs.writeFileSync(join(worktree, path), bytes)
  fs.writeFileSync(join(layout.artifacts, 'result.txt'), `${id} result`)
  const checks =
    node.checks ??
    check(
      `if (await Bun.file(${JSON.stringify(path)}).text() !== ${JSON.stringify(bytes)}) process.exit(1)`,
    )
  const contribution = await acceptContribution({
    ...request,
    ...layout,
    identity,
    worktree,
    baseline,
    write: ['allowed/'],
    checks,
  })
  return {
    id,
    needs,
    write: ['allowed/'],
    checks,
    input: acceptedInput(contribution),
  }
}
export function preparation(
  request: ContributionRequest,
  accepted: readonly Prerequisite[],
  needs: readonly string[],
): PrerequisiteRequest {
  const layout = attemptLayout(
    join(request.target.root, '.pi/dags/runs/run'),
    request.identity.assignment === 'maker'
      ? 'join'
      : request.identity.assignment,
    0,
  )
  return {
    target: request.target,
    identity: {
      ...request.identity,
      assignment:
        request.identity.assignment === 'maker'
          ? 'join'
          : request.identity.assignment,
    },
    ...layout,
    needs,
    accepted,
    signal: request.signal,
  }
}

export function handoffProgress(runner: string) {
  const path = join(runner, 'progress.json')
  fs.writeFileSync(
    path,
    JSON.stringify({
      started: [],
      observations: {},
      repeat: {},
      completed: {},
    }),
  )
  return {
    read: (): HandoffProgress => JSON.parse(fs.readFileSync(path, 'utf8')),
    write: (progress: HandoffProgress): void => {
      fs.writeFileSync(path, JSON.stringify(progress))
    },
  }
}
