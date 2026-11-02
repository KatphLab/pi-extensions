---
name: pruning-unit-tests
description: Use when reviewing, pruning, or approving unit tests for production suites; when tests look brittle, implementation-focused, mock-heavy, coverage-driven, obsolete after TDD, or disconnected from product behavior.
---

# Pruning Unit Tests

## Overview

A production test suite is executable specification, not a development diary. Keep tests that constrain accepted behavior; rewrite or delete tests that constrain the current implementation.

## Production Test Gate

For every questionable test, answer:

> If this fails in CI, which user-visible behavior, public API contract, business rule, error path, or invariant might be broken?

- A unique accepted behavior is clear: preserve it; rewrite weak or implementation-focused assertions.
- Only private structure, mock choreography, file layout, framework behavior, coverage, or an abandoned design is named: delete it if no unique behavior remains.
- The accepted contract is unknown or the failure may expose a bug: investigate before editing.
- The contract changed intentionally: update the test to the new behavior or remove it.

If deleting a bad test would leave real logic unprotected, replace it with one behavioral test. Coverage policy alone does not justify keeping an implementation test.

## Quick Reference

| Class | Action |
|---|---|
| Preserve | Keep a unique public contract, business rule, error path, invariant, or real regression check. |
| Rewrite | Assert returned value, persisted state, emitted event, rendered behavior, or required side effect instead of internals. |
| Delete | Remove duplicate coverage, mock/helper tests, framework guarantees, coverage filler, obsolete scaffolds, and refactor-hostile structure checks. |
| Investigate | Stop while product behavior or a possible regression is unresolved. |

Ordering is behavioral only when the contract requires it. A unit test may use cheap deterministic real collaborators; “unit” does not mean “mock everything.”

## Example

```ts
// Bad: pins a private helper and repository choreography.
test('calls normalize before save', async () => {
  expect(service.normalize).toHaveBeenCalled();
  expect(repo.save).toHaveBeenCalled();
});

// Good: protects the behavior callers depend on.
test('stores email in canonical form', async () => {
  await service.createUser({ email: ' Alice@Example.COM ' });
  await expect(repo.findByEmail('alice@example.com')).resolves.toMatchObject({
    email: 'alice@example.com',
  });
});
```

## Workflow

1. Read the accepted contract from requirements, public API use, code, and nearby behavioral tests.
2. Name the unique behavior each test protects, then classify it.
3. Preserve behavior, not implementation. Do not change production code unless investigation finds a real bug; then switch to the bug-fix workflow.
4. Run the targeted command for every changed suite. For rewrites, confirm the test fails when the protected behavior breaks when practical.

## Report Contract

List each concrete decision with its test path/name, classification, and behavioral reason.

- Review only: use `Recommend preserve/rewrite/delete/investigate` and state `Verification: not run (read-only review)`.
- Applied pruning: use past-tense actions and report the targeted command with its observed result.

## Red Flags

Never delete an annoying failure before ruling out a regression. Do not replace implementation assertions with broad snapshots or preserve duplicates merely to retain test count.
