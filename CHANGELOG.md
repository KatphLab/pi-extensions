# Changelog

## 2026-11-02

- Preserve unsupported Unicode characters as readable escapes instead of cancelling bitmap compaction.

- Check dependencies weekly with Dependabot and open PRs for major and minor updates, ignoring patch-only updates.

- Trigger compaction at 70% context usage and always use Snapcompact, cancelling instead of falling back to LLM summaries.
- Remove the redundant `/snapcompact` command in favor of Pi’s built-in `/compact`.

- Add local bitmap-frame compaction for image-capable models with persistent archives and normal-summary fallback.
- Replace the OMP native dependency with a portable renderer and compact, attributed bitmap fonts.
- Remove the hello starter extension and use snapcompact in package examples.
- Convert the starter into a multi-extension Pi package and add concise changelog and focused-testing guidelines.

<!--
## YYYY-MM-DD
- Concise, single-line description of the change.
-->
