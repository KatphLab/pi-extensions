import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  DagDefinition,
  PlanRevision,
  Profile,
  ReviewReport,
} from '@dag/definition/schema.js'
import { artifactIdentity as identity } from '@dag/files.js'
import { RunContext } from '@dag/run/context.js'
import { RunLifecycle } from '@dag/run/lifecycle.js'
import type { ManagedDag, RunRequest } from '@dag/run/types.js'
import {
  atomicWrite,
  type DagRunOwner,
  type RunState,
  type TargetIdentity,
} from '@dag/state.js'
import type { AcceptedContribution } from '@dag/workspace/types.js'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { PlanRunRequest } from './types.js'
export const approved: ReviewReport = {
  verdict: 'approved',
  summary: 'The pinned result meets its criteria',
  findings: [],
}
const profile: Profile = {
  model: 'fixture/reviewer',
  size: 'large',
}
const limits = { concurrency: 2, nodeRetries: 0, repairCycles: 1 }
export function createFixture(
  needs: Readonly<Record<string, readonly string[]>>,
  runtime: ModelRuntime,
) {
  const root = fs.realpathSync(
    fs.mkdtempSync(join(tmpdir(), 'composition-unit-')),
  )
  const target: TargetIdentity = {
    root,
    commonDirectory: join(root, 'git'),
    gitDirectory: join(root, 'git'),
    branch: 'main',
    launchRevision: 'base',
    expectedRevision: 'base',
  }
  const dags = Object.fromEntries(
    Object.entries(needs).map(([id, prerequisites]) => {
      const dag: DagDefinition = {
        schema: 1,
        kind: 'dag',
        name: id,
        goal: `Deliver ${id}`,
        criteria: { value: 'The agreed value is available' },
        limits,
        integration: { profile: 'reviewer' },
        review: { profile: 'reviewer' },
        verify: [],
        stages: ['integration', 'checks', 'review'],
        nodes: {
          maker: {
            kind: 'agent',
            task: `Deliver ${id}`,
            needs: [],
            references: [],
            write: [`${id}.ts`],
            outputs: ['proof.txt'],
            satisfies: ['value'],
            verify: [],
          },
        },
      }
      return [
        id,
        {
          kind: 'file' as const,
          file: join(root, `${id}.yaml`),
          needs: prerequisites,
          satisfies: ['complete'],
          definition: dag,
        },
      ]
    }),
  )
  const planPath = join(root, 'plan.yaml')
  const revision: PlanRevision = {
    id: 'revision-1',
    plan: {
      schema: 1,
      kind: 'plan',
      name: 'unit-plan',
      goal: 'Deliver the composed result',
      criteria: { complete: 'All reviewed contributions work together' },
      limits,
      review: { profile: 'reviewer' },
      verify: [],
      dags,
      stages: ['checks', 'review'],
      path: planPath,
      projectRoot: root,
      profilesPath: join(root, 'profiles.yaml'),
      documents: {
        plan: {
          path: planPath,
          content: 'authored plan',
          sha256: '0'.repeat(64),
        },
      },
    },
    assignments: {
      dags: Object.fromEntries(
        Object.entries(dags).map(([id, entry]) => {
          const maker = entry.definition.nodes['maker']
          if (!maker) throw new Error('expected a maker node')
          return [
            id,
            {
              nodes: {
                maker: {
                  id: 'maker',
                  node: maker,
                  goal: entry.definition.goal,
                  criteria: entry.definition.criteria,
                  context: '',
                  profile,
                  skills: [],
                  instructions: [],
                },
              },
              integration: profile,
              review: profile,
              profiles: { reviewer: profile },
            },
          ]
        }),
      ),
      review: profile,
      profiles: { reviewer: profile },
    },
    review: {
      receipt: {
        verdict: 'approved',
        reviewerProfile: 'reviewer',
        documents: [{ path: planPath, sha256: '0'.repeat(64) }],
        evidencePath: join(root, 'plan-review.json'),
      },
      source: 'independent plan review',
      evidence: { path: join(root, 'plan-review.json'), content: 'approved' },
    },
  }
  const controller = new AbortController()
  const runId = 'plan-run'
  const runDirectory = join(root, '.pi/dags/runs', runId)
  const contributions = new Map<string, AcceptedContribution>()
  return {
    root,
    target,
    revision,
    runDirectory,
    contributions,
    request: { revision, runId, runtime, signal: controller.signal },
    recovery: { runDirectory, runtime, signal: controller.signal },
  }
}
export type Fixture = {
  root: string
  target: TargetIdentity
  revision: PlanRevision
  runDirectory: string
  contributions: Map<string, AcceptedContribution>
  request: PlanRunRequest
  recovery: {
    runDirectory: string
    runtime: ModelRuntime
    signal: AbortSignal
  }
}
export function state(f: Fixture, runId = f.request.runId): RunState {
  return {
    schema: 1,
    runId,
    status: 'running',
    target: f.target,
    snapshots: {},
    revisions: [],
    assignments: {},
    repairRounds: {},
    cycle: null,
    needsAuthor: null,
  }
}
export function savedChild(f: Fixture, id: string): RunState {
  const directory = join(f.runDirectory, 'dags', id)
  const artifacts = join(directory, 'artifacts')
  const runner = join(directory, 'runner')
  fs.mkdirSync(artifacts, { recursive: true })
  fs.mkdirSync(runner, { recursive: true })
  if (!f.contributions.has(id)) {
    const proof = join(artifacts, 'proof.txt')
    fs.writeFileSync(proof, `${id} evidence\n`)
    atomicWrite(join(runner, 'review.json'), approved)
    atomicWrite(join(runner, 'review-inputs.json'), '{"inputs":[]}')
    atomicWrite(join(runner, 'verdict.json'), {
      input: identity(join(runner, 'review-inputs.json')),
      report: identity(join(runner, 'review.json')),
      verdict: approved,
    })
    atomicWrite(join(directory, 'recovery-unit.json'), { phase: 'review' })
    f.contributions.set(id, {
      baseline: 'base',
      revision: 'base',
      tree: 'accepted-tree',
      changedPaths: [],
      validationWorktree: f.root,
      artifacts: [identity(proof)],
      receipts: [],
      acceptedRef: `refs/accepted/${id}`,
      receipt: join(runner, 'acceptance.json'),
      handoff: join(artifacts, 'handoff.md'),
    })
  }
  const attempt = {
    number: 0,
    baseline: 'base',
    worktree: f.root,
    artifacts,
    runner,
    inputs: {
      path: join(runner, 'review-inputs.json'),
      sha256: identity(join(runner, 'review-inputs.json')).sha256,
    },
    receipts: [],
  }
  const recovery = join(directory, 'recovery-unit.json')
  return {
    ...state(f, `${f.request.runId}.${id}`),
    status: 'succeeded',
    snapshots: { recovery, recoverySha256: identity(recovery).sha256 },
    assignments: {
      maker: {
        stage: 'accepted',
        retries: 0,
        attempts: [{ ...attempt, acceptedRevision: 'base' }],
      },
      integration: {
        stage: 'accepted',
        retries: 0,
        attempts: [{ ...attempt, acceptedRevision: 'base' }],
      },
      review: {
        stage: 'accepted',
        retries: 0,
        attempts: [{ ...attempt, report: join(runner, 'review.json') }],
      },
    },
  }
}
export function managedChild(
  f: Fixture,
  id: string,
  owner: DagRunOwner,
  request: RunRequest,
): ManagedDag {
  const current = savedChild(f, id)
  const accepted = f.contributions.get(id)
  if (!accepted) throw new Error(`expected a contribution for ${id}`)
  const base = Object.values(request.assignments.nodes)[0]
  if (!base) throw new Error(`expected an assignment for ${id}`)
  const run = new RunContext(request, owner, base)
  run.state = current
  run.checkpoint = {
    phase: 'review',
    accepted,
    reviewed: accepted,
    contributions: [accepted],
    controls: [],
  }
  run.contributions.push(accepted)
  run.restoredInputs = [
    { contribution: accepted, evidence: accepted.artifacts },
  ]
  run.restoredMerges = [`merge.${id}`]
  const lifecycle = new RunLifecycle(run)
  const publish = (status: RunState['status']) => {
    run.state = { ...run.state, status }
    owner.write(run.state)
    return { runDirectory: owner.runDirectory, state: run.state }
  }
  return {
    get managedResult() {
      return lifecycle.managedResult
    },
    reviewedResult(name) {
      return lifecycle.reviewedResult(name)
    },
    executeWorkers() {
      return Promise.resolve(publish('running'))
    },
    executeCycle() {
      return Promise.resolve(publish('succeeded'))
    },
    restoreManaged(saved) {
      run.state = saved
      return Promise.resolve()
    },
    repairFromOverall(report) {
      const path = join(owner.runDirectory, 'repair-needs-author.json')
      atomicWrite(path, report)
      run.state = { ...run.state, needsAuthor: path }
      publish('needs-author')
      return Promise.resolve()
    },
    invalidateForUpstream() {
      run.checkpoint = { ...run.checkpoint, phase: 'worker' }
      publish('running')
    },
  }
}
