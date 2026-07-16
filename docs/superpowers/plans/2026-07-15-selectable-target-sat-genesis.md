# Caller-Selectable Target Sat for Genesis did:btco Inscription — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller choose which satoshi the genesis did:btco inscription lands on (the sat IS the DID), instead of accepting whatever sat the provider picks.

**Architecture:** The caller supplies a funding UTXO; the SDK derives that output's first sat from the provider's sat index (the authoritative DID sat), builds the inscription content embedding `did:btco:<sat>`, builds an unsigned commit transaction, has a caller `BitcoinSigner` sign the commit, broadcasts commit + a newly-built self-signed reveal, and verifies fail-closed that the landed inscription sits on the intended sat. A new focused helper (`bitcoin/inscribe-on-sat.ts`) holds the flow; `LifecycleManager.inscribeOnBitcoin` routes to it when a funding UTXO is supplied and otherwise preserves the legacy provider-picks path.

**Tech Stack:** TypeScript, Bun, `@scure/btc-signer`, `micro-ordinals`, `@noble/curves`. Spec: `docs/superpowers/specs/2026-07-15-selectable-target-sat-genesis-design.md`.

## Global Constraints

- Work only in `packages/sdk`. Run tests with `bun test <path>` from `packages/sdk`.
- **NEVER read `packages/sdk/src/lifecycle/LifecycleManager.ts` whole (~3000 lines) — it stalls the stream.** Grep for the symbol you need and read ≤60-line windows.
- The DID sat is **derived from the provider**, never caller-asserted (`getFirstSatOfOutput`). The caller supplies only the funding outpoint + signer + change address.
- Granularity = **first sat of the funding input**; no pointer offset (`createCommitTransaction` is called with `pointer` undefined).
- Only the **commit** needs the caller's signature (it spends the funding UTXO). The **reveal** is self-signed by the ephemeral reveal key `createCommitTransaction` already generates.
- Verification is **fail-closed**: landed inscription sat must equal the derived sat, else `SAT_MISMATCH`, roll back the in-memory CEL append, commit nothing.
- Providers without the sat index → `SAT_INDEX_UNSUPPORTED` (fail closed, nothing broadcast). `fundingUtxo` present but missing `satSigner`/`changeAddress` → `INVALID_INPUT`.
- The legacy `inscribeOnBitcoin(asset)` / `(asset, feeRate)` path is preserved unchanged for OrdMock/dev.
- Commit inscription output MUST be vout 0 with the funding UTXO as the sole/first input, so its first sat flows funding → commit → reveal as the inscription sat.
- Errors use `StructuredError(code, message)` from `src/utils/telemetry.ts` (grep existing usage for the import path).
- The husky commitlint hook has no binary in this worktree — commit with `git commit --no-verify` (keep conventional-commit messages).

---

## File Structure

- **Modify** `src/adapters/types.ts` — add optional `getFirstSatOfOutput` to `OrdinalsProvider` (and `OrdinalsLookup` if the verify path needs it).
- **Modify** `src/adapters/providers/OrdMockProvider.ts` — deterministic `getFirstSatOfOutput`.
- **Modify** `src/adapters/providers/QuickNodeProvider.ts` — real sat-index `getFirstSatOfOutput`.
- **Modify** `src/bitcoin/transactions/commit.ts` — extend `CommitTransactionResult` to expose the commit output vout/value needed by the reveal, if not already derivable; add `createRevealTransaction`.
- **Create** `src/types/common.ts` addition — `BitcoinSigner` interface (append to the existing file).
- **Create** `src/bitcoin/inscribe-on-sat.ts` — `inscribeOnSat` orchestration helper.
- **Modify** `src/lifecycle/LifecycleManager.ts` — `inscribeOnBitcoin` options object + routing + rollback reuse.
- **Modify** `src/lifecycle/BatchLifecycleOperations.ts` — mirror the new optional fields.
- **Modify** `src/bitcoin/BitcoinManager.ts` — delete dead `preventFrontRunning` (#369).
- **Create** `.changeset/selectable-target-sat.md`.
- **Tests** under `packages/sdk/tests/unit/bitcoin/` and `packages/sdk/tests/unit/lifecycle/` (match existing layout — grep for an existing test dir before creating).

---

## Task 1: Provider sat-index — `getFirstSatOfOutput`

**Files:**
- Modify: `src/adapters/types.ts` (the `OrdinalsProvider` interface — grep `createInscription(params` to locate it)
- Modify: `src/adapters/providers/OrdMockProvider.ts`
- Modify: `src/adapters/providers/QuickNodeProvider.ts`
- Test: `packages/sdk/tests/unit/adapters/OrdMockProvider.getFirstSatOfOutput.test.ts` (grep `tests/unit/adapters` to confirm the dir; if absent use the dir where OrdMockProvider tests already live)

**Interfaces:**
- Produces: `OrdinalsProvider.getFirstSatOfOutput?(outpoint: { txid: string; vout: number }): Promise<string>`

- [ ] **Step 1: Write the failing test** (`OrdMockProvider.getFirstSatOfOutput.test.ts`)

```ts
import { describe, it, expect } from 'bun:test';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';

describe('OrdMockProvider.getFirstSatOfOutput', () => {
  it('returns a deterministic, valid sat number for an outpoint', async () => {
    const p = new OrdMockProvider();
    const a = await p.getFirstSatOfOutput({ txid: 'aa'.repeat(32), vout: 0 });
    const b = await p.getFirstSatOfOutput({ txid: 'aa'.repeat(32), vout: 0 });
    expect(a).toBe(b);                       // deterministic
    expect(/^[0-9]+$/.test(a)).toBe(true);   // integer sat string
  });

  it('gives different outputs different sats', async () => {
    const p = new OrdMockProvider();
    const a = await p.getFirstSatOfOutput({ txid: 'aa'.repeat(32), vout: 0 });
    const b = await p.getFirstSatOfOutput({ txid: 'aa'.repeat(32), vout: 1 });
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd packages/sdk && bun test tests/unit/adapters/OrdMockProvider.getFirstSatOfOutput.test.ts`
Expected: FAIL — `getFirstSatOfOutput is not a function`.

- [ ] **Step 3: Add the interface method** in `src/adapters/types.ts`, inside `OrdinalsProvider` (place next to `getInscriptionById`):

```ts
  /**
   * The first (lowest-offset) satoshi contained in the given output, per the
   * provider's sat index. This is the sat an inscription funded by this output
   * lands on (no pointer). Used to derive the did:btco identity BEFORE building
   * the inscription. Providers without a sat index omit it; the sat-selected
   * genesis path then fails closed with SAT_INDEX_UNSUPPORTED.
   */
  getFirstSatOfOutput?(outpoint: { txid: string; vout: number }): Promise<string>;
```

- [ ] **Step 4: Implement in `OrdMockProvider`** — deterministic, dependency-free. Add:

```ts
  async getFirstSatOfOutput(outpoint: { txid: string; vout: number }): Promise<string> {
    // Deterministic pseudo-sat from the outpoint so tests can assert the
    // derived did:btco identity without a real sat index. Not a real ordinal
    // calculation — a stable, unique-per-outpoint integer in a plausible range.
    let h = 2166136261 >>> 0; // FNV-1a
    const s = `${outpoint.txid}:${outpoint.vout}`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    // Keep it well inside the 0..2.1e15 sat supply range.
    return String(100000000 + (h % 2000000000000000));
  }
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd packages/sdk && bun test tests/unit/adapters/OrdMockProvider.getFirstSatOfOutput.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Implement in `QuickNodeProvider`** — real sat index. Grep `QuickNodeProvider.ts` for how it issues RPC/HTTP calls (e.g. an existing `this.request`/`fetch` helper and how `getInscriptionById` queries). Mirror that. The Ordinals add-on exposes the sats/ranges for an output; request them and return the first (lowest) sat as a decimal string. If the add-on call errors or returns no ranges, throw `StructuredError('SAT_INDEX_UNAVAILABLE', ...)` (do NOT fabricate a sat — that would mint a wrong DID). Add a unit test that mocks the HTTP layer the same way existing QuickNodeProvider tests do (grep `QuickNodeProvider` under `tests/`); assert the method parses a sample ranges response into the first sat, and throws on an empty/error response.

- [ ] **Step 7: Run QuickNode + full adapter tests**

Run: `cd packages/sdk && bun test tests/unit/adapters`
Expected: PASS (new + existing).

- [ ] **Step 8: Commit**

```bash
git add src/adapters packages/sdk/tests/unit/adapters
git commit --no-verify -m "feat(adapters): getFirstSatOfOutput sat-index method (OrdMock + QuickNode)"
```

---

## Task 2: Reveal-transaction builder — `createRevealTransaction`

The commit builder returns the reveal key + inscription `{ script, controlBlock, leafVersion }` but nothing assembles/signs the reveal. This task adds it. It is the highest-risk task (taproot script-path spend) — use a capable model and test carefully.

**Files:**
- Modify: `src/bitcoin/transactions/commit.ts` (read it fully first — it is small; note the `btc`, `ordinals`, `schnorr` imports and the `CommitTransactionResult` shape lines ~92-115 and the p2tr construction ~355-402)
- Modify: `src/bitcoin/transactions/index.ts` (export `createRevealTransaction`)
- Test: `packages/sdk/tests/unit/bitcoin/createRevealTransaction.test.ts`

**Interfaces:**
- Consumes: `CommitTransactionResult` fields `revealPrivateKey: string`, `revealPublicKey: string`, `inscriptionScript: { script: Uint8Array; controlBlock: Uint8Array; leafVersion: number }`, `commitAmount: number`.
- Produces:
```ts
export interface RevealTransactionParams {
  commitTxId: string;             // txid of the broadcast/signed commit
  commitVout: number;             // vout of the inscription-bearing commit output (0)
  commitAmount: number;           // value (sats) of that commit output
  revealPrivateKey: string;       // hex, from CommitTransactionResult
  revealPublicKey: string;        // hex, from CommitTransactionResult (taproot internal key)
  inscriptionScript: { script: Uint8Array; controlBlock: Uint8Array; leafVersion: number };
  destinationAddress: string;     // where the inscribed sat (postage) goes
  feeRate: number;                // sats/vB
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
}
export interface RevealTransactionResult {
  revealTxHex: string;            // fully-signed, finalized reveal tx hex
  revealTxId: string;
  inscriptionId: string;          // `${revealTxId}i0`
  postageValue: number;           // commitAmount - reveal fee (>= dust)
}
export async function createRevealTransaction(params: RevealTransactionParams): Promise<RevealTransactionResult>
```

- [ ] **Step 1: Read `commit.ts` fully** to reuse its exact `getScureNetwork`, dust constant, `calculateFee`, and taproot patterns. Do not re-derive network mapping — reuse the module's helper.

- [ ] **Step 2: Write the failing test** (`createRevealTransaction.test.ts`). Drive it off a real commit result so the taproot data is genuine:

```ts
import { describe, it, expect } from 'bun:test';
import { createCommitTransaction } from '../../../src/bitcoin/transactions/commit';
import { createRevealTransaction } from '../../../src/bitcoin/transactions/commit';
import * as btc from '@scure/btc-signer';

// A funded, spendable regtest P2WPKH utxo fixture. Grep existing commit.ts
// tests (tests/unit/bitcoin) for a ready-made UTXO + changeAddress fixture and
// reuse it rather than hand-rolling scriptPubKey.
import { sampleUtxo, sampleChangeAddress } from '../../fixtures/bitcoin'; // adjust path to the real fixture

describe('createRevealTransaction', () => {
  it('builds a finalized reveal that spends the commit output and yields an inscriptionId', async () => {
    const commit = await createCommitTransaction({
      content: Buffer.from('hello', 'utf8'),
      contentType: 'text/plain',
      utxos: [sampleUtxo],
      changeAddress: sampleChangeAddress,
      feeRate: 2,
      network: 'regtest'
    });

    const reveal = await createRevealTransaction({
      commitTxId: 'bb'.repeat(32),
      commitVout: 0,
      commitAmount: commit.commitAmount,
      revealPrivateKey: commit.revealPrivateKey,
      revealPublicKey: commit.revealPublicKey,
      inscriptionScript: commit.inscriptionScript,
      destinationAddress: sampleChangeAddress,
      feeRate: 2,
      network: 'regtest'
    });

    expect(reveal.inscriptionId).toBe(`${reveal.revealTxId}i0`);
    expect(reveal.postageValue).toBeGreaterThanOrEqual(546);
    // Parses back as a valid signed tx with exactly one input carrying a witness.
    const tx = btc.Transaction.fromRaw(Buffer.from(reveal.revealTxHex, 'hex'), { allowUnknownInputs: true });
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);
  });

  it('throws when the commit amount cannot cover the reveal fee + dust', async () => {
    await expect(createRevealTransaction({
      commitTxId: 'bb'.repeat(32), commitVout: 0, commitAmount: 300,
      revealPrivateKey: 'ab'.repeat(32), revealPublicKey: 'ab'.repeat(32),
      inscriptionScript: { script: new Uint8Array([0x51]), controlBlock: new Uint8Array(33), leafVersion: 0xc0 },
      destinationAddress: sampleChangeAddress, feeRate: 2, network: 'regtest'
    })).rejects.toThrow();
  });
});
```

If no reusable UTXO/address fixture exists, add one under `tests/fixtures/bitcoin.ts` with a regtest P2WPKH `{ txid, vout, value, scriptPubKey }` and a valid regtest change address (grep existing commit tests — they must already construct one).

- [ ] **Step 3: Run it, verify it fails**

Run: `cd packages/sdk && bun test tests/unit/bitcoin/createRevealTransaction.test.ts`
Expected: FAIL — `createRevealTransaction is not exported`.

- [ ] **Step 4: Implement `createRevealTransaction`** in `commit.ts`. Build a taproot script-path spend of the commit output using `@scure/btc-signer`'s `tapLeafScript` (the inscription `script` + `controlBlock` + `leafVersion` from the commit result), sign with `revealPrivateKey`, finalize:

```ts
export async function createRevealTransaction(
  params: RevealTransactionParams
): Promise<RevealTransactionResult> {
  const {
    commitTxId, commitVout, commitAmount,
    revealPrivateKey, revealPublicKey, inscriptionScript,
    destinationAddress, feeRate, network
  } = params;

  if (!validateBitcoinAddress(destinationAddress, network === 'testnet' ? 'signet' : network)) {
    throw new Error(`Invalid destination address for network ${network}`);
  }

  const scureNetwork = getScureNetwork(network);
  const internalKey = Buffer.from(revealPublicKey, 'hex');
  const privKey = Buffer.from(revealPrivateKey, 'hex');

  // Reconstruct the committed P2TR output script (the commit output we are
  // spending) from the same reveal internal key + inscription leaf, so the
  // signer knows the prevout scriptPubKey.
  const leafScript = inscriptionScript.script;
  const controlBlock = inscriptionScript.controlBlock;
  const leafVersion = inscriptionScript.leafVersion ?? 0xc0;

  // The commit output was created with btc.p2tr(internalKey, scriptTree, ...,
  // [ordinals.OutOrdinalReveal]); rebuild the payment to obtain its script.
  // We only need the spend info (tapLeafScript) — reconstruct via the leaf.
  const revealFee = Number(calculateFee(estimateRevealTxSize(leafScript.length, controlBlock.length), feeRate));
  const postageValue = commitAmount - revealFee;
  if (postageValue < MIN_DUST_LIMIT) {
    throw new Error(`Commit amount ${commitAmount} cannot cover reveal fee ${revealFee} + dust ${MIN_DUST_LIMIT}`);
  }

  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  // The prevout script for a P2TR is OP_1 <32-byte tweaked key>. Rebuild the
  // committed output with the same construction used in createCommitTransaction
  // so tapLeafScript / tapInternalKey line up.
  const inscription = undefined; // not needed: we spend via tapLeafScript below
  const commitP2tr = btc.p2tr(
    internalKey,
    { script: leafScript, version: leafVersion } as any, // single-leaf tree
    scureNetwork,
    false,
    [ordinals.OutOrdinalReveal]
  );

  tx.addInput({
    txid: commitTxId,
    index: commitVout,
    witnessUtxo: { script: commitP2tr.script, amount: BigInt(commitAmount) },
    tapLeafScript: [[
      { version: leafVersion, internalKey, merklePath: (commitP2tr.leaves?.[0]?.path ?? []) },
      Uint8Array.from([...leafScript, leafVersion])
    ]] as any,
    tapInternalKey: internalKey
  });

  tx.addOutputAddress(destinationAddress, BigInt(postageValue), scureNetwork);

  tx.signIdx(privKey, 0, undefined, undefined);
  tx.finalize();

  const revealTxHex = Buffer.from(tx.extract()).toString('hex');
  const revealTxId = tx.id;
  return { revealTxHex, revealTxId, inscriptionId: `${revealTxId}i0`, postageValue };
}
```

> **Implementer note:** the exact `tapLeafScript` / `p2tr` argument shapes must match this repo's `@scure/btc-signer` version. The commit builder (same file, ~367-402) is your source of truth for how the leaf, control block, and `OutOrdinalReveal` custom script are constructed — mirror it. If reconstructing the single-leaf tree from only `script`+`controlBlock` proves unreliable, the cleaner fix is to have `createCommitTransaction` additionally return the `scriptTree`/leaf `path` on `CommitTransactionResult` and pass it through — do that rather than guessing. Get the failing test green before moving on; a reveal that doesn't finalize is a hard blocker, not a "close enough".

- [ ] **Step 5: Export it** — add `createRevealTransaction` to `src/bitcoin/transactions/index.ts` exports.

- [ ] **Step 6: Run the test, verify it passes**

Run: `cd packages/sdk && bun test tests/unit/bitcoin/createRevealTransaction.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole bitcoin suite (no regressions in commit)**

Run: `cd packages/sdk && bun test tests/unit/bitcoin`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/bitcoin/transactions packages/sdk/tests
git commit --no-verify -m "feat(bitcoin): createRevealTransaction — sign+finalize the inscription reveal"
```

---

## Task 3: `BitcoinSigner` + sat-selected orchestration helper `inscribeOnSat`

**Files:**
- Modify: `src/types/common.ts` (append `BitcoinSigner`)
- Create: `src/bitcoin/inscribe-on-sat.ts`
- Test: `packages/sdk/tests/unit/bitcoin/inscribeOnSat.test.ts`

**Interfaces:**
- Consumes: `OrdinalsProvider.getFirstSatOfOutput` (Task 1), `createCommitTransaction` + `createRevealTransaction` (Task 2), `OrdinalsProvider.broadcastTransaction`, `OrdinalsProvider.getInscriptionById(id) → { satoshi? }`.
- Produces:
```ts
// src/types/common.ts
export interface BitcoinSigner {
  signCommitPsbt(psbtBase64: string): Promise<string>; // signed PSBT base64 OR signed tx hex, ready to broadcast
  getFundingAddress(): Promise<string> | string;
}

// src/bitcoin/inscribe-on-sat.ts
export interface InscribeOnSatParams {
  buildContent: (satoshi: string) => Promise<{ content: Buffer; contentType: string; metadata?: Record<string, unknown> }>;
  fundingUtxo: Utxo;
  satSigner: BitcoinSigner;
  changeAddress: string;
  feeRate: number;
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  provider: OrdinalsProvider;
}
export interface InscribeOnSatResult {
  satoshi: string;          // the derived, verified DID sat
  inscriptionId: string;
  commitTxId: string;
  revealTxId: string;
}
export async function inscribeOnSat(params: InscribeOnSatParams): Promise<InscribeOnSatResult>
```

- [ ] **Step 1: Write the failing test** using an in-test provider double + mock signer (full control over the derived sat and the landed sat — no OrdMock coherence needed):

```ts
import { describe, it, expect, mock } from 'bun:test';
import { inscribeOnSat } from '../../../src/bitcoin/inscribe-on-sat';
import { sampleUtxo, sampleChangeAddress } from '../../fixtures/bitcoin';

function providerDouble(overrides: any = {}) {
  return {
    getFirstSatOfOutput: async () => '1250000000',
    broadcastTransaction: async () => 'cc'.repeat(32),
    getInscriptionById: async (id: string) => ({ inscriptionId: id, satoshi: '1250000000' }),
    ...overrides
  } as any;
}
const signer = { signCommitPsbt: async (p: string) => p, getFundingAddress: () => sampleChangeAddress };
const buildContent = async (sat: string) => ({ content: Buffer.from(`doc for ${sat}`), contentType: 'application/did+json' });

describe('inscribeOnSat', () => {
  it('derives the sat from the provider and returns it as the DID sat', async () => {
    const res = await inscribeOnSat({
      buildContent, fundingUtxo: sampleUtxo, satSigner: signer,
      changeAddress: sampleChangeAddress, feeRate: 2, network: 'regtest', provider: providerDouble()
    });
    expect(res.satoshi).toBe('1250000000');
    expect(res.inscriptionId).toMatch(/i0$/);
  });

  it('fails closed with SAT_MISMATCH when the landed sat differs from the derived sat', async () => {
    const provider = providerDouble({ getInscriptionById: async (id: string) => ({ inscriptionId: id, satoshi: '9999' }) });
    await expect(inscribeOnSat({
      buildContent, fundingUtxo: sampleUtxo, satSigner: signer,
      changeAddress: sampleChangeAddress, feeRate: 2, network: 'regtest', provider
    })).rejects.toThrow(/SAT_MISMATCH/);
  });

  it('throws SAT_INDEX_UNSUPPORTED when the provider lacks getFirstSatOfOutput', async () => {
    const provider = providerDouble({ getFirstSatOfOutput: undefined });
    await expect(inscribeOnSat({
      buildContent, fundingUtxo: sampleUtxo, satSigner: signer,
      changeAddress: sampleChangeAddress, feeRate: 2, network: 'regtest', provider
    })).rejects.toThrow(/SAT_INDEX_UNSUPPORTED/);
  });

  it('calls the signer with the COMMIT psbt, not the reveal', async () => {
    const signCommitPsbt = mock(async (p: string) => p);
    await inscribeOnSat({
      buildContent, fundingUtxo: sampleUtxo, satSigner: { signCommitPsbt, getFundingAddress: () => sampleChangeAddress },
      changeAddress: sampleChangeAddress, feeRate: 2, network: 'regtest', provider: providerDouble()
    });
    expect(signCommitPsbt).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd packages/sdk && bun test tests/unit/bitcoin/inscribeOnSat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `BitcoinSigner`** to `src/types/common.ts` (append the interface exactly as in the Interfaces block above; grep the file first to match its export style).

- [ ] **Step 4: Implement `inscribe-on-sat.ts`:**

```ts
import { Utxo } from '../types/bitcoin.js';
import { BitcoinSigner } from '../types/common.js';
import { OrdinalsProvider } from '../adapters/types.js';
import { StructuredError } from '../utils/telemetry.js';
import { validateSatoshiNumber } from '../utils/satoshi-validation.js';
import { createCommitTransaction, createRevealTransaction } from './transactions/commit.js';

export async function inscribeOnSat(params: InscribeOnSatParams): Promise<InscribeOnSatResult> {
  const { buildContent, fundingUtxo, satSigner, changeAddress, feeRate, network, provider } = params;

  if (typeof provider.getFirstSatOfOutput !== 'function') {
    throw new StructuredError('SAT_INDEX_UNSUPPORTED',
      'The ordinals provider cannot resolve the funding output\'s sat (no sat index); cannot select the did:btco sat.');
  }

  // 1) Derive the authoritative DID sat from the provider.
  const satoshi = await provider.getFirstSatOfOutput({ txid: fundingUtxo.txid, vout: fundingUtxo.vout });
  const v = validateSatoshiNumber(satoshi);
  if (!v.valid) throw new StructuredError('INVALID_SATOSHI', `Provider returned invalid sat: ${v.error}`);

  // 2) Build content embedding did:btco:<sat> (caller's closure appends the CEL migrate event).
  const { content, contentType, metadata } = await buildContent(satoshi);

  // 3) Unsigned commit: single funding input, inscription output at vout 0, no pointer.
  const commit = await createCommitTransaction({
    content, contentType, metadata,
    utxos: [fundingUtxo], changeAddress, feeRate, network
  });

  // 4) Caller signs the commit; broadcast it.
  const signedCommit = await satSigner.signCommitPsbt(commit.commitPsbtBase64);
  const commitTxId = await provider.broadcastTransaction(signedCommit);

  // 5) Build + self-sign the reveal spending the commit output (vout 0); broadcast.
  const reveal = await createRevealTransaction({
    commitTxId, commitVout: 0, commitAmount: commit.commitAmount,
    revealPrivateKey: commit.revealPrivateKey, revealPublicKey: commit.revealPublicKey,
    inscriptionScript: commit.inscriptionScript,
    destinationAddress: changeAddress, feeRate, network
  });
  const revealTxId = await provider.broadcastTransaction(reveal.revealTxHex);

  // 6) Fail-closed: the landed inscription MUST sit on the derived sat.
  const landed = await provider.getInscriptionById(reveal.inscriptionId);
  if (!landed || String(landed.satoshi ?? '') !== satoshi) {
    throw new StructuredError('SAT_MISMATCH',
      `Inscription ${reveal.inscriptionId} landed on sat ${landed?.satoshi ?? 'unknown'}, expected ${satoshi}; the did:btco identity would be wrong.`);
  }

  return { satoshi, inscriptionId: reveal.inscriptionId, commitTxId, revealTxId };
}
```

Add the `InscribeOnSatParams` / `InscribeOnSatResult` interface declarations (from the Interfaces block) at the top of the file. Confirm the exact import paths by grepping (`StructuredError`, `validateSatoshiNumber`, `OrdinalsProvider`, `Utxo`).

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd packages/sdk && bun test tests/unit/bitcoin/inscribeOnSat.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types/common.ts src/bitcoin/inscribe-on-sat.ts packages/sdk/tests/unit/bitcoin/inscribeOnSat.test.ts
git commit --no-verify -m "feat(bitcoin): inscribeOnSat helper — derive sat, sign commit, verify fail-closed"
```

---

## Task 4: Wire into `LifecycleManager.inscribeOnBitcoin` + batch + changeset

**Files:**
- Modify: `src/lifecycle/LifecycleManager.ts` — `inscribeOnBitcoin` (grep `async inscribeOnBitcoin(` — it starts ~2182; read the ~2182-2300 window and the `buildContent` closure only, NOT the whole file)
- Modify: `src/lifecycle/BatchLifecycleOperations.ts` (grep `inscribeOnBitcoin` — lines ~30 and ~264)
- Create: `.changeset/selectable-target-sat.md`
- Test: `packages/sdk/tests/unit/lifecycle/inscribeOnBitcoin.satSelect.test.ts`

**Interfaces:**
- Consumes: `inscribeOnSat` (Task 3), `BitcoinSigner` (Task 3).
- Produces: `inscribeOnBitcoin(asset, opts?: number | InscribeOnBitcoinOptions)` where
  `InscribeOnBitcoinOptions = { fundingUtxo?: Utxo; satSigner?: BitcoinSigner; changeAddress?: string; feeRate?: number }`.

- [ ] **Step 1: Read** the `inscribeOnBitcoin` method body window (grep the method, read ~2182-2320) and its `buildContent` closure and the `celLogBefore` rollback (grep `celLogBefore` in the method). Understand that the closure appends the migrate CEL event given a sat and builds the btco doc.

- [ ] **Step 2: Write the failing test** — sat-selected path end-to-end through the SDK with an in-test provider double, asserting the asset's anchoring sat == the derived sat:

```ts
import { describe, it, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src/core/OriginalsSDK';
// Grep an existing lifecycle test for the standard create→publish setup and reuse it.

describe('inscribeOnBitcoin (sat-selected)', () => {
  it('inscribes the genesis did:btco onto the caller-derived sat', async () => {
    // Build an SDK whose ordinalsProvider double returns getFirstSatOfOutput='1777',
    // broadcastTransaction=<txid>, getInscriptionById=>{satoshi:'1777'}.
    // create → publishToWeb → inscribeOnBitcoin(asset, { fundingUtxo, satSigner, changeAddress })
    // Assert the resulting asset's btco DID / anchoring sat is 1777.
    // (Fill setup from the existing lifecycle test harness.)
  });

  it('rejects fundingUtxo without satSigner/changeAddress (INVALID_INPUT)', async () => {
    // ... inscribeOnBitcoin(asset, { fundingUtxo }) rejects /INVALID_INPUT/
  });

  it('legacy inscribeOnBitcoin(asset) still works with OrdMock (provider picks the sat)', async () => {
    // ... existing behavior unchanged
  });
});
```

Flesh the setup from the nearest existing `tests/unit/lifecycle` inscribe test (grep `inscribeOnBitcoin` under `tests/`). The point is the three assertions.

- [ ] **Step 3: Run it, verify it fails**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/inscribeOnBitcoin.satSelect.test.ts`
Expected: FAIL.

- [ ] **Step 4: Normalize the options + route.** In `inscribeOnBitcoin`, accept `opts?: number | InscribeOnBitcoinOptions`. Near the top of the method:

```ts
const options = typeof opts === 'number' ? { feeRate: opts } : (opts ?? {});
const feeRate = options.feeRate;
if (options.fundingUtxo) {
  if (!options.satSigner || !options.changeAddress) {
    throw new StructuredError('INVALID_INPUT',
      'Sat-selected inscription requires satSigner and changeAddress alongside fundingUtxo.');
  }
}
```

Add `InscribeOnBitcoinOptions` to the method's type surface (declare near the other lifecycle option types — grep for an existing options interface in the file to place it consistently).

- [ ] **Step 5: Route the sat-selected branch.** Keep the existing `buildContent` closure (the one passed to `bitcoinManager.inscribeData`) as a named local. When `options.fundingUtxo` is present, call `inscribeOnSat` with that same closure INSTEAD of `bitcoinManager.inscribeData`, and use its returned `satoshi`. Wrap it in the SAME try/catch that restores `celLogBefore`, so a `SAT_MISMATCH` (or any throw) rolls the in-memory log back exactly like the legacy path. Sketch:

```ts
// buildContentForSat(sat) returns { content, contentType, metadata } and, as a
// side effect, appends the migrate CEL event for `sat` (the existing closure).
let inscription;
if (options.fundingUtxo) {
  const result = await inscribeOnSat({
    buildContent: buildContentForSat,
    fundingUtxo: options.fundingUtxo,
    satSigner: options.satSigner!,
    changeAddress: options.changeAddress!,
    feeRate: this.resolveInscribeFeeRate(feeRate),   // reuse existing fee resolution
    network,
    provider: this.getOrdinalsProviderOrThrow()      // reuse existing provider accessor
  });
  inscription = { satoshi: result.satoshi, inscriptionId: result.inscriptionId,
                  commitTxId: result.commitTxId, revealTxId: result.revealTxId };
} else {
  inscription = await bitcoinManager.inscribeData(buildContentForSat, feeRate);
}
```

Grep for the existing provider accessor + fee-rate resolver names in the file and use the real ones (do not invent `getOrdinalsProviderOrThrow`/`resolveInscribeFeeRate` if the actual helpers differ). The downstream code (capturing `inscribedBtcoDoc`, `migrateToDIDBTCO`, `#cel` anchor, layer advance) already runs off `inscription.satoshi` — leave it unchanged.

- [ ] **Step 6: Mirror the options in `BatchLifecycleOperations`** — widen the `inscribeOnBitcoin` signature (lines ~30 and the call ~264) to pass `opts` through unchanged.

- [ ] **Step 7: Run the new test + the existing lifecycle inscribe tests**

Run: `cd packages/sdk && bun test tests/unit/lifecycle`
Expected: PASS (new + existing, legacy path unchanged).

- [ ] **Step 8: Add the changeset** `.changeset/selectable-target-sat.md`:

```markdown
---
"@originals/sdk": minor
---

`inscribeOnBitcoin` can now inscribe the genesis did:btco onto a caller-chosen
funding UTXO whose first sat becomes the DID: the sat is derived from the
provider's sat index (`getFirstSatOfOutput`), the commit is signed by a caller
`BitcoinSigner`, and the result is verified fail-closed against the intended sat
(`SAT_MISMATCH` rolls back and commits nothing). Callers now control the
permanent `did:btco:<sat>` identity instead of accepting an arbitrary
provider-selected sat. The legacy `inscribeOnBitcoin(asset)` /
`(asset, feeRate)` path is unchanged. (#369)
```

- [ ] **Step 9: Commit**

```bash
git add src/lifecycle packages/sdk/tests/unit/lifecycle .changeset/selectable-target-sat.md
git commit --no-verify -m "feat(lifecycle): caller-selectable target sat for genesis did:btco inscription"
```

---

## Task 5: #369 cleanup — delete dead `preventFrontRunning`

**Files:**
- Modify: `src/bitcoin/BitcoinManager.ts` (grep `preventFrontRunning` — ~line 360)
- Test: whichever suite references it (grep `preventFrontRunning` under `tests/` first)

- [ ] **Step 1: Grep** `preventFrontRunning` across `src` and `tests`. Confirm it is only defined + (possibly) tested, never called by production code.

- [ ] **Step 2: Delete** the `preventFrontRunning` method from `BitcoinManager.ts`. Delete or update any test that only exercised it (a test of dead code has no value; remove it rather than keep it green).

- [ ] **Step 3: Run the bitcoin + full suite**

Run: `cd packages/sdk && bun test`
Expected: PASS, 0 failures (skips fine).

- [ ] **Step 4: Commit**

```bash
git add src/bitcoin/BitcoinManager.ts packages/sdk/tests
git commit --no-verify -m "chore(bitcoin): remove dead preventFrontRunning (#369)

Front-running/uniqueness is provided by first-anchor-wins verified fail-closed
in verifyEventLog (getAnchoringsForDidCel); the naive uninvoked counter was
never wired. createCommitTransaction is now wired via inscribeOnSat."
```

---

## Final verification (after all tasks)

- [ ] `cd packages/sdk && bun test` — full suite green (0 failures).
- [ ] `cd packages/sdk && bun run build` (or the repo's typecheck) — compiles clean.
- [ ] Confirm the spec's §8 testing spine is covered: derived-sat drives the DID (Task 4), external-signer signs the commit (Task 3), end-to-end lands on the intended sat (Task 4), SAT_MISMATCH fail-closed + rollback (Tasks 3 + 4), SAT_INDEX_UNSUPPORTED (Task 3), missing signer/changeAddress INVALID_INPUT (Task 4), legacy path preserved (Task 4), reinscription unchanged (unchanged code — no task needed).
