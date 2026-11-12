import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { attemptLayout } from '@dag/state.js'
import { acceptedInput } from './capabilities.js'
import { checkpointWorkspace, restoreWorkspace } from './checkpoint.js'
import {
  acceptContribution,
  acceptReviewedHandoff,
  applyIntegration,
  prepareIntegration,
  recoverAppliedIntegration,
} from './contribution.js'
import { contributingTips, preparePrerequisites } from './prerequisites.js'
import {
  check,
  checkpointOwner,
  cleanupWorkspace,
  fixture,
  git,
  preparation,
  prerequisite,
} from './test-fixture.js'
import type {
  ContributionRequest,
  Prerequisite,
  PrerequisiteBaseline,
  PrerequisiteRequest,
} from './types.js'

afterEach(cleanupWorkspace)

interface Diamond {
  readonly request: ContributionRequest
  readonly contract: Prerequisite
  readonly left: Prerequisite
  readonly right: Prerequisite
  readonly sibling: Prerequisite
  readonly report: Prerequisite
  readonly accepted: Prerequisite[]
  readonly resumed: { index: number; worktree: string; baseline: string }[]
  readonly result: PrerequisiteBaseline
}

async function prepareDiamond(): Promise<Diamond> {
  const request = fixture()
  const contract = await prerequisite(request, {
    id: 'contract',
    needs: [],
    baseline: request.baseline,
    path: 'allowed/contract',
    bytes: 'contract',
  })
  const left = await prerequisite(request, {
    id: 'left',
    needs: ['contract'],
    baseline: contract.input.contribution.revision,
    path: 'allowed/left',
    bytes: 'left',
  })
  const right = await prerequisite(request, {
    id: 'right',
    needs: ['contract'],
    baseline: contract.input.contribution.revision,
    path: 'allowed/right',
    bytes: 'right',
  })
  const sibling = await prerequisite(request, {
    id: 'sibling',
    needs: [],
    baseline: request.baseline,
    path: 'allowed/sibling',
    bytes: 'sibling',
  })
  const report = await prerequisite(request, {
    id: 'report',
    needs: ['contract'],
    baseline: contract.input.contribution.revision,
    path: 'allowed/contract',
    bytes: 'contract',
  })
  const accepted = [sibling, right, report, contract, left]
  expect(
    contributingTips(
      request.target,
      accepted.map((node) => node.input),
    ),
  ).toEqual(
    [left, right, sibling].map((node) => node.input.contribution.revision),
  )
  const single = await preparePrerequisites(
    preparation(
      { ...request, identity: { ...request.identity, assignment: 'single' } },
      accepted,
      ['contract', 'left'],
    ),
  )
  expect(single.revision).toBe(left.input.contribution.revision)
  const stage = preparation(request, accepted, [
    'right',
    'left',
    'left',
    'report',
  ])
  const progressPath = join(stage.runner, 'preparation-progress.json')
  const durable: NonNullable<PrerequisiteRequest['durable']> = {
    read: () =>
      fs.existsSync(progressPath)
        ? JSON.parse(fs.readFileSync(progressPath, 'utf8'))
        : undefined,
    write: (progress) => {
      fs.writeFileSync(progressPath, JSON.stringify(progress))
    },
    repeat: () => {
      throw new Error('completed prerequisite checks must never repeat')
    },
  }
  const resumed: { index: number; worktree: string; baseline: string }[] = []
  const reviewed = {
    ...stage,
    durable,
    reconcile: async ({
      index,
      worktree,
      baseline,
    }: Parameters<NonNullable<PrerequisiteRequest['reconcile']>>[0]) => {
      resumed.push({ index, worktree, baseline })
      expect(await Bun.file(join(worktree, 'allowed/contract')).text()).toBe(
        'contract',
      )
      if (resumed.length === 1) {
        fs.writeFileSync(
          join(worktree, 'allowed/edit'),
          'retained reconciliation',
        )
        throw new Error('interrupted reconciliation')
      }
      expect(fs.readFileSync(join(worktree, 'allowed/edit'), 'utf8')).toBe(
        'retained reconciliation',
      )
    },
  }
  await expect(preparePrerequisites(reviewed)).rejects.toMatchObject({
    cause: { message: 'interrupted reconciliation' },
  })
  expect(durable.read()).toMatchObject({ phase: 'reconcile', next: 1 })
  const result = await preparePrerequisites(reviewed)
  return {
    request,
    contract,
    left,
    right,
    sibling,
    report,
    accepted,
    resumed,
    result,
  }
}

test('prerequisite diamond restores its checked closure and keeps reviewed handoffs on logical ancestry', async () => {
  const diamond = await prepareDiamond()
  const { request, contract, left, right, report, resumed, result } = diamond
  expect(resumed).toHaveLength(2)
  expect(resumed[1]).toEqual(resumed[0])
  expect(result.inputs.map((input) => input.contribution.revision)).toEqual(
    [contract, left, report, right].map(
      (node) => node.input.contribution.revision,
    ),
  )
  expect(result.direct).toEqual(
    [left, report, right].map((node) => ({
      id: node.id,
      revision: node.input.contribution.revision,
      handoff: node.input.contribution.handoff,
      artifacts: node.input.contribution.artifacts,
    })),
  )
  const ancestry = [contract, left, right].map((node) =>
    git(request.target.root, [
      'merge-base',
      node.input.contribution.revision,
      result.revision,
    ]),
  )
  expect(ancestry).toEqual(
    [contract, left, right].map((node) => node.input.contribution.revision),
  )
  const contents = git(request.target.root, [
    'ls-tree',
    '-r',
    '--name-only',
    result.revision,
  ])
  expect(
    contents.split('\n').filter((path) => path.startsWith('allowed/')),
  ).toEqual([
    'allowed/contract',
    'allowed/delete',
    'allowed/edit',
    'allowed/left',
    'allowed/rename',
    'allowed/right',
  ])
  expect(
    git(request.target.root, [
      'rev-list',
      '--count',
      `${request.baseline}..${result.revision}`,
    ]),
  ).toBe('5')
  const reconciled = result.reconciliation?.contribution
  expect(reconciled?.receipts).toHaveLength(4)
  const receipts = reconciled?.receipts.map((path) =>
    JSON.parse(fs.readFileSync(path, 'utf8')),
  )
  expect(receipts?.map((receipt) => receipt.identity.revision)).toEqual(
    Array(4).fill(result.revision),
  )
  const { applied, final, restoredFinal, restoredPreparation } =
    await integrateDiamond(diamond)
  if (!result.reconciliation) throw new Error('missing reconciliation')
  const handoff = await acceptReviewedHandoff({
    ...request,
    ...attemptLayout(
      join(request.target.root, '.pi/dags/runs/run'),
      'reviewed-diamond',
      0,
    ),
    target: applied,
    identity: {
      ...request.identity,
      assignment: 'reviewed-diamond',
      revision: right.input.contribution.revision,
    },
    branch: right.input.contribution,
    final: restoredFinal,
    preparation: restoredPreparation,
    outputs: [],
    checks: check(
      "if (await Bun.file('allowed/edit').text() !== 'integrated' || await Bun.file('allowed/left').exists()) process.exit(1)",
    ),
  })
  expect(handoff.baseline).toBe(right.input.contribution.revision)
  expect(handoff.changedPaths).toEqual(['allowed/edit'])
  expect(
    fs.readFileSync(join(handoff.validationWorktree, 'allowed/right'), 'utf8'),
  ).toBe('right')
  expect(fs.existsSync(join(handoff.validationWorktree, 'allowed/left'))).toBe(
    false,
  )
  expect(
    fs.existsSync(join(handoff.validationWorktree, 'allowed/sibling')),
  ).toBe(false)
  const completed: Prerequisite = {
    id: 'completed',
    needs: [],
    write: request.write,
    checks: [],
    reviewedCode: true,
    input: acceptedInput(restoredFinal),
    preparation: restoredPreparation,
  }
  const consumer = await preparePrerequisites({
    ...preparation(
      {
        ...request,
        target: applied,
        identity: { ...request.identity, assignment: 'consumer' },
      },
      [completed],
      [completed.id],
    ),
    targetTip: true,
  })
  expect(consumer.revision).toBe(final.revision)
  expect(consumer.inputs.map((input) => input.contribution.revision)).toEqual([
    ...result.inputs.map((input) => input.contribution.revision),
    result.reconciliation.contribution.revision,
    final.revision,
  ])
})
test.each(['stale', 'missing', 'failed-check'] as const)(
  'prerequisite reconciliation blocks consumer on invalid input: %s',
  async (mode) => {
    const request = fixture()
    const checks = check(
      "if (!['left', 'right', 'resolved'].includes(await Bun.file('allowed/edit').text())) process.exit(1)",
    )
    const left = await prerequisite(request, {
      id: 'left',
      needs: [],
      baseline: request.baseline,
      path: 'allowed/edit',
      bytes: 'left',
      checks,
    })
    const right = await prerequisite(request, {
      id: 'right',
      needs: [],
      baseline: request.baseline,
      path: 'allowed/edit',
      bytes: 'right',
      checks,
    })
    const stage = preparation(request, [left, right], ['left', 'right'])
    await expect(
      preparePrerequisites({
        ...stage,
        reconcile: async ({ worktree }) => {
          expect(git(worktree, ['ls-files', '-u'])).not.toBe('')
          await fs.promises.writeFile(
            join(worktree, 'allowed/edit'),
            mode === 'failed-check' ? 'incompatible' : 'resolved',
          )
          git(worktree, ['add', 'allowed/edit'])
          if (mode === 'stale')
            fs.writeFileSync(
              left.input.contribution.handoff,
              'forged acceptance',
            )
          if (mode === 'missing')
            fs.unlinkSync(left.input.contribution.artifacts[0]?.path ?? '')
        },
      }),
    ).rejects.toMatchObject({
      code: {
        stale: 'stale-input-evidence',
        missing: 'prerequisite-evidence',
        'failed-check': 'failed-check',
      }[mode],
    })
    expect(fs.existsSync(join(stage.runner, 'prerequisites.json'))).toBe(false)
    expect(git(request.target.root, ['rev-parse', 'HEAD'])).toBe(
      request.baseline,
    )
  },
)

test.each(['missing-node', 'missing-evidence', 'incompatible', 'integrator'])(
  'refuses prerequisite admission boundary: %s',
  async (mode) => {
    const request = fixture()
    const left = await prerequisite(request, {
      id: 'left',
      needs: [],
      baseline: request.baseline,
      path: 'allowed/left',
      bytes: 'left',
    })
    const right = await prerequisite(request, {
      id: 'right',
      needs: [],
      baseline: request.baseline,
      path: 'allowed/right',
      bytes: 'right',
    })
    const stage = preparation(request, [left, right], ['left', 'right'])
    let update: Partial<PrerequisiteRequest> = {}
    const expected = {
      'missing-node': 'missing-input',
      'missing-evidence': 'missing-input-evidence',
      incompatible: 'incompatible-input',
      integrator: 'integrator-required',
    }[mode]
    switch (mode) {
      case 'missing-node':
        update = { needs: ['absent'] }
        break
      case 'missing-evidence':
        update = {
          accepted: [
            { ...left, input: { ...left.input, evidence: [] } },
            right,
          ],
        }
        break
      case 'incompatible':
        update = {
          accepted: [
            {
              ...left,
              input: {
                ...left.input,
                contribution: {
                  ...left.input.contribution,
                  tree: right.input.contribution.tree,
                },
              },
            },
            right,
          ],
        }
        break
      case 'integrator':
        break
      default:
        throw new Error(mode satisfies never)
    }
    await expect(
      preparePrerequisites({ ...stage, ...update }),
    ).rejects.toMatchObject({ code: expected })
    expect(fs.existsSync(join(stage.runner, 'prerequisites.json'))).toBe(false)
  },
)

async function integrateDiamond(diamond: Diamond) {
  const { request, contract, left, right, sibling, accepted, result } = diamond
  if (!result.reconciliation) throw new Error('missing reconciliation')
  const authorization = { prerequisites: result, write: ['allowed/'] }
  const worktree = prepareIntegration(
    request.target,
    result.reconciliation.contribution,
    {
      runId: 'run',
      assignment: 'final',
      attempt: 0,
      baseline: request.baseline,
      role: 'assignment',
    },
    authorization,
  )
  fs.writeFileSync(join(worktree, 'allowed/edit'), 'integrated')
  git(worktree, ['add', '.'])
  git(worktree, ['commit', '-m', 'private integrator history'])
  const privateHead = git(worktree, ['rev-parse', 'HEAD'])
  const final = await acceptContribution({
    ...request,
    ...attemptLayout(
      join(request.target.root, '.pi/dags/runs/run'),
      'final',
      0,
    ),
    identity: {
      ...request.identity,
      assignment: 'final',
      revision: result.revision,
    },
    worktree,
    baseline: result.revision,
    outputs: [],
    checks: [
      ...[contract, left, right].flatMap((node) =>
        node.checks.map((entry) => ({
          ...entry,
          id: `${node.id}/${entry.id}`,
        })),
      ),
      ...check(
        "if (await Bun.file('allowed/edit').text() !== 'integrated') process.exit(1)",
      ),
    ],
  })
  const workspace = checkpointWorkspace(request.target, {
    contributions: [
      ...accepted.map((node) => node.input.contribution),
      result.reconciliation.contribution,
      final,
    ],
    preparations: new Map([['join', result]]),
  })
  const { owner, save } = checkpointOwner(request)
  save(workspace)
  const restored = restoreWorkspace(owner)
  const restoredFinal = restored.contributions.get(final.receipt)
  const restoredPreparation = restored.preparations.get('join')
  if (!restoredFinal || !restoredPreparation)
    throw new Error('missing restored integration resources')
  expect(
    checkpointWorkspace(request.target, {
      contributions: [...restored.contributions.values()],
      preparations: restored.preparations,
    }),
  ).toEqual(workspace)
  expect(restored.merges).toEqual(
    workspace.merges.map((merge) => merge.revision),
  )
  const restoredAuthorization = {
    prerequisites: restoredPreparation,
    write: request.write,
  }
  const applied = applyIntegration(
    request.target,
    restoredFinal,
    restoredAuthorization,
  )
  expect(
    recoverAppliedIntegration(
      request.target,
      restoredFinal,
      restoredAuthorization,
    ),
  ).toEqual(applied)
  expect(git(request.target.root, ['rev-parse', 'HEAD'])).toBe(final.revision)
  expect(applied.expectedRevision).toBe(final.revision)
  for (const node of [contract, left, right])
    expect(
      git(request.target.root, [
        'merge-base',
        node.input.contribution.revision,
        final.revision,
      ]),
    ).toBe(node.input.contribution.revision)
  expect(
    git(request.target.root, ['merge-base', privateHead, final.revision]),
  ).toBe(result.revision)
  expect(
    git(request.target.root, [
      'merge-base',
      sibling.input.contribution.revision,
      final.revision,
    ]),
  ).toBe(request.baseline)
  expect(
    fs.readFileSync(join(request.target.root, 'allowed/edit'), 'utf8'),
  ).toBe('integrated')
  return { applied, final, restoredFinal, restoredPreparation }
}
