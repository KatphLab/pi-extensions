import { afterEach, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { artifactIdentity as identity } from '@dag/files.js'
import type { Checkpoint } from '@dag/run/checkpoint.js'
import { RunContext } from '@dag/run/context.js'
import { RunLifecycle } from '@dag/run/lifecycle.js'
import {
  atomicWrite,
  identifyTarget,
  RunOwner,
  type RunState,
} from '@dag/state.js'
import { acceptedInput, bindAcceptance } from '@dag/workspace/capabilities.js'
import type { AcceptedContribution } from '@dag/workspace/types.js'
import { git } from '@dag/workspace/workspace.js'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createFixture, savedChild, state } from './fixtures.js'

const fixtures: ReviewedBranch[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})

class ReviewedBranch {
  readonly fixture = createFixture(
    { alpha: [], dependent: ['alpha'] },
    Object.create(ModelRuntime.prototype),
  )
  readonly worker: AcceptedContribution
  readonly code: AcceptedContribution
  readonly final: AcceptedContribution
  readonly unchanged: AcceptedContribution
  private readonly owner: RunOwner
  private readonly run: RunContext
  private readonly instance: RunLifecycle
  private readonly saved: RunState

  constructor() {
    const f = this.fixture
    this.git(['init', '-b', 'main'])
    this.git(['config', 'user.name', 'Fixture'])
    this.git(['config', 'user.email', 'fixture@localhost'])
    const saved = savedChild(f, 'alpha')
    const baseline = this.commit({
      'alpha.ts': 'baseline value\n',
      'sibling.ts': 'unrelated sibling baseline\n',
    })
    const worker = this.commit({ 'alpha.ts': 'worker value\n' })
    this.worker = this.accept('worker', baseline, worker)
    this.git(['switch', '-c', 'integrated'])
    const preparation = this.commit({
      'sibling.ts': 'approved sibling change\n',
    })
    this.unchanged = this.accept('unchanged', preparation, preparation)
    this.final = this.accept(
      'integration',
      preparation,
      this.commit({ 'alpha.ts': 'reviewed integration value\n' }),
    )
    this.git(['switch', '-c', 'reviewed', worker])
    this.code = this.accept(
      'reviewed',
      worker,
      this.commit({ 'alpha.ts': 'reviewed integration value\n' }),
    )
    this.git(['switch', 'integrated'])
    f.target = identifyTarget(f.root)
    const maker = saved.assignments['maker']
    assert.ok(maker)
    const attempt = maker.attempts[0]
    assert.ok(attempt)
    this.saved = {
      ...saved,
      target: f.target,
      assignments: {
        ...saved.assignments,
        maker: {
          ...maker,
          attempts: [{ ...attempt, baseline, acceptedRevision: worker }],
        },
      },
    }
    f.contributions.set('alpha', this.final)
    this.owner = RunOwner.acquire({
      runDirectory: f.runDirectory,
      target: f.target,
    })
    this.owner.write(state(f))
    const entry = f.revision.plan.dags['alpha']
    const assignments = f.revision.assignments.dags['alpha']
    assert.ok(assignments)
    assert.ok(entry)
    assert.ok(entry.kind === 'file')
    const base = assignments.nodes['maker']
    assert.ok(base)
    this.run = new RunContext(
      {
        projectRoot: f.root,
        runId: this.saved.runId,
        definition: entry.definition,
        assignments,
        source: {},
        runtime: f.request.runtime,
        signal: f.request.signal,
      },
      this.owner.child('alpha'),
      base,
    )
    this.instance = new RunLifecycle(this.run)
    fixtures.push(this)
  }

  git(args: readonly string[]): string {
    return git(this.fixture.root, args).trim()
  }

  private commit(files: Readonly<Record<string, string>>): string {
    for (const [path, content] of Object.entries(files))
      fs.writeFileSync(join(this.fixture.root, path), content)
    this.git(['add', '--', ...Object.keys(files)])
    this.git(['commit', '-m', 'reviewed handoff fixture'])
    return this.git(['rev-parse', 'HEAD'])
  }

  private accept(
    id: string,
    baseline: string,
    revision: string,
  ): AcceptedContribution {
    const f = this.fixture
    const proof = f.contributions.get('alpha')
    assert.ok(proof)
    const runner = join(f.runDirectory, 'dags/alpha/runner', id)
    fs.mkdirSync(runner, { recursive: true })
    const accepted: AcceptedContribution = {
      baseline,
      revision,
      tree: this.git(['rev-parse', `${revision}^{tree}`]),
      changedPaths: this.git(['diff', '--name-only', baseline, revision])
        .split('\n')
        .filter(Boolean),
      validationWorktree: f.root,
      artifacts: proof.artifacts,
      receipts: [],
      acceptedRef: `refs/accepted/alpha/${id}`,
      receipt: join(runner, 'accepted.json'),
      handoff: join(runner, 'handoff.md'),
    }
    atomicWrite(accepted.receipt, accepted)
    fs.writeFileSync(accepted.handoff, `${id} accepted code\n`)
    this.git(['update-ref', accepted.acceptedRef, revision])
    bindAcceptance(accepted, ['alpha.ts'])
    return accepted
  }

  handoff(
    code: AcceptedContribution | undefined,
    final = this.final,
    retained: readonly AcceptedContribution[] = [this.worker],
  ) {
    const f = this.fixture
    const contributions = [...retained, final, ...(code ? [code] : [])]
    const checkpoint: Checkpoint = {
      phase: 'review',
      accepted: final,
      contributions,
      controls: [],
      ...(code ? { reviewed: code } : {}),
    }
    const recovery = this.saved.snapshots['recovery']
    assert.ok(recovery)
    atomicWrite(recovery, checkpoint)
    const integration = this.saved.assignments['integration']
    assert.ok(integration)
    const attempt = integration.attempts[0]
    assert.ok(attempt)
    const saved: RunState = {
      ...this.saved,
      target: { ...f.target, expectedRevision: final.revision },
      snapshots: {
        recovery,
        recoverySha256: identity(recovery).sha256,
      },
      assignments: {
        ...this.saved.assignments,
        integration: {
          ...integration,
          attempts: [
            {
              ...attempt,
              baseline: final.baseline,
              acceptedRevision: final.revision,
            },
          ],
        },
      },
    }
    const owner = this.owner.child('alpha')
    owner.write(saved)
    this.run.state = saved
    this.run.checkpoint = checkpoint
    this.run.contributions.length = 0
    this.run.contributions.push(...contributions)
    this.run.preparations.set(this.run.branchPreparationId, {
      revision: this.worker.revision,
      inputs: [acceptedInput(this.worker)],
      direct: [],
    })
    return this.instance.reviewedResult('alpha')
  }

  close(): void {
    this.owner.release()
    fs.rmSync(this.fixture.root, { recursive: true, force: true })
  }
}

test('hands off reviewed integration edits without importing unrelated approved siblings', () => {
  const branch = new ReviewedBranch()
  expect(() => branch.handoff(undefined)).toThrow(
    'integration-edits-need-reviewed-branch',
  )
  const { handoff, target } = branch.handoff(branch.code)
  expect(handoff.input.contribution).toEqual(branch.code)
  expect(
    branch.git(['show', `${handoff.input.contribution.revision}:alpha.ts`]),
  ).toBe('reviewed integration value')
  expect(
    branch.git(['show', `${handoff.input.contribution.revision}:sibling.ts`]),
  ).toBe('unrelated sibling baseline')
  expect(branch.git(['show', `${branch.final.revision}:sibling.ts`])).toBe(
    'approved sibling change',
  )
  expect(target.input.contribution).toEqual(branch.final)
})

test('hands off the original logical branch when integration made no edits', () => {
  const branch = new ReviewedBranch()
  expect(
    branch.handoff(undefined, branch.unchanged).handoff.input.contribution,
  ).toEqual(branch.worker)
  expect(() => branch.handoff(undefined, branch.unchanged, [])).toThrow(
    'missing-reviewed-branch',
  )
})

test('export rejects a substituted verdict even when the approved report still stands', () => {
  const branch = new ReviewedBranch()
  expect(branch.handoff(branch.code).target.input.contribution).toEqual(
    branch.final,
  )
  const runner = join(branch.fixture.runDirectory, 'dags', 'alpha', 'runner')
  const verdict = join(runner, 'verdict.json')
  const saved = fs.readFileSync(verdict, 'utf8')
  try {
    const parsed = JSON.parse(saved)
    fs.writeFileSync(
      verdict,
      JSON.stringify({
        ...parsed,
        report: { ...parsed.report, sha256: 'f'.repeat(64) },
      }),
    )
    expect(() => branch.handoff(branch.code)).toThrow('stale-verdict')
    fs.writeFileSync(
      verdict,
      JSON.stringify({
        ...parsed,
        input: { ...parsed.input, sha256: 'e'.repeat(64) },
      }),
    )
    expect(() => branch.handoff(branch.code)).toThrow('stale-verdict')
  } finally {
    fs.writeFileSync(verdict, saved)
  }
  expect(branch.handoff(branch.code).target.input.contribution).toEqual(
    branch.final,
  )
})

test('rejects a reviewed branch whose declared path content differs from the approved target', () => {
  const branch = new ReviewedBranch()
  expect(() => branch.handoff(branch.worker)).toThrow(
    'changed-reviewed-branch: inspect alpha.ts',
  )
})
