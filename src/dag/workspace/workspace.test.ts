import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { executeCommand } from '@dag/command.js'
import { attemptLayout } from '@dag/state.js'
import { acceptContribution } from './contribution.js'
import {
  acceptedRefs,
  check,
  cleanupWorkspace,
  fixture,
  git,
} from './test-fixture.js'
import type { ContributionRequest } from './types.js'
import { assertTarget, captureTarget, prepareWorktree } from './workspace.js'

afterEach(cleanupWorkspace)

describe('accepted scoped contribution', () => {
  test.each([2, 3])(
    'command artifacts cross the generic input seam and require workflow verification (factor %i)',
    async (factor) => {
      const sourceRequest = fixture()
      fs.writeFileSync(join(sourceRequest.artifacts, 'result.txt'), '21')
      const source = await acceptContribution(sourceRequest)
      const identity = {
        ...sourceRequest.identity,
        assignment: 'consumer',
        revision: source.revision,
      }
      const worktree = prepareWorktree(sourceRequest.target, {
        ...identity,
        baseline: source.revision,
        role: 'assignment',
      })
      const request = {
        ...sourceRequest,
        ...attemptLayout(
          join(sourceRequest.target.root, '.pi/dags/runs/run'),
          'consumer',
          0,
        ),
        identity,
        worktree,
        baseline: source.revision,
        write: [],
        artifactInputs: source.artifacts.map((artifact) => ({
          assignment: 'maker',
          path: 'result.txt',
          artifact,
        })),
        checks: check(`
        const inputs = await Bun.file(process.env.DAG_INPUTS_FILE).json();
        const input = inputs.find(item => item.assignment === 'maker' && item.path === 'result.txt');
        const original = Number(await Bun.file(input.artifact.path).text());
        const result = Number(await Bun.file(process.env.DAG_EVIDENCE_DIR + '/result.txt').text());
        if (result !== original * 2) process.exit(1);
      `),
      }
      const producer = await executeCommand({
        ...request,
        cwd: worktree,
        argv: [
          process.execPath,
          '-e',
          `
        const inputs = await Bun.file(process.env.DAG_INPUTS_FILE).json();
        const input = inputs.find(item => item.assignment === 'maker' && item.path === 'result.txt');
        const value = Number(await Bun.file(input.artifact.path).text());
        await Bun.write(process.env.DAG_EVIDENCE_DIR + '/result.txt', String(value * ${factor}));
      `,
        ],
      })
      expect(producer.status).toBe('completed')
      if (factor === 2) {
        const accepted = await acceptContribution({ ...request, producer })
        expect(fs.readFileSync(accepted.artifacts[0]?.path ?? '', 'utf8')).toBe(
          '42',
        )
      } else {
        await expect(
          acceptContribution({ ...request, producer }),
        ).rejects.toMatchObject({ code: 'failed-check' })
        expect(
          git(request.target.root, [
            'for-each-ref',
            '--format=%(refname)',
            'refs/pi-dags/run/consumer/0/accepted',
          ]),
        ).toBe('')
      }
      expect(fs.readFileSync(source.artifacts[0]?.path ?? '', 'utf8')).toBe(
        '21',
      )
    },
  )
  test('checks a canonical baseline-parented tree containing committed, untracked, deleted and renamed files', async () => {
    const request = fixture()
    fs.writeFileSync(join(request.worktree, 'allowed/edit'), 'after')
    fs.unlinkSync(join(request.worktree, 'allowed/delete'))
    fs.renameSync(
      join(request.worktree, 'allowed/rename'),
      join(request.worktree, 'allowed/renamed'),
    )
    git(request.worktree, ['add', '-A'])
    git(request.worktree, ['commit', '-m', 'private worker history'])
    const privateHead = git(request.worktree, ['rev-parse', 'HEAD'])
    const producer = await executeCommand({
      ...request,
      cwd: request.worktree,
      argv: [
        process.execPath,
        '-e',
        "await Bun.write('allowed/untracked', 'new bytes')",
      ],
    })
    const result = await acceptContribution({
      ...request,
      producer,
      checks: check(
        "if (await Bun.file('allowed/edit').text() !== 'after' || await Bun.file('allowed/untracked').text() !== 'new bytes' || await Bun.file('allowed/renamed').text() !== 'rename me' || await Bun.file('allowed/delete').exists()) process.exit(1)",
      ),
    })
    expect(
      git(request.worktree, ['rev-list', '--parents', '-1', result.revision]),
    ).toBe(`${result.revision} ${request.baseline}`)
    expect(result.revision).not.toBe(privateHead)
    expect(git(result.validationWorktree, ['rev-parse', 'HEAD^{tree}'])).toBe(
      result.tree,
    )
    expect(result.changedPaths).toEqual([
      'allowed/delete',
      'allowed/edit',
      'allowed/rename',
      'allowed/renamed',
      'allowed/untracked',
    ])
    expect(git(request.target.root, ['rev-parse', result.acceptedRef])).toBe(
      result.revision,
    )
    const receipt = JSON.parse(
      fs.readFileSync(result.receipts[0] ?? '', 'utf8'),
    )
    expect({
      revision: receipt.identity.revision,
      cwd: receipt.cwd,
      status: receipt.status,
    }).toEqual({
      revision: result.revision,
      cwd: result.validationWorktree,
      status: 'completed',
    })
    expect(
      JSON.parse(fs.readFileSync(result.receipt, 'utf8')).artifacts[0],
    ).toMatchObject({
      path: join(request.artifacts, 'result.txt'),
      bytes: 15,
      sha256: createHash('sha256').update('required output').digest('hex'),
    })
    expect(fs.existsSync(result.handoff)).toBe(true)
    expect(git(request.worktree, ['rev-parse', 'HEAD'])).toBe(privateHead)
    expect(
      fs.readFileSync(join(request.target.root, 'allowed/edit'), 'utf8'),
    ).toBe('before')
  })
})

describe('rejected candidate preserves work', () => {
  test.each(['committed', 'ignored'])(
    'rejects the entire submission with unauthorized %s content',
    async (kind) => {
      const request = fixture()
      fs.writeFileSync(
        join(request.worktree, 'allowed/edit'),
        'authorized repair bytes',
      )
      switch (kind) {
        case 'committed':
          fs.writeFileSync(
            join(request.worktree, 'outside'),
            'unauthorized committed',
          )
          git(request.worktree, ['add', '.'])
          git(request.worktree, ['commit', '-m', 'private unauthorized'])
          break
        case 'ignored':
          fs.appendFileSync(
            join(request.target.commonDirectory, 'info/exclude'),
            'extra\n',
          )
          fs.writeFileSync(
            join(request.worktree, 'extra'),
            'unauthorized ignored',
          )
          break
        default:
          throw new Error(kind satisfies never)
      }
      const before = git(request.worktree, [
        'status',
        '--porcelain',
        '--untracked-files=all',
      ])
      const head = git(request.worktree, ['rev-parse', 'HEAD'])
      await expect(acceptContribution(request)).rejects.toMatchObject({
        code: 'out-of-scope',
      })
      expect(acceptedRefs(request)).toBe('')
      expect(
        fs.readFileSync(join(request.worktree, 'allowed/edit'), 'utf8'),
      ).toBe('authorized repair bytes')
      expect(
        git(request.worktree, [
          'status',
          '--porcelain',
          '--untracked-files=all',
        ]),
      ).toBe(before)
      expect(git(request.worktree, ['rev-parse', 'HEAD'])).toBe(head)
      if (kind === 'committed')
        expect(fs.readFileSync(join(request.worktree, 'outside'), 'utf8')).toBe(
          'unauthorized committed',
        )
      if (kind === 'ignored')
        expect(fs.readFileSync(join(request.worktree, 'extra'), 'utf8')).toBe(
          `unauthorized ${kind}`,
        )
    },
  )
  test.each([
    {
      name: 'failed check with success stdout',
      source: "console.log('ALL CHECKS PASSED'); process.exit(7)",
      code: 'failed-check',
    },
    {
      name: 'source mutation',
      source: "await Bun.write('allowed/edit', 'mutated')",
      code: 'source-mutating-check',
    },
    {
      name: 'artifact mutation',
      source:
        "await Bun.write(process.env.DAG_EVIDENCE_DIR + '/result.txt', 'replaced')",
      code: 'artifact-mutating-check',
    },
  ])(
    'retains a fixed candidate but refuses $name',
    async ({ source, code }) => {
      const request = fixture()
      await expect(
        acceptContribution({ ...request, checks: check(source) }),
      ).rejects.toMatchObject({ code })
      const candidate = JSON.parse(
        fs.readFileSync(join(request.runner, 'candidate.json'), 'utf8'),
      )
      expect(fs.existsSync(candidate.validationWorktree)).toBe(true)
      expect(
        git(request.target.root, [
          'rev-parse',
          'refs/pi-dags/run/maker/0/candidate',
        ]),
      ).toBe(candidate.revision)
      expect(acceptedRefs(request)).toBe('')
      expect(fs.existsSync(join(request.runner, 'accepted-handoff.md'))).toBe(
        false,
      )
      expect(
        fs.readFileSync(join(request.worktree, 'allowed/edit'), 'utf8'),
      ).toBe('before')
      expect(
        fs.readFileSync(join(request.target.root, 'outside'), 'utf8'),
      ).toBe('user original')
    },
  )
  test('requires regular confined outputs but accepts prose without formatting or size gates', async () => {
    const request = fixture()
    fs.unlinkSync(join(request.artifacts, 'result.txt'))
    await expect(acceptContribution(request)).rejects.toMatchObject({
      code: 'invalid-artifact',
    })
    expect(acceptedRefs(request)).toBe('')
    const output = join(request.artifacts, 'result.txt')
    fs.mkdirSync(output)
    await expect(acceptContribution(request)).rejects.toMatchObject({
      code: 'invalid-artifact',
    })
    fs.rmdirSync(output)
    fs.symlinkSync(join(request.worktree, 'allowed/edit'), output)
    await expect(acceptContribution(request)).rejects.toMatchObject({
      code: 'symlink-escape',
    })
    fs.unlinkSync(output)
    const local = join(request.artifacts, 'local.txt')
    fs.writeFileSync(local, 'Local artifact')
    fs.symlinkSync(local, output)
    await expect(acceptContribution(request)).rejects.toMatchObject({
      code: 'invalid-artifact',
    })
    expect(acceptedRefs(request)).toBe('')
    fs.unlinkSync(output)
    const content = 'Free-form prose.\n'.repeat(8192)
    fs.writeFileSync(output, content)
    const accepted = await acceptContribution(request)
    expect(acceptedRefs(request)).not.toBe('')
    expect(fs.readFileSync(accepted.artifacts[0]?.path ?? '', 'utf8')).toBe(
      content,
    )
  })
})
describe('rejected candidate preserves work', () => {
  test('refuses symlink escape without touching external content', async () => {
    const request = fixture()
    fs.symlinkSync(request.target.root, join(request.worktree, 'allowed/link'))
    await expect(acceptContribution(request)).rejects.toMatchObject({
      code: 'symlink-escape',
    })
    expect(acceptedRefs(request)).toBe('')
    expect(fs.readlinkSync(join(request.worktree, 'allowed/link'))).toBe(
      request.target.root,
    )
  })
  test('refuses dirty, switched and hidden-dirty original targets without overwriting edits', async () => {
    const request = fixture()
    fs.writeFileSync(join(request.target.root, 'outside'), 'external edit')
    await expect(acceptContribution(request)).rejects.toMatchObject({
      code: 'dirty-target',
    })
    git(request.target.root, ['update-index', '--assume-unchanged', 'outside'])
    expect(() => assertTarget(request.target)).toThrow('dirty-target')
    expect(fs.readFileSync(join(request.target.root, 'outside'), 'utf8')).toBe(
      'external edit',
    )
    git(request.target.root, ['switch', '-c', 'other'])
    expect(() => assertTarget(request.target)).toThrow('target-identity')
    expect(acceptedRefs(request)).toBe('')
  })
  test('refuses target drift during a check while retaining both check and user changes', async () => {
    const request = fixture()
    await expect(
      acceptContribution({
        ...request,
        checks: check(
          `await Bun.write(${JSON.stringify(join(request.target.root, 'outside'))}, 'external drift')`,
        ),
      }),
    ).rejects.toMatchObject({ code: 'dirty-target' })
    expect(fs.readFileSync(join(request.target.root, 'outside'), 'utf8')).toBe(
      'external drift',
    )
    expect(acceptedRefs(request)).toBe('')
  })
  test('refuses stale input, malformed scope, foreign worktree and already interrupted acceptance', async () => {
    const request = fixture()
    for (const [update, code] of [
      [
        { identity: { ...request.identity, revision: 'bad' } },
        'stale-baseline',
      ],
      [{ write: ['../outside'] }, 'invalid-path'],
      [{ worktree: request.target.root }, 'worker-identity'],
      [{ signal: AbortSignal.abort() }, 'interrupted'],
    ] satisfies readonly (readonly [Partial<ContributionRequest>, string])[]) {
      await expect(
        acceptContribution({ ...request, ...update }),
      ).rejects.toMatchObject({ code })
    }
    expect(acceptedRefs(request)).toBe('')
    expect(() => captureTarget(join(request.target.root, 'allowed'))).toThrow(
      'target-identity',
    )
    expect(() =>
      prepareWorktree(request.target, {
        runId: '../escape',
        assignment: 'a',
        attempt: 0,
        baseline: request.baseline,
        role: 'assignment',
      }),
    ).toThrow('invalid-worktree-identity')
  })
  test('refuses changed submission, stale runner receipts and forged producer observations', async () => {
    const request = fixture()
    const producer = await executeCommand({
      ...request,
      cwd: request.worktree,
      argv: [process.execPath, '-e', "console.log('completed')"],
    })
    await expect(
      acceptContribution({ ...request, producer: { ...producer } }),
    ).rejects.toMatchObject({
      code: 'acceptance',
      cause: { code: 'unobserved-receipt' },
    })
    const result = acceptContribution({
      ...request,
      checks: check(
        'await Bun.write(' +
          JSON.stringify(join(request.worktree, 'allowed/edit')) +
          ', "changed during checking")',
      ),
    })
    await expect(result).rejects.toMatchObject({ code: 'changed-submission' })
    expect(acceptedRefs(request)).toBe('')
    expect(
      fs.readFileSync(join(request.worktree, 'allowed/edit'), 'utf8'),
    ).toBe('changed during checking')
    const second = fixture()
    const replaceReceipt =
      'import * as fs from "node:fs"; const root = ' +
      JSON.stringify(second.runner) +
      '; const folder = fs.readdirSync(root).find(n => n.startsWith("command-") && fs.existsSync(root + "/" + n + "/receipt.json")); fs.writeFileSync(root + "/" + folder + "/receipt.json", "forged success");'
    await expect(
      acceptContribution({
        ...second,
        checks: [...second.checks, ...check(replaceReceipt)],
      }),
    ).rejects.toMatchObject({
      code: 'acceptance',
      cause: { code: 'stale-receipt' },
    })
    expect(acceptedRefs(second)).toBe('')
  })
})
