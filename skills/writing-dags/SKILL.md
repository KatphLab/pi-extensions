---

name: writing-dags
description: Write or simplify an executable DAG with the fewest useful assignments, explicit inputs and outputs, local validation and optional authorized YAML review.
---

# Writing DAGs

Deliver the smallest workflow that achieves the requested outcome. A DAG may produce analysis, reports, data or code; repository implementation is not assumed.

## 1. Establish the outcome and scope

Identify the requested result, observable acceptance criteria, available inputs, permitted effects and exclusions. Inspect only the evidence needed to define the work. Resolve missing required inputs or authority.

Start with one `kind: dag` and one coherent assignment. Keep related implementation, callers, tests and rules together. Add an assignment only for useful independent work, a distinct capability or authority boundary, or evidence too broad for focused attention. An edge means the consumer needs the producer's result. Use composition only for independently approved DAGs or an author checkpoint; consult [CLI operations](../../docs/dag-cli.md#composed-plans) then.

**Ready:** the outcome and scope are clear, and each additional assignment has a concrete purpose.

## 2. Write the smallest complete DAG

Read the [YAML reference](references/schema.md). Start from [standalone.yaml](examples/standalone.yaml); use [parallel.yaml](examples/parallel.yaml) only when independent work actually feeds a consumer.

Each task needs a concise action, explicit input paths, exact deliverables, allowed effects, meaningful verification and a completion/blocker condition. Workers do not inherit the author conversation. Put shared facts in `context` once; keep task-specific evidence with its consumer.

- Treat review aspects as questions, not automatic nodes. One focused assignment can assess several aspects of the same evidence; retain separate assessments where their conclusions must remain distinct.
- Use the requested deliverable directly. Add an intermediate artifact only when a consumer needs it. One report needs no synthesis node; multiple reports need synthesis only when the requested result requires reconciliation.
- Keep planning in the YAML and a short handoff. Coverage matrices, decomposition records, range-union checks and reducer trees are additional deliverables only when explicitly requested or necessary for a concrete consumer contract. Explain that need briefly rather than generating bookkeeping to justify bookkeeping.
- Reuse existing commands for deterministic work and `verify` for checks. Add workflow-owned validation only for a required property those checks do not cover. Markdown reports normally need semantic review, not a parallel JSON representation or prose-format checker.
- For report-only work, start with `nodeRetries: 0` and `repairCycles: 0`. Add a retry or repair budget only for an identified recoverable failure, not to keep revising satisfactory reports.

Use the supplied execution profiles. Prefer an economical configured worker when suitable for the task; stronger workers need a capability or quality reason. Consult the [model benchmark reference](references/model-benchmarks.md) when comparing or proposing models, not as a mandatory selection exercise for every node. New models and paid calls need authorization; missing configuration remains a prerequisite. Keep the required large-profile independent result review, integration role for project writes, control reports and `validate_submission`.

**Ready:** every requested criterion has a producer and evidence; dependencies, outputs and checks agree; each node and artifact serves the result rather than merely repeating or documenting another stage.

## 3. Validate locally

Resolve `../../src/dag/cli.ts` relative to this skill's directory. Set `DAG_CLI`, `DEFINITION` and `PROFILES` to absolute paths and run from the target project root:

```sh
bun run "$DAG_CLI" validate "$DEFINITION" --profiles "$PROFILES"
```

Correct structural/resource errors without paid probes. If custom producer/consumer checks are needed, exercise them with one representative valid artifact and one invalid artifact; parsing alone does not establish their contract.

**Ready:** validation passes, or the exact unavailable prerequisite is reported. Structural validation is not proof of model quality.

## 4. Optional YAML review

Use `review-dag` when the user requests it or authorizes it to resolve a material design question. Ordinary authoring does not require a review-and-revise loop. Obtain a model-call and iteration budget before launching:

```sh
bun run "$DAG_CLI" review-dag "$DEFINITION" --profiles "$PROFILES"
```

This command reviews only a standalone YAML snapshot, not referenced implementations or execution profiles, and supplies no initial execution-approval receipt. A clean launch checkout is required; do not stash, reset, commit or move user files to obtain one without authorization. Consult [CLI operations](../../docs/dag-cli.md) for launch prerequisites and monitoring.

Read the accepted final report and address concrete defects or worthwhile changes to the requested outcome. Optional advice can be declined with a brief reason. Revalidate edits; repeat paid review only for material unresolved questions within the authorized budget. Any edit makes the previous snapshot review stale: report that fact rather than claiming final-file approval or chasing wording-only convergence. If YAML review was not requested, report it as not run, not an authoring blocker.

**Ready:** the requested review budget is respected, material findings are dispositioned, and the final file's review status is accurate.

## 5. Hand off; execution is separate

Return the YAML path, concise scope and assignment rationale, execution profiles, validation result, optional review status and remaining prerequisites. Use the YAML's criteria and tasks as the mapping rather than generating a second planning document. Distinguish guidance changes, a corrected workflow and observed model behavior; claim improvement only from relevant executions.

Stop before target execution unless separately authorized. Initial execution approval and independent result review remain required even when optional YAML review is skipped. Consult [CLI operations](../../docs/dag-cli.md) when execution or recovery is requested; never manufacture an approval receipt.
