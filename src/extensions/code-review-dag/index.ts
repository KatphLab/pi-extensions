import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const authoringSkill = fileURLToPath(
  new URL('../../../skills/writing-dags/SKILL.md', import.meta.url),
)

const reviewInstructions = `Author an executable code-review DAG, not the review itself.
Your deliverable is a locally validated workflow definition, not code findings.
Inspect only enough source to establish scope and useful assignments; do not launch reviewers.
Read the writing-dags skill at ${JSON.stringify(authoringSkill)} for minimal
topology, profiles, schema, required controls, validation and optional YAML review.
If unavailable, report the missing prerequisite rather than inventing a schema.

## Establish the review boundary

Use the requested scope and applicable repository rules. With no narrower scope,
inventory first-party source and tests in the current checkout. Exclude dependencies,
generated/build files, retained worktrees, .pi/dags/ artifacts, binaries and secrets.
List untracked candidates separately and confirm their inclusion.

For a base-branch comparison, pin base, HEAD and their merge-base (three-dot semantics).
For a commit, pin its parent comparison; ask which parent for a merge. Uncommitted
scope includes staged and unstaged changes. Reject invalid refs or empty diffs instead
of switching to a whole-codebase audit. Use matching revision context for a supplied
patch/PR and report unavailable evidence. Preserve user files and Git state.

Find supplied requirements and relevant repository documentation. If the spec is
unavailable, state that limitation; ask only when it prevents defining the requested
review. Record the target, exclusions and supporting rules in the YAML.

## Assign coherent work

Follow the skill's one-assignment starting point. Keep implementation, callers,
consumers and tests for a responsibility together. Split broad scopes at concrete
responsibility or attention boundaries, not file/line quotas or an aspect-by-file
cross-product. Name each assignment's paths and relevant symbols/ranges so the
requested scope is accounted for without requiring a separate coverage matrix.

The following are review questions, not a mandatory set of specialist nodes.
Include the questions relevant to the user's request in each focused assignment:
- Standards: cite documented rules; distinguish them from generic preferences.
- Correctness: trace reachable failures, state transitions and resource handling.
- Functionality: compare behavior with supplied requirements and public contracts.
- Simplicity and maintainability: identify concrete unnecessary work or maintenance
  burden; preserve justified boundaries and safety guarantees.
- Duplication: compare behavior and control/data flow, including renamed logic that
  JSCPD misses. Cite both locations, meaningful differences and whether an existing
  implementation should be shared or the domains should remain separate.
- Test value: identify the behavior and surviving protection for any proposed
  deletion or merge; preserve distinct regressions and use pruning guidance when available.
- Security and performance: assess relevant trust boundaries and evidenced hot paths;
  distinguish demonstrated consequences from untested hypotheses.

Keep analogous implementations and producer/consumer seams in the same assignment
when feasible. Add a cross-group comparison only for a specific unanswered question.
Preserve separate Standards and Spec assessments, not necessarily separate agents.
Unexamined scope must be reported; a narrower topology must not silently drop requirements.

## Produce useful reports, not bookkeeping

Use a report-only DAG with empty project write scopes. Workers write declared report
artifacts and mandatory runtime controls, not source changes. Required command execution
belongs in command nodes/checks with separate authority, not shell instructions to workers.

A concise Markdown report states inspected scope, findings or no findings, and gaps.
Findings need file/line evidence, a concrete trigger and impact, priority, confidence,
the smallest correction and verification guidance. Distinguish demonstrated defects,
optional cleanup and unresolved questions; include counterevidence. Change reviews
separate introduced defects from pre-existing issues. An ordinary code finding is
report output, not a workflow blocker. Missing evidence is a limitation, not a reason
to invent a defect or broaden the assignment.

Use the skill's consumer-driven output and synthesis rules. If synthesis is needed,
deduplicate root causes and reconcile conflicts from the reports; keep provenance and
gaps without redoing every source review. Semantic adequacy belongs in independent
review; add structured report contracts only for an actual machine consumer.

## Validate and hand off

Generate the workflow at .pi/dags/<dag-name>.yaml relative to the target project
root, not the extension package's checkout. Choose a descriptive valid name and
keep the filename and top-level name aligned. Ask before overwriting an existing DAG.
Keep required workflow-owned supporting files under .pi/dags/; leave source, tooling
and Git tracking unchanged.

Run ordinary local validation through writing-dags without paid model probes.
Return the YAML path, scope, brief reasons for any split or synthesis, profile
configuration, validation result and remaining prerequisites. Stop before running
the generated code-review DAG. Paid YAML review is optional and needs a separately
authorized budget; target execution requires its own approval.`

export default function codeReviewDagExtension(pi: ExtensionAPI): void {
  pi.registerCommand('code-review-dag', {
    description:
      'Ask the agent to author a bounded code-review DAG, not review code',
    handler: (args) => {
      const scope =
        args.trim() ||
        'Review first-party source and tests in the current checkout.'
      pi.sendUserMessage(
        `${reviewInstructions}\n\n## Requested scope or requirement\n\n${scope}`,
        { deliverAs: 'followUp' },
      )
      return Promise.resolve()
    },
  })
}
