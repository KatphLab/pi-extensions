# Changelog

## 2026-11-02

- Create the Bun/TypeScript template from `ts-pnpm-template`, retaining its strict TypeScript, Biome, dependency-cruiser, Knip, jscpd, Semgrep, Danger, and Git-hook checks.
- Use Bun 1.4.4 for installation, development, bundling, and execution; resolve all development dependencies to their latest stable releases.
- Use Bun's built-in test runner with 90% line and function coverage; omit statement/branch thresholds and remove Vitest.
- Migrate Biome configuration to 2.6.4 without relaxing rules and deny dependency lifecycle scripts with an empty trust list.
- Adapt GitHub Actions and the unprivileged production container to Bun; pin actions to the latest release commits.
- Compile the TypeScript Danger policy with Bun before running it, since Danger's TypeScript loader requires a compiler API removed in TypeScript 7.
