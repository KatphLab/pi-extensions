import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { acceptedInput } from './capabilities.js'
import { checkpointWorkspace, restoreWorkspace } from './checkpoint.js'
import { acceptContribution } from './contribution.js'
import { preparePrerequisites } from './prerequisites.js'
import {
  checkpointOwner,
  cleanupWorkspace,
  fixture,
  git,
  preparation,
  prerequisite,
} from './test-fixture.js'

afterEach(cleanupWorkspace)
test('checkpoint restoration grants no partial acceptance when later evidence has changed', async () => {
  const request = fixture()
  const first = await acceptContribution({ ...request, checks: [] })
  const second = await prerequisite(request, {
    id: 'second',
    needs: [],
    baseline: first.revision,
    path: 'allowed/second',
    bytes: 'second output',
    checks: [],
  })
  const baseline = await preparePrerequisites(
    preparation(request, [second], [second.id]),
  )
  const contributions = [first, second.input.contribution]
  expect(() =>
    checkpointWorkspace(request.target, {
      contributions: [{ ...first }],
      preparations: new Map(),
    }),
  ).toThrow('unobserved-acceptance')
  expect(() =>
    checkpointWorkspace(request.target, {
      contributions,
      preparations: new Map([['second', { ...baseline }]]),
    }),
  ).toThrow('unobserved-preparation')
  const workspace = structuredClone(
    checkpointWorkspace(request.target, {
      contributions,
      preparations: new Map([['second', baseline]]),
    }),
  )
  const { owner, save } = checkpointOwner(request)
  save(workspace)
  const checkpoint = owner.recoveryCheckpoint()
  const read = spyOn(owner, 'recoveryCheckpoint').mockReturnValue({
    ...checkpoint,
    value: { workspace },
  })
  fs.appendFileSync(
    second.input.contribution.handoff,
    'changed after checkpoint',
  )
  try {
    expect(() => restoreWorkspace(owner)).toThrow('stale-input-evidence')
    for (const entry of workspace.accepted)
      expect(() => acceptedInput(entry.input.contribution)).toThrow(
        'unobserved-acceptance',
      )
    expect(git(request.target.root, ['rev-parse', 'HEAD'])).toBe(
      request.baseline,
    )
    expect(
      fs.readFileSync(
        join(second.input.contribution.validationWorktree, 'allowed/second'),
        'utf8',
      ),
    ).toBe('second output')
  } finally {
    read.mockRestore()
  }
})

test('cross-run checkpoint imports require the reviewed input and cannot widen its accepted scope', async () => {
  const request = fixture()
  fs.writeFileSync(join(request.worktree, 'allowed/edit'), 'imported edit')
  const contribution = await acceptContribution({ ...request, checks: [] })
  const input = acceptedInput(contribution)
  const workspace = checkpointWorkspace(request.target, {
    contributions: [contribution],
    preparations: new Map(),
  })
  const { owner, save } = checkpointOwner(request, 'consumer')
  save(workspace)
  expect(() => restoreWorkspace(owner)).toThrow('checkpoint-provenance')
  save({
    ...workspace,
    accepted: workspace.accepted.map((entry) => ({
      ...entry,
      write: ['allowed/', 'outside'],
    })),
  })
  expect(() => restoreWorkspace(owner, [input])).toThrow(
    'checkpoint-provenance',
  )
  save(workspace)
  const restored = restoreWorkspace(owner, [input])
  const accepted = restored.contributions.get(contribution.receipt)
  if (!accepted) throw new Error('missing imported contribution')
  expect(acceptedInput(accepted)).toEqual(input)
  expect(
    checkpointWorkspace(request.target, {
      contributions: [accepted],
      preparations: restored.preparations,
    }),
  ).toEqual(workspace)
  expect(git(request.target.root, ['rev-parse', 'HEAD'])).toBe(request.baseline)
})
