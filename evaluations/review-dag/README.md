# DAG-review behavioral evaluation

Use when changing the bundled review's decomposition, efficiency or synthesis instructions. These cases exercise **the accepted final report**, including whether synthesis filters away a useful specialist recommendation. Parser success and prompt-string assertions are not behavioral evaluation.

## Cases and expected distinctions

| Input             | Final-report expectation                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fragmented.yaml` | Identify combining the two **simplicity** scopes: 980 inspected lines including the shared contract, covering one coherent request lifecycle rather than independent responsibilities. Preserve a separate correctness assessment. Recommend removing the repeated `aggregate-copy` stage while retaining provenance and result review. Keep the design recommendation even though application needs coordinated updates to the external manifest/checker contract. |
| `justified.yaml`  | Explain why the two correctness scopes should stay separate: decoding and storage cover different resource lifecycles and trust boundaries; the 2,500-line union is workload information, not a reason on its own. Keep correctness and simplicity distinct. Recognize that the one-input `publish` stage converts evidence to a required importer format rather than repeating aggregation.                                                                        |

These are synthetic YAML subjects. Their source, contracts and checker paths deliberately need not exist: file-only `review-dag` does not resolve or execute them. Never `run` either target. The expected distinctions are an evaluator rubric, **not input to the reviewer**. Reviewers may find other real issues; these expectations neither require a findings quota nor require the justified case to be otherwise perfect.

## Authoring regression

The [authoring case](authoring/request.md) exercises the author rather than the reviewer. Supply only that request, [inventory](authoring/inventory.json) and [starting draft](authoring/draft.yaml) to a fresh candidate author session. Its [evaluator-only rubric](authoring/RUBRIC.md) distinguishes all-aspect reconsideration from a partial simplicity-only revision and permits evidence-based alternative partitions rather than a target node count. Run it under a separately authorized authoring/scoring budget; the two file-only review runs below do not cover it.

## Local fixture admission (no models)

```sh
bun test src/dag/builtins/review.test.ts
```

This protects valid, safely frozen input through the real bundled-review adapter. It does not prove model judgment. Existing CI runs this with the Bun suite; no paid evaluation is wired into CI.

## Authorized evaluation

1. Obtain an explicit budget for **two file-only review runs**, one per case, including their bundled synthesis and independent result review. Obtain separate approval for repetitions or baseline/candidate comparisons. No model probes are needed.
2. Use a clean authorized launch checkout. Keep modified reviewer drafts external to it if needed; invoke the candidate CLI by absolute path so its packaged reviewer is the candidate under evaluation. Do not commit, stash, reset or move user files to force admission.
3. Set absolute paths to the candidate package, existing execution profiles and clean launch checkout. From that checkout, invoke the following commands **individually**, waiting for each to finish. A failed/needs-author run is not a behavioral pass and must not be silently restarted.

```sh
# Set PACKAGE, PROFILES and LAUNCH to approved absolute paths first.
cd "$LAUNCH"
bun run "$PACKAGE/src/dag/cli.ts" review-dag "$PACKAGE/evaluations/review-dag/fragmented.yaml" --profiles "$PROFILES"
bun run "$PACKAGE/src/dag/cli.ts" review-dag "$PACKAGE/evaluations/review-dag/justified.yaml" --profiles "$PROFILES"
```

4. For each reported run directory, run `summary` once after terminal status. Read the accepted `review.md` and independent `review.json`. Use `watch --compact` only if observing an already-running execution. Preserve reports even when they fail this rubric.
5. Have a human evaluator, or separately authorized independent evaluator, score the final reports against the cases below. Cite report passages; do not grade by keyword presence. Consult specialist reports only to locate a missed or suppressed recommendation. A successful runner status/independent review does not substitute for this evaluation.

## Record and decision

Record outside tracked source (for example under `.pi/dags/review-evaluation/`): candidate commit plus dirty diff identity, exact bundled-review and fixture SHA-256s, profile configuration identity, run IDs, final report paths, terminal status, independent verdict, and observed usage estimates. Preserve credentials and raw transcripts as private; no credentials belong in the record.

Use one row per criterion with `pass`, `fail`, or `inconclusive`, a report citation and a reason:

- **Same-aspect regrouping:** the fragmented final report recommends a bounded combination, preserving source coverage and aspect separation; mere counting or cross-aspect merging fails.
- **Redundant reducer:** it identifies the repeated aggregation and preserves provenance when proposing removal.
- **Value vs readiness:** external contract updates remain explicit implementation prerequisites, not grounds to discard the design recommendation. No unsupported assertion that the patch already passes checks.
- **Necessary separation:** the justified report retains the different-lifecycle split and separate aspects with evidence, not blanket resistance to simplification.
- **Distinct one-input work:** it retains the consumer format conversion; a blanket ban on unary nodes fails.
- **Evidence discipline:** both reports stay within YAML evidence, avoid invented prices/latencies or external-code claims, and preserve safety/result-review guarantees.

All criteria must pass for the pair to pass; any missing required report is inconclusive. Report mixed results rather than selecting the best run. One passing pair is a regression signal, not a reliability estimate. To compare prompt revisions, use the same fixtures/profiles and separately budget matched runs; report variability and no guaranteed savings.

## Current status

- **Mechanism changed:** authoring/reviewer instructions and regression inputs are authored; local fixture admission checks structure only.
- **Affected artifact corrected:** assess the concrete revised workflow against its complete aspect decision record and preservation checks; evaluation fixtures alone do not establish this status.
- **Behavior verified:** paid reviewer and authoring evaluation runs remain pending explicit authorization. Do not represent local structural validation as evidence that model behavior is fixed.

No new dependencies, network authority, runtime policy or CI gate changes are required.
