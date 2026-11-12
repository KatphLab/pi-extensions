import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { parseReviewReport } from '@dag/definition/schema.js'
import { acceptedInput } from '@dag/workspace/capabilities.js'
import type {
  AcceptedContribution,
  Prerequisite,
} from '@dag/workspace/types.js'
import { fileIdentity, verdictEnvelope } from './checkpoint.js'
import type { RunContext } from './context.js'
import { RunError } from './error.js'

/** Both projections share one proof; only the logical handoff omits sibling edits. */
export function reviewedResult(
  run: RunContext,
  name: string,
): { readonly handoff: Prerequisite; readonly target: Prerequisite } {
  const verdict = reviewedVerdict(run, name)
  const final = run.checkpoint.accepted
  if (!final) throw new RunError('unreviewed-input', name)
  const write = Object.values(run.request.definition.nodes).flatMap(
    (node) => node.write,
  )
  const code = write.length > 0 ? logicalCode(run, name, final) : final
  const artifacts =
    run.state.assignments[run.reviewId]?.attempts.at(-1)?.artifacts
  const target: Prerequisite = {
    id: `reviewed.${name}`,
    needs: [],
    write,
    reviewedCode: write.length > 0,
    reviewVerdict: fileIdentity(verdict),
    checks: run.request.definition.verify,
    input: acceptedInput(final),
    ...(artifacts ? { artifacts } : {}),
  }
  return {
    handoff:
      code === final ? target : { ...target, input: acceptedInput(code) },
    target,
  }
}

function reviewedVerdict(run: RunContext, name: string): string {
  const attempt = run.state.assignments[run.reviewId]?.attempts.at(-1)
  const verdict = attempt ? join(attempt.runner, 'verdict.json') : ''
  if (
    run.state.status !== 'succeeded' ||
    !attempt?.report ||
    parseReviewReport(fs.readFileSync(attempt.report, 'utf8')).verdict !==
      'approved' ||
    !fs.existsSync(verdict)
  )
    throw new RunError('unreviewed-input', name)
  // Export the verdict that was accepted, not whatever bytes sit at its path:
  // the saved envelope must still describe this attempt's inputs and report.
  const saved = verdictEnvelope(fs.readFileSync(verdict, 'utf8'))
  const boundPath = attempt.inputs?.['path']
  const boundSha = attempt.inputs?.['sha256']
  if (
    saved?.verdict !== 'approved' ||
    !boundPath ||
    !boundSha ||
    saved.input.path !== boundPath ||
    saved.input.sha256 !== boundSha ||
    fileIdentity(boundPath).sha256 !== boundSha ||
    saved.report.path !== attempt.report ||
    saved.report.sha256 !== fileIdentity(attempt.report).sha256
  )
    throw new RunError('stale-verdict', name)
  const snapshot = run.state.snapshots['recovery']
  if (
    !snapshot ||
    fileIdentity(snapshot).sha256 !== run.state.snapshots['recoverySha256']
  )
    throw new RunError('missing-checkpoint', name)
  if (
    run.state.assignments[run.integrationId] &&
    run.state.assignments[run.integrationId]?.attempts.at(-1)
      ?.acceptedRevision !== run.checkpoint.accepted?.revision
  )
    throw new RunError('unreviewed-input', name)
  return verdict
}

function logicalCode(
  run: RunContext,
  name: string,
  final: AcceptedContribution,
): AcceptedContribution {
  const branch = run.preparations.get(run.branchPreparationId)
  if (final.changedPaths.length > 0 && !run.checkpoint.reviewed)
    throw new RunError('integration-edits-need-reviewed-branch', final.receipt)
  const code =
    run.checkpoint.reviewed ??
    run.contributions.find((item) => item.revision === branch?.revision)
  if (!code)
    throw new RunError('missing-reviewed-branch', name, {
      cause: new Error(
        JSON.stringify({
          branch: branch?.revision,
          contributions: run.contributions.map((item) => item.revision),
        }),
      ),
    })
  assertBranchMatchesTarget(run.state.target.root, code, final)
  return code
}

/** The logical code tip may omit unrelated approved siblings, but not reviewed edits. */
function assertBranchMatchesTarget(
  root: string,
  branch: AcceptedContribution,
  final: AcceptedContribution,
): void {
  for (const path of branch.changedPaths) {
    const objects = [branch.revision, final.revision].map((revision) =>
      spawnSync(
        'git',
        ['-C', root, 'rev-parse', '--verify', `${revision}:${path}`],
        {
          env: { ...process.env, GIT_MASTER: '1' },
          encoding: 'utf8',
        },
      ),
    )
    const [logical, integrated] = objects
    if (
      !logical ||
      !integrated ||
      logical.status !== integrated.status ||
      logical.stdout.trim() !== integrated.stdout.trim()
    )
      throw new RunError('changed-reviewed-branch', path, {
        cause: new Error(
          JSON.stringify({
            branch: branch.revision,
            final: final.revision,
            logical: {
              status: logical?.status,
              object: logical?.stdout.trim(),
            },
            integrated: {
              status: integrated?.status,
              object: integrated?.stdout.trim(),
            },
          }),
        ),
      })
  }
}
