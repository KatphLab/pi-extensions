# Authoring regression rubric — evaluator only

Do not provide this file to the author. Give the author `request.md`, `inventory.json` and `draft.yaml`, plus the candidate authoring environment. Score the delivered YAML, decisions and summary, not the wording of its prompts or the number of edits.

## What the case exposes

The draft repeats four inventory groups across four aspects. Revising only simplicity leaves related decoder work in three other aspects unexamined. Conversely, mechanically applying one partition everywhere ignores different evidence and attention demands. Larger scopes are not automatically overloaded.

Expected scope unions (including shared documents and dispatcher once):

| Aspect      | Decoder header + body | Storage opening + transaction |
| ----------- | --------------------- | ----------------------------- |
| Standards   | 1,080 lines           | 2,040 lines                   |
| Correctness | 1,160 lines           | 2,120 lines                   |
| Simplicity  | 600 lines             | 1,420 lines                   |
| Test value  | 1,220 lines           | 2,180 lines                   |

These are workload measurements, not acceptance thresholds. Decoder stages share a dispatcher and one execution path, making combination a strong candidate in every aspect. Storage has distinct opening/transaction failure and cleanup scenarios but a shared ownership contract: combining or retaining separate assessments can be valid with aspect-specific reasoning about attention and evidence. No fixed line total decides that choice. There is no requirement for independent second opinions on one aspect. Keep decoder and storage responsibilities distinct rather than packing unrelated scopes.

## Scoring

Record pass/fail/inconclusive for each criterion, citing exact artifact locations. All must pass for an overall pass; unavailable required artifacts are inconclusive. Alternative decompositions are valid when they preserve evidence and aspect separation and explain their responsibility and attention boundaries; there is no required final node count.

1. **All-aspect reconsideration:** each of standards, correctness, simplicity and test-value has required-evidence reasoning, related candidate comparisons and dispositions for every original assignment, including unchanged ones. A generic statement that the other aspects retain their contracts fails.
2. **Evidence-led partitions:** the author considers decoder consolidation across all four aspects and evaluates storage evidence separately for each aspect. Retaining a split needs a concrete responsibility, decision or attention boundary evidenced by the input; merely citing the old topology or a size threshold fails. Combining broader scopes needs a credible explanation of how the required failure/cleanup and behavioral-protection evidence stays reviewable. Do not reward fewer nodes achieved by ignoring those demands.
3. **Contract preservation:** account for every original source/document range and applicable requirement under its original aspect. Retain independent large-profile review, report provenance, empty project write scopes, mandatory controls and no target execution. Fewer nodes achieved by dropping tests, caller context or an aspect fail.
4. **Whole-artifact consistency:** revised dependencies, reducer fan-in, producer/consumer artifact names, output contracts and criteria agree with the chosen partition. No repeated one-input aggregation unless it has a demonstrated additional responsibility.
5. **Mechanical reporting:** summary counts match final YAML, use defaults where needed, separate specialists/reducers/commands and independent review, and identify small/large role labels without inventing configured models, API-call counts or savings.
6. **Completion honesty:** distinguish what changed in the authoring mechanism (or was outside this run), what was corrected in the actual artifact, and what behavior was verified. Structural parsing is not model-behavior evidence. Synthetic source/profile readiness and any paid review remain explicitly pending.

## Negative control

A candidate that combines only the two decoder simplicity nodes, adjusts reducers and says “all other aspects retain their existing implementation/caller/test boundaries” must fail criteria 1 and 2 even if its YAML parses and all mechanical scope/coverage checks pass. This reproduces the session failure rather than just checking whether a reviewer can spot an obvious unary reducer.

## Execution and evidence

This evaluates an **authoring run**, not `review-dag` and not source review. Obtain a separate model-call budget for the author session and any independent scoring session. No paid evaluation is wired into CI.

Use a fresh author session with the candidate skill and code-review authoring instructions, the three input files and an empty output directory. Do not expose this rubric, previous outputs or the expected unions to the author. Author tools may perform local structural checks; source review, target execution and paid YAML review are out of scope. Referenced synthetic files are intentionally absent, so resource readiness cannot pass; reporting that prerequisite is expected, not an evaluation failure.

Keep candidate commit/dirty-diff identity, input and output SHA-256s, actual model/profile configuration, run/session IDs, terminal status and observed usage with the scored record outside tracked source. Score the complete final deliverable even if individual intermediate decisions were good. For baseline/candidate comparisons, separately authorize matched runs and report all outcomes rather than selecting a best run.

The local fixture-admission test only protects structural validity of the starting draft. The workflow-owned `.pi/dags/code-review-dag/planning.test.ts` separately exercises missing-aspect and preservation-check failures for the current generated workflow. Neither establishes that an author model passes this rubric. Behavioral execution is pending explicit authorization.
