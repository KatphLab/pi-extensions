# DAG CLI operations

For authoring, use the [writing-dags skill](../skills/writing-dags/SKILL.md) and its [YAML reference](../skills/writing-dags/references/schema.md). This document covers installation, execution approval, composition and existing runs; it is not required reading for ordinary DAG authoring.

## Locate the CLI

With Bun installed, `just install-bin` from this package installs the `dag-cli` executable; ensure Bun's global bin directory is on `PATH`. Installation requires authorization. The executable runs Bun-backed source, not a standalone compiled binary.

Without installation, resolve this package's `src/dag/cli.ts` to an absolute `DAG_CLI` path and invoke `bun run "$DAG_CLI"`. Keep the working directory at the target project root; it need not define package scripts. Use `--help` for command grammar. Default bundled-review profiles live at `dag-profiles.yaml` under the host's Pi agent directory (`PI_CODING_AGENT_DIR`); custom `validate`/`run` require explicit `--profiles`.

## File-only DAG review

```text
dag-cli review-dag <dag.yaml> --profiles <profiles.yaml>
```

This invokes the packaged [review-dag.yaml](../src/dag/builtins/review-dag.yaml), never a same-named checkout file. The operand is one standalone DAG, not a plan. Structural preflight rejects malformed/invalid definitions before loading profiles or starting agents. The target's exact content, canonical path and SHA-256 are frozen as review evidence; its referenced resources are not resolved or executed. The packaged [model benchmark reference](../skills/writing-dags/references/model-benchmarks.md) is separately frozen with its path, hash and content, so reviews in other projects receive the same dated selection evidence.

The workflow assesses only that YAML as its workflow subject, using the benchmark reference for advisory model/profile and node-assignment recommendations. It does not inspect referenced code, documentation, skills, tests, CI or target profile configurations, run target commands, generate external profiles or accept historical-run inputs. Execution profiles select review models; they do not establish the target's profile-to-model mappings. Proposed new models require author approval and availability/authentication checks before use; benchmark scores establish neither. All review sessions use `large`; model calls can incur charges. A separate independent reviewer judges the review's adequacy, not the target's implementation or permission to execute it.

Accepted outputs are `design.md`, `correctness.md`, `efficiency.md` and consolidated `review.md`. Reports use free-form Markdown with soft length guidance, not enforced headings or length limits. A supplied runtime baseline informs interpretation without expanding the review subject. Recommendations must identify a concrete consequence, account for existing guarantees and justify added complexity; missing wording or unverifiable external behavior alone is insufficient. Synthesis and independent approval filter recommendations for usefulness separately from dimension coverage; complete coverage with no recommendations is valid. Locate outputs using `summary`. Reviewers write only artifacts/controls, and recommendations are not applied automatically. `review <file>` is an alias; a bare `review` is invalid. Only named bundled review commands skip initial execution approval; passing the bundled YAML directly to `run` is a custom run and requires a receipt.

## Admission and execution approval

Launch execution or bundled review from a clean Git checkout. For iterative authoring, keep uncommitted drafts and configuration outside the launch checkout or use an authorized clean worktree. The CLI can snapshot external YAML; project-relative task paths still refer to the launch project. Do not resolve dirty admission by silently stashing, resetting, committing or moving user files.

Custom runs reserve the target checkout exclusively. Bundled file-only reviews use per-run ownership without acquiring/releasing that reservation, but still enforce clean-target and pinned-revision checks. Concurrent checkout changes can pause review. Both modes create local state/worktrees and are not OS sandboxes. Scoped writes do not authorize arbitrary command effects, network access or credentials.

Ordinary `validate` checks structure, resources and model configuration without executing nodes or creating worktrees. `validate --probe-models` additionally makes potentially paid provider requests, may refresh credentials and needs authorization. Validation is neither semantic approval nor proof of future endpoint availability.

Before a custom `run`, obtain independent large-profile initial review of the actual definition, execution profiles and required domain facts. For `workflow.yaml`, the sibling receipt is `workflow.review.json` with these fields:

```text
verdict: approved
reviewerProfile: configured large profile name
documents: [{path: exact reviewed document, sha256: actual SHA-256}]
evidencePath: existing nonempty independent-review evidence file
```

Standalone admission requires the exact definition and profiles in `documents`; plan admission additionally covers every referenced DAG. Receipt paths resolve from the project root. This field description is not a receipt template to fill with an invented verdict. A file-only `review-dag` success does not supply this approval: profiles and external implementation are outside that review's scope. Hash generation binds evidence but performs no review.

Only after approval, authorization and clean admission:

```text
dag-cli run <definition-or-plan> --profiles <file>
```

Every DAG receives independent large-profile result review after declared checks, including report-only work; plans receive overall review too. Failed checks cannot be overruled, and stale identities invalidate acceptance. Initial review, YAML review and result review have different subjects.

## Monitoring and accounting

`run` and `resume` own foreground execution; there is no daemon or implicit detach. SIGINT/SIGTERM stops admission, owned commands and SDK sessions, retaining checkpoints/workspaces. Cancellation does not roll back integrated work.

For an existing run, observe it rather than starting another execution:

```text
dag-cli watch <absolute-run-dir> --compact
dag-cli summary <absolute-run-dir>
```

Consume changed entries until the observer exits, then call `summary` once and inspect named accepted reports or diagnostic paths. `watch` does not resume work or acquire ownership. It exits on terminal status or missing/stale/ambiguous ownership; observer termination alone does not mean success. Interrupting `watch` stops only the observer. `status <run-dir>` gives durable progress/retry/blocker/report locations without reading usage transcripts or authenticating.

`summary` reports terminal progress, accepted artifact directories, lifecycle timing and persisted per-assignment requests, token categories and model-rate cost estimates. It counts recorded retries/replaced sessions, deduplicates identities and labels incomplete accounting. Estimates are not bills; lifecycle timing does not establish per-stage durations or a measured critical path. Coordinator conversation and readiness probes are excluded; optional `--approval-session <session.jsonl>` inputs label external approval usage separately. Successful summary output does not imply successful execution. Avoid raw transcript/credential inspection when report projections suffice.

| Exit | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| 0    | Successful command; inspect status to distinguish observation/staging from execution success. |
| 1    | Failed/paused execution; watch also uses this for unusable ownership.                         |
| 2    | Usage, validation, readiness or unsafe recovery error.                                        |
| 3    | Needs author.                                                                                 |
| 130  | Signal interruption.                                                                          |

## Recovery and amendments

A monitoring request authorizes no `resume`, `restart` or `amend`. Inspect status and the named evidence first. Retained worktrees, sessions and receipts are recovery evidence, not disposable caches; cleanup needs an explicit decision.

`artifactContracts` and its `maxBytes`/`headings` settings are no longer supported. Remove the whole field from authored definitions before new runs. This is a breaking schema change: recover older frozen runs containing it using the code revision that created them, without editing saved snapshots, evidence or receipts. Revised definitions need fresh review/approval as applicable. Only JSON control reports retain a 32 KiB limit; Markdown reports and handoffs have no size or heading gates.

- `resume <run-dir>` inspects pinned state and explicitly continues it. Complete interrupted claims may proceed to acceptance without another model turn. Missing/mismatched sessions or worktrees, unexpected target edits and ambiguous Git effects stop recovery rather than silently replacing resources.
- `restart <run-dir> <assignment> --reason <text>` stages an inspected missing-resource replacement or uncertain-command repeat. Use the assignment identifier from the diagnostic. Only a subsequent explicit `resume` consumes it; this is not a general rerun of accepted work. History and budgets remain.
- `amend <run-dir> <definition> --classification minor|material --reason <text> [--review <receipt>]` stages a reviewed revision, not execution. Minor edits clarify without changing meaning and retain approval; material changes to scope, contracts, deliverables, profiles, edges, limits or checks require fresh independent review. Keep candidate files outside a reserved target. Inspect the printed affected-task/budget preview, then resume explicitly.

Saved retries and repair budgets remain binding. Changed producers invalidate consumers while unrelated valid acceptance can survive. Preserve attempted DAG/node identities; renaming cannot purchase a fresh budget. An interrupted resume does not itself charge a retry. Completed check receipts remain valid; uncertain checks require explicit repeat authorization. New scope, author decisions or exhausted budgets return needs-author, not automatic replanning.

## Composed plans

Choose `kind: plan` only for independently reviewed DAGs with actual consumed-output dependencies or deferred author checkpoints. Plan fields include `schema`, `name`, `goal`, `criteria`, `review`, optional defaults/limits/integration/verify/context, and a `dags` map. A child is `{file, satisfies, needs?}`; its path resolves from the parent plan. A deferred entry uses `{deferred: {objective, decisionNeeded}, satisfies, needs?}` instead of `file`.

Use the [DAG YAML reference](../skills/writing-dags/references/schema.md) for each child. Parent defaults/role configuration inherit into children, with child/node overrides; explicit skill lists replace inherited lists. A plan shares one capacity pool, and child concurrency can only lower its ceiling.

`review-dag` accepts standalone DAGs only: review each concrete child, then obtain separate independent review of the parent, profile configuration, child documents and deferred descriptions before initial approval. A child YAML review cannot approve the parent. Each executed child receives result review before consumers proceed, followed by overall plan review.

When a deferred child becomes ready, unaffected work settles and execution exits needs-author. Inspect the requested decision, author the missing DAG, obtain review and stage a material amendment. Attempted identities/history remain stable; never-attempted deferred entries may be replaced or split in an approved revision. Only explicit resume continues the plan.

## Runtime boundaries

The [runtime/author responsibility split](../skills/writing-dags/references/schema.md#runtime-and-author-responsibilities) governs which owner needs correction. Agents cannot delegate. The runner schedules authored work; it does not plan missing assignments or infer domain validators.

Worktrees live under `.pi/dags/wt/`; sessions/evidence under `.pi/dags/runs/`. The runner retains canonical snapshots, refs and accepted integration ancestry. It does not automatically commit authored input files, stash edits, roll back integrated changes or delete rejected/interrupted resources. Local execution grants no authority to push, open/merge PRs, deploy or send messages. Apply the target project's contributor gates independently of workflow-specific checks.
