# pi-extensions

Independently loadable TypeScript extensions for [Pi](https://pi.dev), bundled as one package. Pi runs the source directly—no build step required.

The collection currently includes **Snapcompact**, which turns older conversation text into compact PNG frames for image-capable models instead of generating an LLM summary.

[Install](#install) · [Use Snapcompact](#use-snapcompact) · [Limits and privacy](#limits-and-privacy) · [Development](#development)

## Install

With [Pi installed](https://github.com/earendil-works/pi#getting-started), add the package and start a session:

```sh
pi install git:github.com/KatphLab/pi-extensions
pi
```

Choose an image-capable model in Pi to use bitmap compaction. Normal provider authentication is still required for conversations.

To install only for the current project, add `--local` to `pi install`. Project packages load after you grant project trust.

### Try a local checkout

Use **Bun 1.4.4 or newer** and **Node.js 24 or newer**; development checks run on Node.js 26 in CI.

```sh
git clone https://github.com/KatphLab/pi-extensions.git
cd pi-extensions
bun install
bun run dev
```

`bun run dev` loads the package for that invocation only. To keep using the checkout in future sessions:

```sh
pi install /absolute/path/to/pi-extensions
```

Local installs load directly from the checkout without copying it. Run `bun install` there first.

Use `pi config` to enable or disable individual extensions, or `pi remove <source>` to remove a package. Avoid loading an extension file separately when it is already enabled through the package.

## Use Snapcompact

Build up a conversation in Pi, then run:

```text
/compact
```

Snapcompact triggers compaction after a turn when context usage reaches **70%** or higher. It also handles Pi’s built-in `/compact` command and automatic compaction while loaded, always using Snapcompact rather than Pi’s LLM summarizer. Pi’s recent-message boundaries still apply; there is no separate configuration to maintain.

| Request                                                                    | Behavior                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------- |
| `/compact` with an image-capable model                                     | Locally archive older text as PNG frames            |
| `/compact` with instructions, such as `/compact focus on unresolved tasks` | Use Snapcompact; summary instructions are ignored   |
| Compaction with a text-only model or no selected model                     | Cancel; select an image-capable model and retry     |
| Rendering failure, unsupported glyphs, or an exceeded frame-byte budget    | Cancel with an error; no LLM summarization fallback |

### How it works

1. **Collect older history.** Serialize conversation text and bounded tool output, combining it with any prior archive on the active branch.
2. **Keep the edges readable.** Retain the first and last 2,000 characters as text and render the middle into dense PNG frames. Histories of up to 4,000 characters remain text-only.
3. **Reattach on requests.** Store the archive in the session’s compaction entry and attach its text and images to subsequent model requests, including after resume or tree navigation. Recent messages stay in Pi’s normal context.

Successful bitmap compaction makes **no model request** and needs no additional API key. Subsequent requests send the frames to your selected model and incur its image charges; lower cost or better recall is not guaranteed.

The portable renderer uses bundled bitmap fonts, with no native addon, external rendering service, or runtime font download. It is inspired by [OMP’s bitmap-frame compaction](https://github.com/can1357/oh-my-pi/tree/main/packages/snapcompact), not a full port of OMP’s model-specific tuning. Font attribution and regeneration details live in the [font documentation](src/extensions/snapcompact/fonts/README.md).

## Limits and privacy

> [!IMPORTANT]
> Keep Snapcompact enabled when resuming a bitmap-compacted session. Without it, Pi sees the reading guide and file list but does not reattach the archived text or images. Disabling the extension does not delete the original session history.

Bitmap compaction is **not a lossless backup**:

- Thinking and original image attachments are omitted. Tool arguments and results retain at most 2,000 characters of content each, plus a truncation notice.
- ANSI escapes are stripped, and newline runs become `█`. Non-ASCII text uses bundled Silver glyphs; unsupported glyphs cancel compaction. Image-reading accuracy depends on the model.
- Archives contain at most **five frames** and **3 MB of base64 frame data**. Frame count is further limited to estimated budgets of 10% of the model window and 20% of the pre-compaction context, using 5,024 tokens per frame. These are planning estimates, not billing guarantees.
- History beyond the archive’s text capacity is omitted with an explicit character-count notice. Small token budgets can leave only the text edges, with no frames.
- Switching to a text-only model sends the bounded archive source as text, which can increase context usage until the next compaction.

> [!WARNING]
> Session files and exports can contain both readable archive source and encoded screenshots of sensitive conversation data. Review them before sharing. Archived content is sent to the selected model on subsequent requests.

Like other Pi extensions, this package runs with Pi’s operating-system permissions. Review extension source before installing or granting project trust. Snapcompact stores its archive inside the session; it creates no external archive files or background processes.

## Development

Install dependencies with Bun, then run the checks and start Pi:

```sh
bun install
bun run check
bun run dev
```

Use `/reload` inside Pi after editing source. No watcher or compilation step is needed. To load only Snapcompact with an existing Pi installation:

```sh
pi --no-extensions --extension ./src/extensions/snapcompact/index.ts
```

### Project layout

```text
src/
  extensions/
    snapcompact/
      index.ts         # Pi extension entry point
      *.ts             # Archive, serialization, and rendering modules
      *.test.ts        # Bun behavioral and integration tests
      fonts/           # Bitmap assets and attribution
  test-utils/          # Shared Pi extension test harness
scripts/               # Maintainer utilities
```

To add an extension, create `src/extensions/<name>/index.ts` with a default factory receiving Pi’s `ExtensionAPI`. Register uniquely named commands, tools, or handlers in that factory, and keep private helpers and behavioral tests beside it. The package manifest discovers each extension directory automatically; no central registry is needed.

Do not place helper or test files directly in `src/extensions/`: Pi treats direct `.ts` and `.js` children as extension entry points. Keep extensions independent and move genuinely shared code to `src/lib/` when needed. See Pi’s [extension guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) and [package guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) for host APIs and dependency conventions.

### Dependency updates

[Dependabot](.github/dependabot.yml) checks Bun dependencies weekly on Friday at 22:00 UTC and opens pull requests for major and minor updates, keeping `package.json` and `bun.lock` in sync. Patch-only version updates are ignored. PRs require review and are not automatically merged.

No custom workflow, additional secret, or dependency is required. Scheduled checks begin after the configuration is merged into the default branch. Dependabot security updates are configured separately in the repository’s security settings.

### Verification

| Command              | Purpose                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| `bun run check`      | Run lint, types, coverage, dependency boundaries, unused-code, and duplication checks |
| `bun run test`       | Run Bun tests                                                                         |
| `bun run test:watch` | Rerun tests as files change                                                           |
| `bun run test:ci`    | Run tests with 90% line and function coverage gates                                   |
| `bun run fix`        | Apply Biome and Knip fixes; review the resulting diff                                 |

Semgrep runs separately in CI. Run it locally when changing security rules or affected code:

```sh
semgrep scan --config .semgrep.yml --error .
```

See [AGENTS.md](AGENTS.md) for repository workflow and quality requirements.
