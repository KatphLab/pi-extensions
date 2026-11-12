import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ArtifactIdentity } from '@dag/command.js'
import { artifactIdentity, isWithin } from '@dag/files.js'
import {
  addRuntimeExcludes,
  identifyTarget,
  type TargetIdentity,
} from '@dag/state.js'
import type { ContributionRequest, WorktreeRequest } from './types.js'

export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    readonly resource: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: inspect ${resource}; existing work is retained`, options)
    this.name = 'WorkspaceError'
  }
}
export function workspaceFailure(
  error: unknown,
  code: string,
  resource: string,
): WorkspaceError {
  return error instanceof WorkspaceError
    ? error
    : new WorkspaceError(code, resource, {
        cause: error instanceof Error ? error : new Error(String(error)),
      })
}
export function git(
  root: string,
  args: readonly string[],
  options: { readonly index?: string; readonly input?: string } = {},
): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-C',
      root,
      ...args,
    ],
    {
      env: {
        ...process.env,
        GIT_MASTER: '1',
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_INDEX_FILE: options.index,
        GIT_OBJECT_DIRECTORY: undefined,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      },
      input: options.input,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  )
  if (result.error || result.status !== 0)
    throw new WorkspaceError('git', root, {
      cause:
        result.error ??
        new Error(
          `${args.join(' ')} (exit ${result.status}): ${result.stderr}`,
        ),
    })
  return result.stdout
}
export function revision(root: string, value: string): string {
  // Only complete object identities travel across the workspace boundary.
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))
    throw new WorkspaceError('invalid-revision', value)
  return git(root, ['rev-parse', '--verify', `${value}^{commit}`]).trim()
}
export function literal(path: string): void {
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    /[*?[\]{}]/.test(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32) ||
    path
      .replace(/\/$/, '')
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.toLowerCase() === '.git',
      ) ||
    /^\.pi\/dags\/(runs|wt)(\/|$)/.test(path)
  )
    throw new WorkspaceError('invalid-path', path)
}
function physical(root: string, path: string): void {
  let current = resolve(root, path)
  while (!fs.existsSync(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new WorkspaceError('symlink', path)
    const parent = dirname(current)
    if (parent === current) throw new WorkspaceError('path', path)
    current = parent
  }
  if (!isWithin(root, fs.realpathSync(current)))
    throw new WorkspaceError('symlink-escape', path)
}
export function settled(root: string): void {
  const directory = git(root, ['rev-parse', '--absolute-git-dir']).trim()
  for (const entry of [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
    'index.lock',
  ])
    if (fs.existsSync(join(directory, entry)))
      throw new WorkspaceError('pending-git-operation', join(directory, entry))
}
/** A launch identity is an exact checkout, not merely a shared repository. */
export function captureTarget(root: string): TargetIdentity {
  const target = identifyTarget(root)
  assertTarget(target)
  return Object.freeze(target)
}
const authorities = new Map<string, () => TargetIdentity>()
/** Installed only by the live parent owner; no saved worker data can advance it. */
export function authorizeTarget(
  root: string,
  current: () => TargetIdentity,
): () => void {
  if (authorities.has(root)) throw new WorkspaceError('target-authority', root)
  authorities.set(root, current)
  return () => {
    authorities.delete(root)
  }
}
export function assertTarget(target: TargetIdentity): void {
  const expected = authorities.get(target.root)?.() ?? target
  const actual = identifyTarget(target.root)
  if (
    fs.realpathSync(
      git(target.root, ['rev-parse', '--show-toplevel']).trim(),
    ) !== target.root ||
    actual.root !== target.root ||
    actual.commonDirectory !== target.commonDirectory ||
    actual.gitDirectory !== target.gitDirectory ||
    actual.branch !== target.branch ||
    actual.expectedRevision !== expected.expectedRevision
  )
    throw new WorkspaceError('target-identity', target.root)
  settled(target.root)
  if (
    git(target.root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]) !== '' ||
    snapshot(target.root, expected.expectedRevision, false) !==
      git(target.root, [
        'rev-parse',
        `${expected.expectedRevision}^{tree}`,
      ]).trim()
  )
    throw new WorkspaceError('dirty-target', target.root)
}
export function names(request: WorktreeRequest): void {
  if (
    ![request.runId, request.assignment].every(
      (id) =>
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) && id !== '.' && id !== '..',
    ) ||
    !Number.isSafeInteger(request.attempt) ||
    request.attempt < 0
  )
    throw new WorkspaceError('invalid-worktree-identity', request.assignment)
}
export function prepareWorktree(
  target: TargetIdentity,
  request: WorktreeRequest,
): string {
  names(request)
  assertTarget(target)
  revision(target.root, request.baseline)
  addRuntimeExcludes(target)
  const root = join(target.root, '.pi/dags/wt', request.runId)
  physical(target.root, relative(target.root, root))
  fs.mkdirSync(root, { recursive: true })
  const path = join(
    root,
    `${request.assignment}-${request.attempt}-${request.role}`,
  )
  if (fs.existsSync(path)) throw new WorkspaceError('existing-worktree', path)
  git(target.root, ['worktree', 'add', '--detach', path, request.baseline])
  return fs.realpathSync(path)
}
export function snapshot(root: string, baseline: string, full = true): string {
  const directory = git(root, ['rev-parse', '--absolute-git-dir']).trim()
  const index = join(directory, `dag-index-${randomUUID()}`)
  try {
    git(root, ['read-tree', baseline], { index })
    // Force includes ignored/untracked files and private-commit additions. The source checkout has no runner runtime resources.
    git(root, ['add', '--all', ...(full ? ['--force'] : []), '--', '.'], {
      index,
    })
    return git(root, ['write-tree'], { index }).trim()
  } finally {
    fs.rmSync(index, { force: true })
    fs.rmSync(`${index}.lock`, { force: true })
  }
}
export function artifacts(
  root: string,
  outputs: readonly string[],
): readonly ArtifactIdentity[] {
  return outputs.map((path) => {
    literal(path)
    if (
      path.endsWith('/') ||
      path
        .split('/')
        .some((part) =>
          ['runner', 'outcome.json', 'handoff.md', 'review.json'].includes(
            part,
          ),
        )
    )
      throw new WorkspaceError('invalid-output', path)
    const absolute = resolve(root, path)
    physical(root, path)
    if (!fs.lstatSync(absolute, { throwIfNoEntry: false })?.isFile())
      throw new WorkspaceError('invalid-artifact', path)
    return artifactIdentity(absolute)
  })
}
export function persist(path: string, value: unknown): void {
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
}

export function scopedPaths(
  request: Pick<ContributionRequest, 'worktree' | 'baseline' | 'write'>,
  tree: string,
): readonly string[] {
  const paths = git(request.worktree, [
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '--no-renames',
    '-r',
    '-z',
    request.baseline,
    tree,
  ])
    .split('\0')
    .filter(Boolean)
  for (const path of paths) {
    literal(path)
    physical(request.worktree, path)
    if (
      !request.write.some((scope) =>
        scope.endsWith('/') ? path.startsWith(scope) : path === scope,
      )
    )
      throw new WorkspaceError('out-of-scope', path)
  }
  if (
    git(request.worktree, ['ls-tree', '-r', tree])
      .split('\n')
      .some((line) => line.startsWith('160000 '))
  )
    throw new WorkspaceError('nested-repository', request.worktree)
  return Object.freeze(paths)
}
export function assertRetainedValidation(
  target: TargetIdentity,
  worktree: string,
): void {
  if (!fs.existsSync(worktree))
    throw new WorkspaceError('missing-worktree', worktree)
  const actual = identifyTarget(worktree)
  if (
    fs.realpathSync(worktree) !== worktree ||
    actual.root !== worktree ||
    actual.commonDirectory !== target.commonDirectory
  )
    throw new WorkspaceError('changed-worktree', worktree)
}
