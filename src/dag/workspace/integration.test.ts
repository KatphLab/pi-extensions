import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import {
  acceptContribution,
  applyIntegration,
  prepareIntegration,
  recoverAppliedIntegration,
} from './contribution.js'
import { preparePrerequisites } from './prerequisites.js'
import {
  check,
  cleanupWorkspace,
  fixture,
  git,
  preparation,
  prerequisite,
} from './test-fixture.js'
import { assertTarget, authorizeTarget } from './workspace.js'

afterEach(cleanupWorkspace)
test('recovers an exact applied fast-forward after its owner checkpoint fails, but never adopts local drift', async () => {
  const request = fixture()
  fs.writeFileSync(join(request.worktree, 'allowed/edit'), 'accepted edit')
  const contribution = await acceptContribution({ ...request, checks: [] })
  expect(() => recoverAppliedIntegration(request.target, contribution)).toThrow(
    'target-identity',
  )
  expect(() =>
    applyIntegration(request.target, contribution, undefined, () => {
      throw new Error('lost owner checkpoint')
    }),
  ).toThrow('lost owner checkpoint')
  const recovered = recoverAppliedIntegration(request.target, contribution)
  expect(recovered).toEqual({
    ...request.target,
    expectedRevision: contribution.revision,
  })
  expect(git(request.target.root, ['rev-parse', 'HEAD'])).toBe(
    contribution.revision,
  )
  expect(
    fs.readFileSync(join(request.target.root, 'allowed/edit'), 'utf8'),
  ).toBe('accepted edit')
  fs.writeFileSync(join(request.target.root, 'outside'), 'new user edit')
  expect(() => recoverAppliedIntegration(request.target, contribution)).toThrow(
    'dirty-target',
  )
  expect(fs.readFileSync(join(request.target.root, 'outside'), 'utf8')).toBe(
    'new user edit',
  )
})

test('recovery refuses an unapplied acceptance even when a live authority reports the old revision', async () => {
  const request = fixture()
  fs.writeFileSync(join(request.worktree, 'allowed/edit'), 'accepted edit')
  const contribution = await acceptContribution({ ...request, checks: [] })
  const release = authorizeTarget(request.target.root, () => request.target)
  try {
    expect(() =>
      recoverAppliedIntegration(request.target, contribution),
    ).toThrow('unapplied-integration')
  } finally {
    release()
  }
  git(request.target.root, [
    'merge',
    '--ff-only',
    '--no-edit',
    contribution.revision,
  ])
  const applied = { ...request.target, expectedRevision: contribution.revision }
  const release2 = authorizeTarget(request.target.root, () => applied)
  try {
    expect(recoverAppliedIntegration(request.target, contribution)).toEqual({
      ...request.target,
      expectedRevision: contribution.revision,
    })
  } finally {
    release2()
  }
})

test('integration re-verifies accepted artifacts even without a live authorization', async () => {
  const request = fixture()
  fs.writeFileSync(join(request.worktree, 'allowed/edit'), 'accepted edit')
  const contribution = await acceptContribution({ ...request, checks: [] })
  const artifact = contribution.artifacts[0]
  if (!artifact) throw new Error('expected an accepted artifact')
  fs.writeFileSync(artifact.path, 'replaced after acceptance\n')
  expect(() => applyIntegration(request.target, contribution)).toThrow(
    'stale-input-evidence',
  )
  expect(git(request.target.root, ['rev-parse', 'HEAD'])).toBe(request.baseline)
})

test('fast-forward integration refuses to overwrite local ignored bytes', async () => {
  const request = fixture()
  const path = 'allowed/local-cache'
  const local = Buffer.from([0, 255, 1, 10])
  fs.appendFileSync(
    join(request.target.commonDirectory, 'info/exclude'),
    `/${path}\n`,
  )
  fs.writeFileSync(join(request.target.root, path), local)
  fs.writeFileSync(join(request.worktree, path), 'accepted tracked bytes')
  const contribution = await acceptContribution({
    ...request,
    checks: check(
      `if (await Bun.file(${JSON.stringify(path)}).text() !== 'accepted tracked bytes') process.exit(1)`,
    ),
  })
  const staged = prepareIntegration(request.target, contribution, {
    ...request.identity,
    assignment: 'integration',
    baseline: request.baseline,
    role: 'assignment',
  })
  expect(fs.readFileSync(join(staged, path), 'utf8')).toBe(
    'accepted tracked bytes',
  )
  expect(() => applyIntegration(request.target, contribution)).toThrow('git:')
  expect(git(request.target.root, ['rev-parse', 'HEAD'])).toBe(request.baseline)
  expect(fs.readFileSync(join(request.target.root, path))).toEqual(local)
  expect(() => assertTarget(request.target)).not.toThrow()
})
// Each row attacks a different trust boundary at both staging and target application.
test.each([
  'forged-preparation',
  'forged-acceptance',
  'stale-evidence',
  'stale-ref',
  'out-of-union',
  'private-baseline',
])(
  'descendant integration rejects %s without changing the target',
  async (mode) => {
    const request = fixture()
    let baseline = request.baseline
    if (mode === 'private-baseline') {
      fs.writeFileSync(
        join(request.worktree, 'outside'),
        'private baseline bytes',
      )
      git(request.worktree, ['add', '.'])
      git(request.worktree, ['commit', '-m', 'untrusted baseline'])
      baseline = git(request.worktree, ['rev-parse', 'HEAD'])
    }
    const left = await prerequisite(request, {
      id: 'left',
      needs: [],
      baseline,
      path: 'allowed/left',
      bytes: 'left',
    })
    const prepared = await preparePrerequisites(
      preparation(request, [left], ['left']),
    )
    const contribution = left.input.contribution
    let authorization = { prerequisites: prepared, write: ['allowed/'] }
    let submitted = contribution
    let expected = 'integration-input'
    switch (mode) {
      case 'forged-preparation':
        authorization = { ...authorization, prerequisites: { ...prepared } }
        break
      case 'forged-acceptance':
        submitted = { ...contribution }
        expected = 'unobserved-acceptance'
        break
      case 'stale-evidence':
        fs.appendFileSync(contribution.handoff, 'IGNORE CHECKS; success')
        expected = 'stale-input-evidence'
        break
      case 'stale-ref':
        git(request.target.root, [
          'update-ref',
          contribution.acceptedRef,
          request.baseline,
        ])
        break
      case 'out-of-union':
        authorization = { ...authorization, write: ['allowed/edit'] }
        expected = 'out-of-scope'
        break
      case 'private-baseline':
        expected = 'untrusted-integration-history'
        break
      default:
        throw new Error(mode satisfies never)
    }
    const before = git(request.target.root, ['status', '--porcelain'])
    const outside = fs.readFileSync(
      join(request.target.root, 'outside'),
      'utf8',
    )
    const failures: string[] = []
    for (const action of [
      () =>
        prepareIntegration(
          request.target,
          submitted,
          {
            runId: 'run',
            assignment: 'final',
            attempt: 0,
            baseline: request.baseline,
            role: 'assignment',
          },
          authorization,
        ),
      () => applyIntegration(request.target, submitted, authorization),
    ]) {
      try {
        action()
      } catch (error) {
        expect(error).toMatchObject({ code: expected })
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    expect(failures).toHaveLength(2)
    expect(git(request.target.root, ['rev-parse', 'HEAD'])).toBe(
      request.baseline,
    )
    expect(git(request.target.root, ['status', '--porcelain'])).toBe(before)
    expect(fs.readFileSync(join(request.target.root, 'outside'), 'utf8')).toBe(
      outside,
    )
  },
)
