# Plan 008: Make DIDCache LRU O(1) and stop per-emit array allocation

> **Executor instructions**: Follow step by step; run every verification command.
> Honor STOP conditions. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 879ab0c..HEAD -- packages/sdk/src/did/DIDCache.ts packages/sdk/src/events/EventEmitter.ts`
> If either changed, compare excerpts; on a mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `879ab0c`, 2026-06-11

## Why this matters

Two small, contained inefficiencies in hot paths. The DID cache maintains its LRU
order with `indexOf` + `splice` on an array, so every cache hit/eviction is O(n)
in cache size (default max ~1000) — under repeated DID resolution this dominates
cache maintenance. The event emitter rebuilds an array (`Array.from(handlers)`)
on every emit. Both are low-impact individually but cheap to fix and improve the
two most-trafficked internal loops (DID resolution, lifecycle events). This is a
P3 "while you're here" cleanup — only do it if the higher-priority plans are
done or someone wants a quick perf pass.

## Current state

- `packages/sdk/src/did/DIDCache.ts:255-257` — `removeFromAccessOrder` does a
  linear search + splice on the `accessOrder: string[]` array. (Read the whole
  class first — `accessOrder` is read/written in get/set/evict; all those sites
  change if you swap the data structure.)
- `packages/sdk/src/events/EventEmitter.ts:140,159` — `Array.from(handlers)` and
  `Array.from(onceHandlers)` allocate a new array per emit.

**Convention to follow:** a modern JS `Map` preserves insertion order and gives
O(1) delete/re-insert, which is the standard idiomatic LRU substrate. For the
emitter, iterate the `Set` directly (snapshot only if reentrancy requires it).

## Commands you will need

| Purpose | Command (from repo root) | Expected |
|---------|--------------------------|----------|
| Cache tests | `cd packages/sdk && bun test tests/unit/did -t Cache` | all pass |
| Event tests | `cd packages/sdk && bun test tests/unit/events` | all pass |
| Typecheck | `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 \| grep "DIDCache\|EventEmitter"` | empty |

## Scope

**In scope:**
- `packages/sdk/src/did/DIDCache.ts`
- `packages/sdk/src/events/EventEmitter.ts`

**Out of scope:**
- Cache eviction policy/semantics (LRU stays LRU; only the data structure
  changes).
- Event delivery semantics (order, once-handling) must be preserved exactly.

## Git workflow

- Branch: `advisor/008-perf-cache-emitter`
- Conventional Commits, e.g. `perf(sdk): make DIDCache LRU O(1)`.
- No push/PR unless instructed.

## Steps

### Step 1: Convert DIDCache access-order to O(1)

Read `DIDCache.ts` fully. Replace the `accessOrder: string[]` + indexOf/splice
maintenance with an order-preserving `Map` (or a Map<key, node> doubly-linked
list). The simplest correct approach: store entries in a `Map`, and on access,
`delete` then re-`set` the key to move it to the most-recent position; evict by
removing the first key from `map.keys().next().value`.

Keep the public cache API (`get`/`set`/`pin`/`skipCache` behavior) identical.

**Verify**: `cd packages/sdk && bun test tests/unit/did -t Cache` → all pass.
(If the cache tests live in a specific file, run that file directly; find it with
`ls packages/sdk/tests/unit/did | grep -i cache`.)

### Step 2: Stop per-emit array allocation in EventEmitter

Read `EventEmitter.ts` around `:140` and `:159`. If handlers are stored in a
`Set`, iterate the Set directly rather than `Array.from(...)`. **Preserve the
reentrancy guarantee**: if the existing `Array.from` was intentionally snapshotting
to allow handlers to add/remove listeners during emit, keep a snapshot ONLY when
that's the case — read the surrounding code to determine intent. If unsure
whether the snapshot is load-bearing, leave the emitter alone and report (the
DIDCache win is the real one).

**Verify**: `cd packages/sdk && bun test tests/unit/events` → all pass.

## Test plan

- Existing DID cache and event tests are the regression gate — behavior must be
  identical.
- Optionally add a DIDCache test that exercises eviction order after interleaved
  access (proves LRU semantics survived the data-structure swap).
- Verification: `cd packages/sdk && bun test tests/unit/did tests/unit/events` → all pass.

## Done criteria

ALL must hold:

- [ ] `cd packages/sdk && bun test tests/unit/did tests/unit/events` → all pass
- [ ] `grep -n "indexOf" packages/sdk/src/did/DIDCache.ts` → no O(n) access-order search remains
- [ ] `tsc` error count not increased vs baseline
- [ ] No out-of-scope files modified (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- The EventEmitter `Array.from` is a load-bearing reentrancy snapshot — leave it,
  do only the DIDCache half, and note it.
- LRU eviction tests fail in a way that suggests the original order semantics
  differ from a naive Map-LRU — report and preserve original behavior.

## Maintenance notes

- Reviewer: the only risk is subtly changing LRU eviction order or event delivery
  order — both are covered by existing tests; confirm they still pass unmodified.
- This is a P3 nicety; skip if effort is better spent on P1/P2 plans.
