# Plan 019: Stop commit funding from spending inscription-bearing UTXOs; fix transfer-tx placeholders

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2b86eaa..HEAD -- packages/sdk/src/bitcoin`
> If files under `packages/sdk/src/bitcoin` changed since this plan was
> written, compare the "Current state" excerpts against the live code; on a
> mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug (funds-safety)
- **Planned at**: commit `2b86eaa`, 2026-06-11

## Why this matters

Two funds-safety gaps in the Bitcoin layer:

1. **Commit funding can burn an inscription.** `createCommitTransaction`
   funds the commit output with `selectUtxos` from `utxo-selection.ts`, which
   selects purely by value. Its validity filter checks only structural fields.
   If the caller's wallet UTXO list includes an outpoint that carries an
   ordinal inscription (`utxo.inscriptions` non-empty) or is `locked`, it can
   be selected as a fee/funding input and spent — permanently destroying or
   misassigning the ordinal it carries. A resource-aware selector
   (`selectResourceUtxos`) exists in the same file but is not used here.
2. **`buildTransferTransaction` emits placeholder garbage.** It is exported
   from the SDK's public index, yet fills `scriptPubKey: 'script'` for every
   output and falls back to the literal string `'change'` as a change address.
   Any consumer treating its output as a real transaction loses funds or fails
   at broadcast; the placeholders make it a trap dressed as an API.

## Current state

All paths under `packages/sdk/`:

- `src/bitcoin/transactions/commit.ts` — commit transaction construction.
  - Validity filter (lines 50–58) — structural only:

    ```typescript
    function isValidSpendableUtxo(utxo: Utxo): boolean {
      return !!(
        utxo.txid &&
        typeof utxo.vout === 'number' &&
        utxo.value > 0 &&
        utxo.scriptPubKey &&
        utxo.scriptPubKey.length > 0
      );
    }
    ```

  - `const validUtxos = utxos.filter(isValidSpendableUtxo);` (line 194), warn
    on filtered count (lines 220–222), then iterative selection calling
    `selectUtxos(validUtxos, { targetAmount })` (~line 310).
- `src/bitcoin/utxo-selection.ts`
  - `selectUtxos` (lines 93–172): sorts by value, takes until target; no
    inscription/locked/hasResource checks.
  - `selectResourceUtxos` (lines ~182+): filters `utxo.hasResource === true`
    unless `allowResourceUtxos`; note it keys on `hasResource` (a
    `ResourceUtxo` field), NOT on `Utxo.inscriptions`.
- `src/types/bitcoin.ts:34-50` — `Utxo` has `inscriptions?: string[]` and
  `locked?: boolean`; `ResourceUtxo extends Utxo` adds `hasResource?: boolean`.
- `src/bitcoin/transfer.ts` (entire file, 43 lines) — `buildTransferTransaction`:

  ```typescript
  outputs.push({ value: amountSats, scriptPubKey: 'script', address: recipientAddress });   // line 27
  if (selection.changeSats >= DUST_LIMIT_SATS) {
    const changeAddress = options.changeAddress || (selection.selected.find(u => !!u.address)?.address ?? 'change');  // line 30
    outputs.push({ value: selection.changeSats, scriptPubKey: 'script', address: changeAddress });  // line 31
  }
  ```

  It uses the OTHER selector (`./utxo`'s `selectUtxos`, which DOES support
  `forbidInscriptionBearingInputs`). Callers: only
  `src/index.ts:55` (public export) and
  `tests/unit/bitcoin/transfer.test.ts` — nothing else internal.
- `@scure/btc-signer` is a dependency (`packages/sdk/package.json:109`) and is
  already used in `commit.ts` (`import * as btc from '@scure/btc-signer';`,
  line 10) — use it for address→script derivation.
- Existing tests: `tests/unit/bitcoin/transfer.test.ts` (3 cases),
  `tests/unit/bitcoin/transactions/commit.test.ts` (several; they print dust
  warnings). Read both before editing.

Repo conventions: `bun:test`, validation helpers throw early with clear
messages (see `validateBitcoinAddress` in `src/utils/bitcoin-address.ts` —
use it for address checks rather than rolling your own).

## Commands you will need

| Purpose   | Command (from repo root)                                        | Expected on success |
|-----------|------------------------------------------------------------------|---------------------|
| Typecheck | `cd packages/sdk && bunx tsc --noEmit -p .`                       | exit 0              |
| Bitcoin tests | `cd packages/sdk && bun test tests/unit/bitcoin`              | all pass            |
| Full unit | `cd packages/sdk && bun test tests/unit`                          | no NEW failures (16 pre-existing in DIDCache/Metrics/StatusList, unless plan 016 landed) |

## Scope

**In scope**:
- `packages/sdk/src/bitcoin/transactions/commit.ts`
- `packages/sdk/src/bitcoin/transfer.ts`
- `packages/sdk/tests/unit/bitcoin/transfer.test.ts` (update + extend)
- `packages/sdk/tests/unit/bitcoin/transactions/commit.test.ts` (extend)
- `plans/README.md` (status row only)

**Out of scope**:
- `src/bitcoin/utxo-selection.ts` and `src/bitcoin/utxo.ts` — both selectors
  stay as they are; the fix is at the call sites (filtering before selection),
  which avoids changing selector semantics other callers may rely on.
- `src/bitcoin/PSBTBuilder.ts`, `OrdinalsClient.ts`, providers — untouched.
- `src/utils/bitcoin-address.ts` — consume, don't modify (its
  regtest→testnet fallback is by design; see plans/README.md rejected
  findings).

## Git workflow

- Branch: `advisor/019-inscription-safe-utxo-selection`
- Conventional commits, e.g.
  `fix(sdk): exclude inscription-bearing and locked UTXOs from commit funding`,
  `fix(sdk): derive real scriptPubKeys in buildTransferTransaction and require a change address`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Exclude inscription-bearing/locked UTXOs from commit funding

In `commit.ts`, extend the funding filter (do NOT change
`utxo-selection.ts`):

```typescript
function isValidSpendableUtxo(utxo: Utxo): boolean {
  return !!(
    utxo.txid &&
    typeof utxo.vout === 'number' &&
    utxo.value > 0 &&
    utxo.scriptPubKey &&
    utxo.scriptPubKey.length > 0 &&
    !utxo.locked &&
    !(utxo.inscriptions && utxo.inscriptions.length > 0) &&
    (utxo as ResourceUtxo).hasResource !== true
  );
}
```

(import `ResourceUtxo` from `../../types/bitcoin.js` — match the existing
import style in the file). Update the warn at lines 220–222 to say *why*
UTXOs were filtered (invalid vs. inscription-bearing/locked) — when funding
then fails with "Insufficient funds", the user must be able to see that their
balance is there but protected. Splitting the filter into two passes with two
counts is the cleanest way.

**Verify**: `cd packages/sdk && bun test tests/unit/bitcoin/transactions/commit.test.ts` → all pass

### Step 2: Regression test for inscription protection

In `commit.test.ts`, add cases (model on the existing test setup in that file):

1. UTXO set = one large inscription-bearing UTXO
   (`inscriptions: ['abc...i0']`) + one clean UTXO sufficient for funding →
   commit transaction inputs contain ONLY the clean UTXO.
2. UTXO set = only inscription-bearing UTXOs → throws, and the error message
   mentions that available UTXOs were excluded for carrying
   inscriptions/locks (assert on a distinguishing substring).
3. `locked: true` UTXO is never selected (same shape as case 1).

**Verify**: `cd packages/sdk && bun test tests/unit/bitcoin/transactions/commit.test.ts` → all pass incl. 3 new

### Step 3: Make `buildTransferTransaction` honest

In `src/bitcoin/transfer.ts`:

1. Add `network?: 'mainnet' | 'regtest' | 'signet' | 'testnet'` to
   `BuildTransferOptions` (default `'mainnet'`).
2. Validate `recipientAddress` (and `options.changeAddress` when provided)
   with `validateBitcoinAddress` from `../utils/bitcoin-address.js`; throw on
   invalid.
3. Replace the `'change'` fallback: if change ≥ dust and no
   `options.changeAddress` and no selected-input address exists, **throw**
   `new Error('changeAddress is required when a change output is needed')`.
   Never emit a literal placeholder address.
4. Derive real scriptPubKeys with `@scure/btc-signer`:

   ```typescript
   import * as btc from '@scure/btc-signer';
   // map network string → btc.NETWORK / btc.TEST_NETWORK (regtest/signet/testnet share TEST_NETWORK's bech32 prefix 'tb' except regtest's 'bcrt' — check btc-signer's exports; if regtest needs a custom network object, define it locally with bech32: 'bcrt')
   const script = btc.OutScript.encode(btc.Address(net).decode(address));
   const scriptPubKeyHex = Buffer.from(script).toString('hex');
   ```

   Use that for both recipient and change outputs instead of `'script'`.

**Verify**: `cd packages/sdk && bunx tsc --noEmit -p .` → exit 0

### Step 4: Update and extend transfer tests

`tests/unit/bitcoin/transfer.test.ts` currently uses addresses like `'addr'`
and `'bc1qto'` (lines 9–26) which will now fail validation — update fixtures
to real-form addresses (e.g.
`bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4` for mainnet;
`tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx` appears already in repo tests for
testnet). Assert:

1. `scriptPubKey` of each output is valid hex, non-empty, ≠ `'script'`, and
   decodes back to the address (round-trip via `btc.Address(net).decode` /
   `OutScript.decode` or simply assert known-good hex for the fixture address).
2. Missing `changeAddress` + change ≥ dust + inputs without addresses → throws.
3. Existing behaviors preserved: dust-change suppressed, fee accounted
   (the current 3 tests, adapted).

**Verify**: `cd packages/sdk && bun test tests/unit/bitcoin/transfer.test.ts` → all pass

### Step 5: Full suite

**Verify**: `cd packages/sdk && bun test tests/unit && bun test tests/integration`
→ no failures beyond pre-existing baseline (see plans/README.md status of plan
016 for what the baseline is when you run).

## Test plan

Steps 2 and 4 (six-plus cases listed there). Model commit tests on existing
cases in `tests/unit/bitcoin/transactions/commit.test.ts`; transfer tests on
the existing three in `tests/unit/bitcoin/transfer.test.ts`.

## Done criteria

ALL must hold:

- [ ] `cd packages/sdk && bunx tsc --noEmit -p .` exits 0
- [ ] `grep -n "'script'" packages/sdk/src/bitcoin/transfer.ts` → no matches
- [ ] `grep -n "?? 'change'" packages/sdk/src/bitcoin/transfer.ts` → no matches
- [ ] New tests prove: inscription-bearing and locked UTXOs are never selected
      for commit funding; all-protected wallets fail with an explanatory error
- [ ] `bun test tests/unit/bitcoin` exits 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Excerpts don't match live code (drift).
- Any test or internal caller (re-grep `buildTransferTransaction` and
  `createCommitTransaction` across `packages/`) deliberately feeds
  inscription-bearing UTXOs into commit funding as a feature — protecting them
  may be a behavior change someone depends on; the maintainer decides whether
  an `allowInscribedFunding` opt-in is wanted.
- `@scure/btc-signer`'s Address/OutScript API doesn't match the sketch in
  Step 3.4 for the installed version (check `node_modules/@scure/btc-signer`
  types) and no equivalent exists — report rather than hand-rolling script
  encoding.
- Regtest address handling (bech32 prefix `bcrt`) can't be expressed with the
  library's network objects — descope regtest (mainnet/testnet/signet only)
  and note it, rather than improvising a custom codec.

## Maintenance notes

- The two selectors (`utxo.ts` vs `utxo-selection.ts`) and the dual
  `inscriptions`/`hasResource` signals are duplicate machinery — a future
  consolidation candidate, deliberately out of scope here.
- Reviewer should scrutinize the regtest/signet network mapping in
  `transfer.ts` and the error-message split in `commit.ts` (users must be able
  to tell "broke" from "protected").
- If a future plan adds PSBT-level finalization for transfers, the
  scriptPubKey derivation added here should move to a shared address→script
  helper next to `validateBitcoinAddress`.
