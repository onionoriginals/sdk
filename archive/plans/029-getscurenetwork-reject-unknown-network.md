# Plan 029: `getScureNetwork` must throw on unknown network instead of defaulting to mainnet

## Status

- **State**: DONE (branch `correctness/round1-3`)
- **Priority**: P0 (critical)
- **Effort**: S
- **Risk**: LOW
- **Category**: correctness / safety
- **Planned at**: atop `origin/main`@`3b2f7df`, 2026-06-23

## Why this matters

Two copies of `getScureNetwork` map an SDK network name to a `@scure/btc-signer`
network object:

- `packages/sdk/src/bitcoin/transfer.ts` (lines 19-31)
- `packages/sdk/src/bitcoin/transactions/commit.ts` (lines 43-55)

Both end with:

```ts
default:
  return btc.NETWORK; // mainnet
```

Although the parameter is a union type (`'mainnet' | 'regtest' | 'signet' |
'testnet'`), the `default` branch is reachable at runtime. TypeScript's
exhaustiveness narrowing does not delete the branch, and any value that reaches
the function outside the type contract — from dynamic/external data, JSON
deserialization, `as any` casts, or a future-added-but-unmapped network — will
**silently fall through to mainnet**.

This is dangerous: mainnet uses real funds. A value intended for testnet/regtest
that is mistyped or corrupted would silently derive scripts and validate
addresses against **mainnet** parameters, with no error and no warning. The
correct behavior for an unrecognized network is to fail loudly.

### Root cause

The `default` branch returns a safe-looking fallback (`btc.NETWORK`) rather than
throwing. The "safe-looking" value is the most dangerous possible default
(mainnet / real funds).

## The fix

In **both** `getScureNetwork` implementations, replace the
`default: return btc.NETWORK;` branch with a `default:` that throws an `Error`
naming the offending value. Use an `exhaustiveCheck: never` assignment so the
compiler also enforces that every member of the union is handled — turning any
future addition to the union into a compile error rather than a silent mainnet
fallback.

```ts
default: {
  const exhaustiveCheck: never = network;
  throw new Error(`Unsupported Bitcoin network: ${String(exhaustiveCheck)}`);
}
```

The `mainnet`/`regtest`/`signet`/`testnet` cases are unchanged, so all existing
valid call sites behave identically. Only the previously-silent fallback path
changes — now it throws.

## Regression test

Both functions are module-private. To exercise the fallback branch (only
reachable via type coercion), each module gains a minimal named export of its
`getScureNetwork` and a unit test:

- `tests/unit/bitcoin/getScureNetwork.test.ts`:
  - For `transfer.ts`'s `getScureNetwork`: each valid network returns the
    expected `@scure` network object; an unknown value (`'bogus' as any`,
    `undefined as any`) **throws** with a message mentioning the value. This
    test fails before the fix (returns `btc.NETWORK` silently) and passes after.
  - Same assertions for `transactions/commit.ts`'s `getScureNetwork`.

## Out of scope

The duplication of `getScureNetwork`/`REGTEST_NETWORK` across the two modules is
pre-existing tech debt; consolidating them into one shared helper is a separate
refactor and is not required to close this safety defect.
