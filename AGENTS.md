## Workflow

- Use Bun only for package management and repository scripts: `bun install`, `bun run <script>`, and `bunx --no-install <tool>`.
- Use Bun's built-in test runner; `bun run test:ci` enforces line and function coverage.
- Create a descriptive feature branch only when the current branch is `main`. Otherwise, continue on the current branch unless the user explicitly requests a different branch.
- Use focused `<type>(<scope>): <why>` commits.

## Skill-driven change ownership

Whenever a skill is invoked, classify each proposed fix before editing and name its owning files:

- **Code:** A defect in application/extension behavior or a generic runtime guarantee. Fix the implementation and verify the affected execution path.
- **Skill:** Missing or incorrect reusable authoring/execution guidance. Fix the skill or its referenced documentation.
- **DAG:** This workflow's scope, dependencies, input/output contracts, acceptance criteria or domain rules. These belong in its definition, tasks and workflow-owned commands/checks, not the generic extension.

Carry this distinction into delegated tasks and reviews. A fix may span categories; justify each separately and change only user-authorized owners. Invoking a skill is not permission to edit code, skills or DAG YAML. Keep workflow policy out of the runtime, and fix runtime defects rather than masking them with prompt or YAML workarounds.

For DAG work, consult [runtime and author responsibilities](skills/writing-dags/references/schema.md#runtime-and-author-responsibilities) before choosing the owner.

## Protected tooling

Ask the user before modifying quality-gate configuration: `.dependency-cruiser.ts`, `.jscpd.json`, `biome.json`, `.semgrep.yml`, `knip.json`, `tsconfig.json`, and `bunfig.toml`. Fix findings in code rather than weakening or bypassing checks.

## Implementation

- Write TypeScript modules; reuse existing modules before adding code.
- Make the smallest complete change and remove obsolete paths when replacing behavior.
- Include dependency rationale plus security and license impact in the PR or commit.
- Update documentation when public behavior or contributor workflows change.
- Use `YYYY-MM-DD` changelog headings, not version numbers; summarize each change in at most one concise, single-line bullet without sub-bullets or implementation detail.
- Normalize unknown thrown values to `Error` at module boundaries. Keep user-facing errors safe and actionable while preserving useful developer diagnostics.
- Dynamic code evaluation is permitted only for the explicitly authorized RLM runtime evaluation gate inside supervised rootless Podman containers: QuickJS-WASM `evalCode`, CPython compilation/execution in a retained namespace, or native Bun's retained-context evaluator. Keep evaluation out of pi's extension host; no unrestricted fallback, ambient credentials, network access, or writable project mounts. Installations, image downloads, paid model calls, production implementation, and quality-gate changes require separate approval. All other dynamic evaluation, unsafe shell execution, and hardcoded secrets remain prohibited.

## Verification

- When reviewing test changes, use [.agents/skills/pruning-unit-tests/SKILL.md](.agents/skills/pruning-unit-tests/SKILL.md).
- Keep the smallest test suite that protects meaningful behavior, contracts, state transitions, and reachable errors; avoid redundant, implementation-detail, or coverage-only tests.
- Prefer updating existing tests; add new tests or test files only when existing coverage cannot clearly protect distinct behavior.
- After TDD, remove temporary or redundant tests; retain a new test only when it protects required functionality or a meaningful regression.
- Run targeted verification and `bun run check` before claiming completion.
- For coverage, generate a fresh report with `bun run test:ci`, then use `bun run coverage:summary` for totals or `bun run coverage:summary <source-file>` for that file’s uncovered line ranges. Inspect the named source ranges rather than loading the full LCOV file. The summary reads the last report; only the test run enforces coverage gates.
- Preserve 90% line and function coverage and the inherited static-analysis gates. Biome rejects focused/skipped tests; Semgrep rejects todo tests.
- Semgrep runs separately in CI; run `semgrep scan --config .semgrep.yml --error .` locally when security rules or affected code change.
