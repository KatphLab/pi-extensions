## Workflow

- Use Bun only for package management and repository scripts: `bun install`, `bun run <script>`, and `bunx --no-install <tool>`.
- Use Bun's built-in test runner; `bun run test:ci` enforces line and function coverage.
- Create a descriptive feature branch only when the current branch is `main`. Otherwise, continue on the current branch unless the user explicitly requests a different branch.
- Use focused `<type>(<scope>): <why>` commits.

## Protected tooling

Ask the user before modifying quality-gate configuration: `.dependency-cruiser.ts`, `.jscpd.json`, `biome.json`, `.semgrep.yml`, `knip.json`, `tsconfig.json`, and `bunfig.toml`. Fix findings in code rather than weakening or bypassing checks.

## Implementation

- Write TypeScript modules; reuse existing modules before adding code.
- Make the smallest complete change and remove obsolete paths when replacing behavior.
- Include dependency rationale plus security and license impact in the PR or commit.
- Update documentation when public behavior or contributor workflows change.
- Use `YYYY-MM-DD` changelog headings, not version numbers; summarize each change in at most one concise, single-line bullet without sub-bullets or implementation detail.
- Normalize unknown thrown values to `Error` at module boundaries. Keep user-facing errors safe and actionable while preserving useful developer diagnostics.
- Do not introduce dynamic code evaluation, unsafe shell execution, or hardcoded secrets.

## Verification

- When reviewing test changes, use [.agents/skills/pruning-unit-tests/SKILL.md](.agents/skills/pruning-unit-tests/SKILL.md).
- Keep the smallest test suite that protects meaningful behavior, contracts, state transitions, and reachable errors; avoid redundant, implementation-detail, or coverage-only tests.
- Prefer updating existing tests; add new tests or test files only when existing coverage cannot clearly protect distinct behavior.
- After TDD, remove temporary or redundant tests; retain a new test only when it protects required functionality or a meaningful regression.
- Run targeted verification and `bun run check` before claiming completion.
- Preserve 90% line and function coverage and the inherited static-analysis gates. Biome rejects focused/skipped tests; Semgrep rejects todo tests.
- Semgrep runs separately in CI; run `semgrep scan --config .semgrep.yml --error .` locally when security rules or affected code change.
