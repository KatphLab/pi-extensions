# ts-bun-template

Strict TypeScript starter using Bun and Biome, based on [KatphLab/ts-pnpm-template](https://github.com/KatphLab/ts-pnpm-template).

## Getting started

Requires Bun 1.4.4 or newer and Node.js 26 for the static-analysis tooling. The application and tests run on Bun, using its built-in test runner.

Use GitHub's **Use this template** button, then:

```sh
bun install
bun run check
bun run dev
```

## Commands

| Command                 | Purpose                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `bun run dev`           | Run the TypeScript entrypoint with Bun's watcher             |
| `bun run build`         | Typecheck and bundle for Bun into `dist/`                    |
| `bun run start`         | Run the built application with Bun                           |
| `bun run lint`          | Biome formatting, linting, and import checks; warnings fail  |
| `bun run fix`           | Apply Biome fixes, then Knip fixes                           |
| `bun run typecheck`     | Strict TypeScript checking without emitting files            |
| `bun run test`          | Run Bun's built-in test runner                               |
| `bun run test:watch`    | Watch tests with Bun                                         |
| `bun run test:ci`       | Run Bun tests with line and function coverage gates          |
| `bun run test:coverage` | Run tests and generate text/LCOV coverage                    |
| `bun run depcruise`     | Enforce dependency and architecture boundaries               |
| `bun run knip`          | Detect unused files, exports, and dependencies               |
| `bun run dupcheck`      | Reject duplication above 1%                                  |
| `bun run check`         | Run all six local quality gates                              |
| `bun run danger:ci`     | Enforce PR size and generated-artifact policies in GitHub CI |

## Strict checks

The PNPM template's TypeScript strictness, Biome rules and test exceptions, dependency-cruiser rules, Knip checks, duplication threshold, Semgrep rules, and Danger policies are retained.

- TypeScript enables strict checking, exact optional properties, unchecked indexed-access checks, unused-local/parameter checks, exhaustive returns, and switch fallthrough restrictions.
- Biome enforces cognitive complexity 12, function length 80, at most seven parameters, promise/type-safety rules, restricted console calls and parent-relative imports, formatting, and organized imports.
- Bun's built-in test runner requires **90% line and function coverage** and fails when no tests are found. Statement and branch coverage thresholds are intentionally omitted. Biome rejects focused/skipped tests, and Semgrep rejects todo tests in CI.
- Dependency-cruiser rejects cycles, undeclared/unresolved dependencies, imports of tests, and production runtime imports of dev dependencies. SWC parses TypeScript source.
- Semgrep scans OWASP Top 10, Node.js, TypeScript, secrets, and the inherited custom rules. It runs separately from `bun run check`:

  ```sh
  semgrep scan --error --config p/owasp-top-ten --config p/nodejs --config p/typescript --config p/secrets --config .semgrep.yml .
  ```

Biome and the custom Semgrep rules retain the source template's limits: they do not provide full unsafe-any flow, unbound-method, cyclomatic-complexity, or specialist ReDoS analysis. Some Semgrep checks are textual and can match code-like strings/comments.

Dependencies use current stable releases and `bun.lock` pins the resolved graph. `trustedDependencies: []` denies dependency lifecycle scripts, including Bun's built-in trusted list, preserving the source template's install-script restrictions. Root-project Husky setup still runs.

Update packages with:

```sh
bun update --latest
bun run check
```

## Git hooks and CI

Husky runs lint-staged on commit and typechecking plus tests on push. GitHub pull requests run the six local gates, Semgrep with blocking findings, and Danger. Pushes to `main` run the full gate, build, and publish the Bun container to GHCR.

The Docker runtime runs as the unprivileged `bun` user and contains only the application bundle and package metadata, not development dependencies.

See [AGENTS.md](AGENTS.md) for contributor instructions.
