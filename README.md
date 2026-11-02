# pi-extensions

A collection of independently loadable [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), maintained in one TypeScript project and distributed as one Pi package.

Pi loads the TypeScript source directly. There is no standalone application, bundle, or container to build.

## Getting started

Use Bun 1.4.4 or newer for development and Node.js 26 for the static-analysis tooling. The development dependency includes Pi 1.4.0; an existing Pi installation can also load the package.

```sh
bun install
bun run check
bun run dev
```

Inside Pi, try `/hello` or `/hello Ada`. The starter extension shows a notification in interactive and RPC modes; it does nothing in print/JSON modes. It makes no model requests and starts no background processes.

`bun run dev` runs `pi --extension .` to load all extensions for that invocation only. Use `/reload` after editing source; a Bun watcher or compilation step is not needed. The manifest does not automatically activate the package just because you started Pi in this directory.

To try only one extension using an existing Pi installation:

```sh
pi --no-extensions --extension ./src/extensions/hello/index.ts
```

## Install the package

With Pi installed, load this checkout in future sessions:

```sh
pi install /absolute/path/to/pi-extensions
```

A local install loads source from the checkout without copying it. Run `bun install` here first. Add `--local` to install into the current project's `.pi/settings.json` instead of your personal settings; project resources require trust.

You can also install from this repository:

```sh
pi install git:github.com/KatphLab/pi-extensions
```

Use `pi config` to enable or disable individual extensions and `pi remove <source>` to remove the package. Avoid separately loading an extension file that is already enabled through the package.

For explicit selection in Pi's settings:

```json
{
  "packages": [
    {
      "source": "/absolute/path/to/pi-extensions",
      "extensions": ["src/extensions/hello/index.ts"]
    }
  ]
}
```

The package remains `private` to prevent accidental npm publication. Local and Git installs do not require npm publication. Choose a unique package name and review licensing and published files before making it public.

## Add an extension

```text
src/
  extensions/
    hello/
      index.ts            # Default-exported Pi extension factory
      index.test.ts       # Bun tests; not a Pi entry point
    my-extension/
      index.ts
      index.test.ts
      helpers.ts          # Private implementation
  lib/                    # Shared modules, when needed
  test-utils/             # Shared test support, when needed
```

1. Create `src/extensions/<name>/index.ts` with a default factory receiving `ExtensionAPI` from `@earendil-works/pi-coding-agent`. Use the `hello` extension as the starting point.
2. Register your commands, tools, or event handlers inside the factory. Give them unique names across the package. Keep extensions independent; put genuinely shared logic in `src/lib/` rather than importing another extension's entry point.
3. Keep helpers and tests inside the extension directory. Do not put them directly in `src/extensions/`: Pi loads direct `.ts`/`.js` children as extensions. Each subdirectory is loaded through its `index.ts`, not recursively through all its files.
4. Add behavioral tests beside the implementation and run `bun run check`. Tests can use Pi's resource loader and extension runner without credentials or model calls; see `src/extensions/hello/index.test.ts`.
5. Run `bun run dev`, then `/reload` after further edits. Document the extension's commands and configuration here.

`package.json` declares `pi.extensions: ["./src/extensions"]`, so new extension directories are discovered automatically. Knip recognizes `src/extensions/*/index.ts` as entry points. No root barrel, central registry, separate package, or per-extension build is required.

Use sibling-relative imports for private helpers. Existing `@lib/*`, `@utils/*`, and `@config/*` aliases are available to TypeScript/Bun; test imports through Pi's loader before relying on aliases at runtime. Do not assume the host will resolve development-only aliases.

## Dependencies and security

- Pi supplies `@earendil-works/pi-coding-agent` at runtime, so it is a `"*"` peer dependency, not a production dependency. The pinned lockfile and `^1.4.0` development dependency provide the API types, local CLI, and real loader used in tests. Pi is MIT-licensed; this change does not choose a license for this repository.
- If an extension imports other host-provided packages (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, or `typebox`), declare each as a `"*"` peer plus a development dependency. Do not bundle or install host packages as runtime dependencies: duplicate instances can break host integration.
- Put non-host runtime libraries in `dependencies`. Explain their purpose, security implications, and license impact in the PR or commit. There are currently no non-host runtime dependencies.
- Extensions run with Pi's operating-system permissions and can access files, prompts, and credentials. Review source before installing or granting project trust. The starter only emits a greeting notification.
- `trustedDependencies: []` blocks dependency lifecycle scripts, including Bun's default trusted list. Do not unblock install scripts without reviewing them. The root Husky setup still runs.
- Start long-lived resources in `session_start` or the operation that needs them, not the factory. Release them in an idempotent `session_shutdown` handler. Guard UI-only behavior with `ctx.hasUI` or `ctx.mode` as appropriate.

## Commands and quality gates

| Command                 | Purpose                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `bun run dev`           | Start Pi with every extension in this package                |
| `bun run lint`          | Biome formatting, linting, and import checks; warnings fail  |
| `bun run fix`           | Apply Biome fixes, then Knip fixes; review before committing |
| `bun run typecheck`     | Strict TypeScript checking without emitting files            |
| `bun run test`          | Run Bun's built-in test runner                               |
| `bun run test:watch`    | Watch tests with Bun                                         |
| `bun run test:ci`       | Run tests with 90% line and function coverage gates          |
| `bun run test:coverage` | Generate text/LCOV coverage                                  |
| `bun run depcruise`     | Enforce dependency and architecture boundaries               |
| `bun run knip`          | Detect unused files, exports, and dependencies               |
| `bun run dupcheck`      | Reject duplication above 1%                                  |
| `bun run check`         | Run all six local quality gates                              |
| `bun run danger:ci`     | Enforce PR size and generated-artifact policies in GitHub CI |

Strict TypeScript, Biome, dependency-cruiser, coverage, duplication, Semgrep, and Danger policies are retained. Knip's entry-point configuration follows the multi-extension layout. Husky runs lint-staged on commit and typechecking plus tests on push. Pull requests run all six gates, Semgrep, and Danger; pushes to `main` run the six gates. CI no longer builds or publishes a container.

Semgrep runs separately from `bun run check`:

```sh
semgrep scan --config .semgrep.yml --error .
```

CI additionally uses the OWASP Top 10, Node.js, TypeScript, and secrets rule sets. See [AGENTS.md](AGENTS.md) for contributor instructions and [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) for package discovery and installation details.
