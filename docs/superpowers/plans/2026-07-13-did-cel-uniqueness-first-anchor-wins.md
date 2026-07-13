# did:cel Uniqueness — First-Anchor-Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the malicious-controller *duping* case (one `did:cel` signed onto two sats, both sold) by making a btco-anchored `did:cel` log verify only when its anchored sat is the *canonical* one — the sat of the log's earliest on-chain anchoring (first-anchor-wins).

**Architecture:** A new provider capability `getAnchoringsForDidCel(didCel)` enumerates every on-chain btco DID-doc anchoring that back-links a `did:cel` (via `alsoKnownAs`). `verifyEventLog` gains a `verifyUniqueness` pass — a peer of `verifyHeadFreshness` — that runs whenever a `did:cel` log is btco-anchored and a provider is present: it groups anchorings by sat, picks the sat whose earliest anchoring has the lowest confirmed block height, and rejects the log (`NON_CANONICAL_ANCHOR`) if its anchored sat is not that canonical sat. The writer guarantees the inscribed btco doc carries its `did:cel` in `alsoKnownAs` so anchorings are enumerable.

**Tech Stack:** TypeScript, Bun runtime, `@noble/ed25519`, the SDK's CEL algorithms (`packages/sdk/src/cel/`), the ordinals provider adapters (`packages/sdk/src/adapters/`), Changesets for release notes.

## Global Constraints

- **BLOCKED ON the signed-anchored-sat spec (`docs/superpowers/specs/2026-07-13-anchored-sat-identity-design.md`, "Part A") landing first.** This plan is a follow-up: uniqueness compares the log's *anchored sat*, and that sat is only sound once it is the controller-**signed** `did:btco:<network>:<sat>` from the migrate body (Part A) rather than the attacker-editable witness. The *mechanism* here keys off `verifyEventLog`'s existing `anchoredSat` walk-state (so the tests are runnable against the current tree), but the *security guarantee* is only real once Part A makes `anchoredSat` the signed sat. Do not merge this ahead of Part A.
- **Runtime:** Bun. Run tests with `bun test <path>`; never `npm`/`node`.
- **Green bar:** `bun test` must pass in full before the final commit.
- **Commit hook:** the repo's commit hook shells out to a commitlint binary that is missing in this environment — every `git commit` in this plan MUST pass `--no-verify`.
- **Imports:** absolute from `src/` root within source; tests import via relative paths matching the existing test files (e.g. `../../../src/cel/...`) — follow the neighbouring test's convention exactly.
- **Provider posture (fail-closed, not opt-in):** uniqueness is part of the btco verification contract. A btco-anchored `did:cel` log already requires a provider; a provider that cannot enumerate (`getAnchoringsForDidCel` absent) or any anchoring missing a `blockHeight` → `UNIQUENESS_UNVERIFIABLE`. A same-block tie between two *different* sats → `AMBIGUOUS_CANONICAL`. No basic-provider skip path.
- **Changeset required:** the repo gates on "Changeset present" — the final task adds `.changeset/did-cel-uniqueness-first-anchor-wins.md`.

---

## File Structure

- `packages/sdk/src/cel/types.ts` — add `getAnchoringsForDidCel` to the `OrdinalsLookup` surface (the minimal shape `verifyEventLog` consumes).
- `packages/sdk/src/adapters/types.ts` — add the same method to the `OrdinalsProvider` adapter interface (structural super-set of `OrdinalsLookup`).
- `packages/sdk/src/adapters/providers/OrdMockProvider.ts` — implement `getAnchoringsForDidCel` for tests.
- `packages/sdk/src/cel/algorithms/verifyEventLog.ts` — add `verifyUniqueness` and wire it into `verifyEventLog`.
- `packages/sdk/src/lifecycle/LifecycleManager.ts` — writer: guarantee the inscribed btco doc's `alsoKnownAs` carries the `did:cel`.
- Tests:
  - `packages/sdk/tests/unit/adapters/OrdMockProvider.getAnchoringsForDidCel.test.ts`
  - `packages/sdk/tests/unit/lifecycle/inscribe-alsoKnownAs-didcel.test.ts`
  - `packages/sdk/tests/unit/cel/did-cel-uniqueness.test.ts`
- `.changeset/did-cel-uniqueness-first-anchor-wins.md`

---

### Task 1: Provider capability — `getAnchoringsForDidCel`

**Files:**
- Modify: `packages/sdk/src/cel/types.ts:153-174` (the `OrdinalsLookup` interface)
- Modify: `packages/sdk/src/adapters/types.ts:22-88` (the `OrdinalsProvider` interface)
- Modify: `packages/sdk/src/adapters/providers/OrdMockProvider.ts`
- Test: `packages/sdk/tests/unit/adapters/OrdMockProvider.getAnchoringsForDidCel.test.ts`

**Interfaces:**
- Produces:
  ```ts
  getAnchoringsForDidCel(didCel: string): Promise<Array<{
    satoshi: string;
    inscriptionId: string;
    blockHeight?: number;
  }>>;
  ```
  Enumerates every inscription whose parsed DID-document content lists `didCel` in `alsoKnownAs`. Consumed by `verifyUniqueness` (Task 3) and the writer round-trip test (Task 2).

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/tests/unit/adapters/OrdMockProvider.getAnchoringsForDidCel.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';

const DID_CEL = 'did:cel:uZZZ';

function btcoDoc(satoshi: string, alsoKnownAs: string[]) {
  const id = `did:btco:reg:${satoshi}`;
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id,
    alsoKnownAs,
    service: [{ id: `${id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase: 'uHEAD' } }],
  };
}

async function inscribe(p: OrdMockProvider, satoshi: string, alsoKnownAs: string[]) {
  const res = await p.createInscription({
    data: Buffer.from(JSON.stringify(btcoDoc(satoshi, alsoKnownAs))),
    contentType: 'application/did+json',
    targetSatoshi: satoshi,
  });
  return res.inscriptionId;
}

describe('OrdMockProvider.getAnchoringsForDidCel', () => {
  test('returns every inscription whose alsoKnownAs back-links the did:cel', async () => {
    const p = new OrdMockProvider();
    const iX = await inscribe(p, '100', [DID_CEL, 'did:webvh:example.com:x']);
    const iY = await inscribe(p, '200', [DID_CEL]);
    // Unrelated inscription: different did:cel, must NOT be returned.
    await inscribe(p, '300', ['did:cel:uOTHER']);

    const anchorings = await p.getAnchoringsForDidCel(DID_CEL);
    const bySat = new Map(anchorings.map((a) => [a.satoshi, a]));

    expect(anchorings).toHaveLength(2);
    expect(bySat.get('100')!.inscriptionId).toBe(iX);
    expect(bySat.get('200')!.inscriptionId).toBe(iY);
    // OrdMock stamps every inscription with a confirmed block height.
    expect(typeof bySat.get('100')!.blockHeight).toBe('number');
  });

  test('returns an empty array when no inscription back-links the did:cel', async () => {
    const p = new OrdMockProvider();
    await inscribe(p, '100', ['did:cel:uSOMETHINGELSE']);
    expect(await p.getAnchoringsForDidCel(DID_CEL)).toEqual([]);
  });

  test('skips non-JSON / non-DID-document inscriptions', async () => {
    const p = new OrdMockProvider();
    await p.createInscription({ data: Buffer.from('not json'), contentType: 'text/plain', targetSatoshi: '100' });
    expect(await p.getAnchoringsForDidCel(DID_CEL)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/adapters/OrdMockProvider.getAnchoringsForDidCel.test.ts`
Expected: FAIL — `p.getAnchoringsForDidCel is not a function`.

- [ ] **Step 3: Add the method to the `OrdinalsLookup` surface**

In `packages/sdk/src/cel/types.ts`, inside `interface OrdinalsLookup` (after the `getInscriptionsBySatoshi?` member, before the closing brace at line 174), add:

```ts
  /**
   * Enumerate every on-chain btco DID-doc anchoring whose `alsoKnownAs`
   * back-links this did:cel. `blockHeight` is the canonical ordering signal
   * (first-anchor-wins). Required for btco-anchored did:cel verification: a
   * btco log already needs a provider, so a provider that cannot enumerate
   * fails uniqueness CLOSED (`UNIQUENESS_UNVERIFIABLE`). Multiple inscriptions
   * on the SAME sat (migrate + rotation reinscriptions) are expected and do
   * not compete — only a different, earlier sat wins.
   */
  getAnchoringsForDidCel?(didCel: string): Promise<Array<{
    satoshi: string;
    inscriptionId: string;
    blockHeight?: number;
  }>>;
```

- [ ] **Step 4: Add the method to the `OrdinalsProvider` adapter interface**

In `packages/sdk/src/adapters/types.ts`, inside `interface OrdinalsProvider` (after the `getSatOwnership?` member, before `transferInscription`), add:

```ts
  /**
   * Enumerate every on-chain btco DID-doc anchoring whose `alsoKnownAs`
   * back-links this did:cel (first-anchor-wins uniqueness). Production
   * providers implement this via a content/metadata index (an `ord` instance
   * or a service such as the QuickNode Ordinals add-on). `blockHeight` is the
   * canonical ordering signal; a missing height fails uniqueness closed.
   */
  getAnchoringsForDidCel?(didCel: string): Promise<Array<{
    satoshi: string;
    inscriptionId: string;
    blockHeight?: number;
  }>>;
```

- [ ] **Step 5: Implement `getAnchoringsForDidCel` on `OrdMockProvider`**

In `packages/sdk/src/adapters/providers/OrdMockProvider.ts`, add this method to the `OrdMockProvider` class (after `getSatOwnership`, before `transferInscription`):

```ts
  // eslint-disable-next-line @typescript-eslint/require-await
  async getAnchoringsForDidCel(didCel: string): Promise<Array<{
    satoshi: string;
    inscriptionId: string;
    blockHeight?: number;
  }>> {
    const out: Array<{ satoshi: string; inscriptionId: string; blockHeight?: number }> = [];
    for (const rec of this.state.inscriptionsById.values()) {
      if (rec.satoshi === undefined) continue;
      let content: unknown;
      try {
        content = JSON.parse(rec.content.toString('utf8'));
      } catch {
        continue; // non-JSON inscription — not a DID document
      }
      const aka = (content as { alsoKnownAs?: unknown } | null)?.alsoKnownAs;
      if (Array.isArray(aka) && aka.includes(didCel)) {
        out.push({ satoshi: rec.satoshi, inscriptionId: rec.inscriptionId, blockHeight: rec.blockHeight });
      }
    }
    return out;
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/sdk && bun test tests/unit/adapters/OrdMockProvider.getAnchoringsForDidCel.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/cel/types.ts packages/sdk/src/adapters/types.ts packages/sdk/src/adapters/providers/OrdMockProvider.ts packages/sdk/tests/unit/adapters/OrdMockProvider.getAnchoringsForDidCel.test.ts
git commit --no-verify -m "feat(cel): add getAnchoringsForDidCel provider capability + OrdMock impl"
```

---

### Task 2: Writer — guarantee `did:cel` in the inscribed btco doc's `alsoKnownAs`

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts:1895-1908` (the `backLinks` construction inside `inscribeOnBitcoin`'s `buildContent`)
- Test: `packages/sdk/tests/unit/lifecycle/inscribe-alsoKnownAs-didcel.test.ts`

**Interfaces:**
- Consumes: `getAnchoringsForDidCel` (Task 1), `deriveDidCel` (already imported at `LifecycleManager.ts:29`).
- Produces: the inscribed `did:btco` document's `alsoKnownAs` deterministically contains `deriveDidCel(asset.celLog)` as its first entry, so `provider.getAnchoringsForDidCel(assetDid)` finds it.

**Context:** today `backLinks = [asset.id, asset.bindings?.['did:webvh']]`. `asset.id` *is* the derived `did:cel`, so the back-link is present incidentally. This task makes it explicit and robust: derive the `did:cel` from the genesis event directly (not from the mutable `asset.id`), dedupe, and lock the invariant with a round-trip test.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/tests/unit/lifecycle/inscribe-alsoKnownAs-didcel.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { deriveDidCel } from '../../../src/cel/celDid';

describe('inscribeOnBitcoin — did:cel back-link in alsoKnownAs', () => {
  test('inscribed btco doc back-links the did:cel; enumerable via getAnchoringsForDidCel', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      keyStore: new MockKeyStore(),
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) },
    ]);
    const didCel = deriveDidCel(asset.celLog!);
    expect(didCel.startsWith('did:cel:')).toBe(true);
    expect(asset.id).toBe(didCel);

    await sdk.lifecycle.inscribeOnBitcoin(asset);

    // Round-trip: the anchoring is indexable by the asset's did:cel.
    const anchorings = await provider.getAnchoringsForDidCel!(didCel);
    expect(anchorings.length).toBeGreaterThanOrEqual(1);
    // The anchored sat carries the inscription.
    const btcoDid = asset.bindings!['did:btco']!;
    const sat = btcoDid.replace(/^did:btco:(reg:|sig:)?/, '');
    expect(anchorings.some((a) => a.satoshi === sat)).toBe(true);

    // And the inscribed document literally lists the did:cel first.
    const resolved = await sdk.did.resolveDID(btcoDid, { skipCache: true });
    expect(resolved!.alsoKnownAs?.[0]).toBe(didCel);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/inscribe-alsoKnownAs-didcel.test.ts`
Expected: FAIL — `provider.getAnchoringsForDidCel` exists (Task 1) but the assertion `anchorings.length >= 1` or `alsoKnownAs?.[0] === didCel` may fail if `asset.id` ordering/derivation differs; the test fails until the explicit derivation lands. (If it happens to pass on `asset.id`, the explicit change below still makes the invariant robust — proceed.)

- [ ] **Step 3: Make the `did:cel` back-link explicit and deduped**

In `packages/sdk/src/lifecycle/LifecycleManager.ts`, replace the `backLinks` construction at lines 1895-1897:

```ts
    const backLinks = [asset.id, asset.bindings?.['did:webvh']].filter(
      (d): d is string => typeof d === 'string'
    );
```

with:

```ts
    // First-anchor-wins uniqueness (#did-cel-uniqueness): the inscribed btco
    // doc MUST back-link its did:cel so on-chain anchorings are enumerable via
    // getAnchoringsForDidCel. Derive it from the genesis event (not the mutable
    // asset.id) and place it first; dedupe so a coincidental asset.id === didCel
    // does not double-list. The did:webvh predecessor follows.
    const didCel = asset.celLog ? deriveDidCel(asset.celLog) : asset.id;
    const backLinks = [didCel, asset.id, asset.bindings?.['did:webvh']].filter(
      (d, i, arr): d is string => typeof d === 'string' && arr.indexOf(d) === i
    );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/inscribe-alsoKnownAs-didcel.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Guard against regressions in the existing inscribe suite**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/LifecycleManager.rotateBtcoKeys.test.ts`
Expected: PASS (no regressions — `alsoKnownAs` gained a deduped first entry only).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/lifecycle/LifecycleManager.ts packages/sdk/tests/unit/lifecycle/inscribe-alsoKnownAs-didcel.test.ts
git commit --no-verify -m "feat(lifecycle): back-link did:cel in inscribed btco doc alsoKnownAs"
```

---

### Task 3: Verifier — `verifyUniqueness` + wire-in (first-anchor-wins)

**Files:**
- Modify: `packages/sdk/src/cel/algorithms/verifyEventLog.ts` (add `verifyUniqueness` after `verifyHeadFreshness`, ~line 562; wire into `verifyEventLog` after the `assetDid` computation, ~line 1396)
- Test: `packages/sdk/tests/unit/cel/did-cel-uniqueness.test.ts`

**Interfaces:**
- Consumes: `OrdinalsLookup.getAnchoringsForDidCel` (Task 1), the existing `AnchoredSat` interface (`verifyEventLog.ts:570`), the derived `assetDid` (`did:cel:...`), `inscriptionBlockHeight`-style integer validation.
- Produces: a `verifyUniqueness(didCel, anchoredSat, ordinalsProvider): Promise<string | null>` that returns a coded error string (`NON_CANONICAL_ANCHOR` / `AMBIGUOUS_CANONICAL` / `UNIQUENESS_UNVERIFIABLE`) or `null` when the anchored sat is canonical. `verifyEventLog` folds a non-null result into `errors` and `verified === false`.

- [ ] **Step 1: Write the failing test (first-anchor-wins + honest branch)**

Create `packages/sdk/tests/unit/cel/did-cel-uniqueness.test.ts`:

```ts
/**
 * did:cel uniqueness — first-anchor-wins (follow-up to the signed-anchored-sat
 * spec). A btco-anchored did:cel log verifies only when its anchored sat is the
 * canonical one: the sat of the log's earliest on-chain anchoring (lowest
 * confirmed block height, grouped by sat). Non-canonical → NON_CANONICAL_ANCHOR.
 *
 * NOTE: soundness assumes Part A (signed anchored sat) has landed, so the
 * verifier's anchoredSat is the SIGNED sat, not the attacker-editable witness.
 * The mechanism below keys off the existing anchoredSat walk-state, so these
 * fixtures are runnable against the current tree.
 */
import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent, canonicalizeEntryForChain } from '../../../src/cel/canonicalize';
import { computeDigestMultibase } from '../../../src/cel/hash';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
import { deriveDidCel } from '../../../src/cel/celDid';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import type { EventLog, LogEntry } from '../../../src/cel/types';

async function makeKey() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed25519.getPublicKeyAsync(priv);
  const pubMb = multikey.encodePublicKey(pub, 'Ed25519');
  const didKey = `did:key:${pubMb}`;
  const vm = `${didKey}#${pubMb}`;
  const signer = async (data: unknown) => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2026-07-13T00:00:00Z',
    verificationMethod: vm,
    proofPurpose: 'assertionMethod',
    proofValue: multikey.encodeMultibase(
      new Uint8Array(await ed25519.signAsync(canonicalizeEvent(data), priv))
    ),
  });
  return { signer, didKey, vm, pubMb };
}
type Key = Awaited<ReturnType<typeof makeKey>>;

const chainDigest = (e: LogEntry) => computeDigestMultibase(canonicalizeEntryForChain(e));

// A btco DID document that back-links the did:cel (Task-2 writer shape).
function btcoDoc(satoshi: string, headDigestMultibase: string, didCel: string) {
  const id = `did:btco:reg:${satoshi}`;
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id,
    alsoKnownAs: [didCel],
    service: [{ id: `${id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase } }],
  };
}

function attachWitness(log: EventLog, insc: { inscriptionId: string; txid: string }, satoshi: string): EventLog {
  const last = log.events[log.events.length - 1];
  const witnessedAt = '2026-07-13T00:00:01Z';
  const witnessProof = {
    type: 'DataIntegrityProof',
    cryptosuite: 'bitcoin-ordinals-2024',
    created: witnessedAt,
    verificationMethod: 'did:btco:witness',
    proofPurpose: 'assertionMethod',
    proofValue: `z${insc.inscriptionId}`,
    witnessedAt,
    txid: insc.txid,
    satoshi,
    inscriptionId: insc.inscriptionId,
  };
  return { events: [...log.events.slice(0, -1), { ...last, proof: [...last.proof, witnessProof] }] };
}

async function inscribeDoc(p: OrdMockProvider, satoshi: string, headDigest: string, didCel: string) {
  const res = await p.createInscription({
    data: Buffer.from(JSON.stringify(btcoDoc(satoshi, headDigest, didCel))),
    contentType: 'application/did+json',
    targetSatoshi: satoshi,
  });
  return { inscriptionId: res.inscriptionId, txid: res.txid };
}

// Genesis by `a`; returns the shared base log and its derived did:cel.
async function genesis(a: Key, nonce: string) {
  const base = await createEventLog(
    { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-07-13T00:00:00Z', nonce },
    { signer: a.signer, verificationMethod: a.vm }
  );
  return { base, didCel: deriveDidCel(base) };
}

// A controller-signed migrate-to-btco branch onto `sat`, inscribed + witnessed.
async function branch(base: EventLog, a: Key, p: OrdMockProvider, sat: string, didCel: string) {
  let log = await appendEvent(
    base,
    'migrate',
    { sourceDid: didCel, layer: 'btco', network: 'regtest', to: `did:btco:reg:${sat}`, migratedAt: '2026-07-13T00:00:00Z' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  const insc = await inscribeDoc(p, sat, chainDigest(log.events[log.events.length - 1]), didCel);
  log = attachWitness(log, insc, sat);
  return { log, inscriptionId: insc.inscriptionId };
}

// Wrap a provider to stamp per-inscription block heights onto BOTH
// getInscriptionById and getAnchoringsForDidCel (OrdMock hardcodes height 1).
function withHeights(p: OrdMockProvider, heights: Record<string, number>) {
  return {
    getInscriptionById: async (id: string) => {
      const rec = await p.getInscriptionById(id);
      if (!rec) return null;
      return id in heights ? { ...rec, blockHeight: heights[id] } : rec;
    },
    getInscriptionsBySatoshi: (s: string) => p.getInscriptionsBySatoshi(s),
    getAnchoringsForDidCel: async (didCel: string) => {
      const anchorings = await p.getAnchoringsForDidCel!(didCel);
      return anchorings.map((a) => (a.inscriptionId in heights ? { ...a, blockHeight: heights[a.inscriptionId] } : a));
    },
  };
}

const hasCode = (r: { errors: string[] }, code: string) => r.errors.some((e) => e.includes(code));

describe('did:cel uniqueness — first-anchor-wins', () => {
  test('DUPING: two branches of one did:cel on sats X(100) and Y(200); Y-branch → NON_CANONICAL_ANCHOR, X-branch verifies', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-dupe');
    const X = '100000001';
    const Y = '200000002';
    const bx = await branch(base, a, p, X, didCel);
    const by = await branch(base, a, p, Y, didCel);
    const provider = withHeights(p, { [bx.inscriptionId]: 100, [by.inscriptionId]: 200 });

    // Bob holds the Y-branch: X anchored first (block 100) → Y is a dupe.
    const yResult = await verifyEventLog(by.log, { ordinalsProvider: provider });
    expect(yResult.verified).toBe(false);
    expect(hasCode(yResult, 'NON_CANONICAL_ANCHOR')).toBe(true);

    // Alice holds the canonical X-branch → verifies.
    const xResult = await verifyEventLog(bx.log, { ordinalsProvider: provider });
    expect(xResult.errors).toEqual([]);
    expect(xResult.verified).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/cel/did-cel-uniqueness.test.ts`
Expected: FAIL — the Y-branch currently verifies (`yResult.verified === true`, no `NON_CANONICAL_ANCHOR`), because `verifyUniqueness` does not exist yet.

- [ ] **Step 3: Add the `verifyUniqueness` helper**

In `packages/sdk/src/cel/algorithms/verifyEventLog.ts`, immediately after the `verifyHeadFreshness` function (i.e. after its closing brace at line 562, before the `AnchoredSat` interface), insert:

```ts
/**
 * did:cel uniqueness — first-anchor-wins (follow-up to the signed-anchored-sat
 * spec). The canonical sat for a did:cel is the sat of its EARLIEST on-chain
 * anchoring: the lowest confirmed block height, GROUPED BY SAT. Multiple
 * inscriptions on the same sat (migrate + rotation reinscriptions) do not
 * compete — only a different, earlier sat wins. A btco-anchored log whose
 * anchored sat is not that canonical sat is a non-canonical dupe.
 *
 * Fail-closed and NOT opt-in: a btco-anchored did:cel log already requires a
 * provider, so a provider that cannot enumerate, an empty enumeration, or any
 * anchoring missing a confirmed block height → `UNIQUENESS_UNVERIFIABLE`. A
 * same-block tie between two DIFFERENT sats → `AMBIGUOUS_CANONICAL` (no finer
 * on-chain order is exposed by the provider contract today).
 *
 * Returns a coded error string on failure, or null when the anchored sat is
 * canonical.
 */
async function verifyUniqueness(
  didCel: string,
  anchoredSat: AnchoredSat,
  ordinalsProvider: OrdinalsLookup | undefined
): Promise<string | null> {
  if (!ordinalsProvider || typeof ordinalsProvider.getAnchoringsForDidCel !== 'function') {
    return `UNIQUENESS_UNVERIFIABLE: the ordinals provider cannot enumerate anchorings for ${didCel}; a btco-anchored did:cel log requires this to confirm first-anchor-wins canonicality`;
  }

  let anchorings: Array<{ satoshi: string; inscriptionId: string; blockHeight?: number }>;
  try {
    anchorings = await ordinalsProvider.getAnchoringsForDidCel(didCel);
  } catch (e) {
    return `UNIQUENESS_UNVERIFIABLE: failed to enumerate anchorings for ${didCel}: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!Array.isArray(anchorings) || anchorings.length === 0) {
    return `UNIQUENESS_UNVERIFIABLE: no on-chain anchorings found for ${didCel}; cannot confirm the anchored sat ${anchoredSat.satoshi} is canonical`;
  }

  // Every anchoring must carry a confirmed (non-negative integer) block height:
  // the ordering signal must be provable, or canonicality is undecidable.
  for (const a of anchorings) {
    if (typeof a.blockHeight !== 'number' || !Number.isInteger(a.blockHeight) || a.blockHeight < 0) {
      return `UNIQUENESS_UNVERIFIABLE: anchoring ${a.inscriptionId} on satoshi ${a.satoshi} has no confirmed block height; first-anchor-wins ordering is unprovable`;
    }
  }

  // Group by sat; each sat's competitor is its EARLIEST anchoring.
  const earliestBySat = new Map<string, number>();
  for (const a of anchorings) {
    const cur = earliestBySat.get(a.satoshi);
    if (cur === undefined || a.blockHeight! < cur) earliestBySat.set(a.satoshi, a.blockHeight!);
  }

  // Lowest earliest-height across DISTINCT sats is canonical.
  let minHeight = Infinity;
  for (const h of earliestBySat.values()) if (h < minHeight) minHeight = h;
  const canonicalSats = [...earliestBySat.entries()].filter(([, h]) => h === minHeight).map(([s]) => s);

  if (canonicalSats.length > 1) {
    return `AMBIGUOUS_CANONICAL: ${canonicalSats.length} distinct sats (${canonicalSats.join(', ')}) share the earliest block ${minHeight} for ${didCel}; no finer on-chain order is available, so canonicality is undecidable`;
  }

  const canonicalSat = canonicalSats[0];
  if (anchoredSat.satoshi !== canonicalSat) {
    return `NON_CANONICAL_ANCHOR: the log is anchored on satoshi ${anchoredSat.satoshi} for ${didCel}, but the canonical (earliest-anchored) sat is ${canonicalSat}; this is a non-canonical dupe`;
  }

  return null;
}
```

- [ ] **Step 4: Wire `verifyUniqueness` into `verifyEventLog`**

In `packages/sdk/src/cel/algorithms/verifyEventLog.ts`, find the `assetDid` computation block (lines 1391-1396). Immediately AFTER it (before the `expectedDid` block at line ~1398), insert:

```ts
  // did:cel uniqueness — first-anchor-wins (follow-up spec). Runs whenever a
  // did:cel log is btco-anchored (`anchoredSat` set by the walk) and a provider
  // is present. NOT gated on checkHeadFreshness: it is part of the btco
  // verification contract, not an opt-in extra. Skipped on the custom-verifier
  // path (which owns proof semantics and never establishes `anchoredSat`).
  let uniquenessError: string | undefined;
  if (!options?.verifier && anchoredSat && typeof assetDid === 'string' && assetDid.startsWith('did:cel:')) {
    uniquenessError = (await verifyUniqueness(assetDid, anchoredSat, options?.ordinalsProvider)) ?? undefined;
  }
```

- [ ] **Step 5: Fold the uniqueness verdict into the result**

In the same file, in the error-collection block near the end (after the `if (staleLogError) { errors.push(staleLogError); }` at lines 1423-1425), add:

```ts
  if (uniquenessError) {
    errors.push(uniquenessError);
  }
```

Then update the final `verified` expression (line 1428) from:

```ts
    verified: allProofsValid && allChainsValid && !authorityError && !deactivationViolated && !expectedDidError && !staleLogError,
```

to:

```ts
    verified: allProofsValid && allChainsValid && !authorityError && !deactivationViolated && !expectedDidError && !staleLogError && !uniquenessError,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/sdk && bun test tests/unit/cel/did-cel-uniqueness.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/cel/algorithms/verifyEventLog.ts packages/sdk/tests/unit/cel/did-cel-uniqueness.test.ts
git commit --no-verify -m "feat(cel): first-anchor-wins did:cel uniqueness check in verifyEventLog"
```

---

### Task 4: Verifier — remaining uniqueness scenarios

**Files:**
- Modify: `packages/sdk/tests/unit/cel/did-cel-uniqueness.test.ts` (append scenarios; no source change — Task 3 implemented every branch)

**Interfaces:**
- Consumes: the fixtures defined in Task 3 (`makeKey`, `genesis`, `branch`, `withHeights`, `inscribeDoc`, `attachWitness`, `chainDigest`, `hasCode`).

- [ ] **Step 1: Add the rotation-not-a-competitor test**

Append inside the `describe('did:cel uniqueness — first-anchor-wins', ...)` block in `packages/sdk/tests/unit/cel/did-cel-uniqueness.test.ts`:

```ts
  test('ROTATION IS NOT A COMPETITOR: migrate + N reinscriptions on the SAME sat X still verify', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-rot');
    const X = '111000111';
    const bx = await branch(base, a, p, X, didCel);

    // A non-cooperative rotation reinscribes the SAME sat X (a second anchoring
    // for the same did:cel on the same sat — must NOT count as a rival sat).
    const rotated = await appendEvent(
      bx.log,
      'rotateKey',
      { newController: b.didKey, rotatedAt: '2026-07-13T00:00:02Z' },
      { signer: b.signer, verificationMethod: b.vm }
    );
    const rotInsc = await inscribeDoc(p, X, chainDigest(rotated.events[rotated.events.length - 1]), didCel);
    const full = attachWitness(rotated, rotInsc, X);

    // Migrate at block 100, rotation reinscription at block 200 — both on X.
    const provider = withHeights(p, { [bx.inscriptionId]: 100, [rotInsc.inscriptionId]: 200 });
    const result = await verifyEventLog(full, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
  });
```

- [ ] **Step 2: Add the same-block ambiguity test**

Append:

```ts
  test('SAME-BLOCK AMBIGUITY: X and Y both anchored at block 100 → AMBIGUOUS_CANONICAL', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-tie');
    const X = '100000001';
    const Y = '200000002';
    const bx = await branch(base, a, p, X, didCel);
    const by = await branch(base, a, p, Y, didCel);
    const provider = withHeights(p, { [bx.inscriptionId]: 100, [by.inscriptionId]: 100 });

    const result = await verifyEventLog(by.log, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(hasCode(result, 'AMBIGUOUS_CANONICAL')).toBe(true);
  });
```

- [ ] **Step 3: Add the provider-lacking-capability test**

Append:

```ts
  test('PROVIDER POSTURE: btco-anchored log + provider WITHOUT getAnchoringsForDidCel → UNIQUENESS_UNVERIFIABLE', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-noenum');
    const X = '100000001';
    const bx = await branch(base, a, p, X, didCel);

    // Enough to verify the migrate witness (getInscriptionById) but NOT to
    // enumerate anchorings — uniqueness must fail closed.
    const limited = { getInscriptionById: (id: string) => p.getInscriptionById(id) };
    const result = await verifyEventLog(bx.log, { ordinalsProvider: limited });
    expect(result.verified).toBe(false);
    expect(hasCode(result, 'UNIQUENESS_UNVERIFIABLE')).toBe(true);
  });
```

- [ ] **Step 4: Add the missing-blockHeight test**

Append:

```ts
  test('PROVIDER POSTURE: an anchoring missing a blockHeight → UNIQUENESS_UNVERIFIABLE', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-noheight');
    const X = '100000001';
    const bx = await branch(base, a, p, X, didCel);

    // Strip blockHeight from the enumeration only (witness still verifies).
    const provider = {
      getInscriptionById: (id: string) => p.getInscriptionById(id),
      getInscriptionsBySatoshi: (s: string) => p.getInscriptionsBySatoshi(s),
      getAnchoringsForDidCel: async (dc: string) =>
        (await p.getAnchoringsForDidCel!(dc)).map(({ blockHeight: _bh, ...rest }) => rest),
    };
    const result = await verifyEventLog(bx.log, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(hasCode(result, 'UNIQUENESS_UNVERIFIABLE')).toBe(true);
  });
```

- [ ] **Step 5: Run the full uniqueness suite to verify it passes**

Run: `cd packages/sdk && bun test tests/unit/cel/did-cel-uniqueness.test.ts`
Expected: PASS (5 tests total: the Task-3 duping test plus these four).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/tests/unit/cel/did-cel-uniqueness.test.ts
git commit --no-verify -m "test(cel): rotation, same-block, and provider-posture uniqueness scenarios"
```

---

### Task 5: Changeset + full-suite green

**Files:**
- Create: `.changeset/did-cel-uniqueness-first-anchor-wins.md`

- [ ] **Step 1: Add the changeset**

Create `.changeset/did-cel-uniqueness-first-anchor-wins.md`:

```md
---
"@originals/sdk": patch
---

did:cel uniqueness — first-anchor-wins. A btco-anchored did:cel log now verifies
only when its anchored sat is the canonical one (the sat of the log's earliest
on-chain anchoring, lowest confirmed block height grouped by sat), closing the
malicious-controller duping case where one did:cel is signed onto two sats. Adds
the `getAnchoringsForDidCel(didCel)` provider capability (implemented on
OrdMockProvider) and back-links the did:cel in the inscribed btco document's
alsoKnownAs so anchorings are enumerable. Fail-closed: a provider that cannot
enumerate or an anchoring missing a block height → UNIQUENESS_UNVERIFIABLE; a
same-block tie between different sats → AMBIGUOUS_CANONICAL; a non-canonical sat
→ NON_CANONICAL_ANCHOR. Follow-up to the signed-anchored-sat binding.
```

- [ ] **Step 2: Run the CEL + lifecycle + adapters suites**

Run: `cd packages/sdk && bun test tests/unit/cel tests/unit/lifecycle tests/unit/adapters`
Expected: PASS — new tests green, no regressions.

- [ ] **Step 3: Run the full test suite**

Run: `cd packages/sdk && bun test`
Expected: PASS (whole suite green).

- [ ] **Step 4: Commit**

```bash
git add .changeset/did-cel-uniqueness-first-anchor-wins.md
git commit --no-verify -m "chore: changeset for did:cel first-anchor-wins uniqueness"
```

---

## Self-Review

**Spec coverage (against `2026-07-13-did-cel-uniqueness-first-anchor-wins-design.md`):**
- §0/§2 first-anchor-wins rule (earliest block, grouped by sat) → Task 3 `verifyUniqueness` grouping logic; Task 3 duping test + Task 4 rotation test.
- §0/§4 provider posture (required, fail-closed; no basic-provider skip) → Task 3 `UNIQUENESS_UNVERIFIABLE` branches; Task 4 provider-lacking + missing-height tests.
- §0/§7 same-block tie → `AMBIGUOUS_CANONICAL` → Task 3 branch; Task 4 same-block test.
- §3 writer (add `did:cel:<Z>` to `alsoKnownAs`) → Task 2.
- §4 provider capability `getAnchoringsForDidCel` → Task 1 (types + OrdMock impl).
- §5 verifier check placement (peer of head-freshness, provider-triggered, not opt-in) → Task 3 wire-in.
- §6 duping closes (X@100 canonical, Y@200 rejected) → Task 3 duping test.
- §8 testing spine (first-anchor-wins, rotation-not-a-competitor, same-block, provider posture ×2, alsoKnownAs round-trip) → Tasks 2, 3, 4.
- Changeset gate → Task 5.

**Placeholder scan:** every code step contains complete code; every run step states an exact command and expected result. No TBD/TODO.

**Type consistency:** `getAnchoringsForDidCel` signature is identical across `OrdinalsLookup` (cel/types.ts), `OrdinalsProvider` (adapters/types.ts), and the OrdMock impl; `verifyUniqueness(didCel, anchoredSat, ordinalsProvider)` consumes the existing `AnchoredSat` (`{ satoshi, inscriptionId }`) and returns `string | null`, matching the `verifyHeadFreshness` convention it sits beside; the wired `uniquenessError` mirrors the `staleLogError` handling exactly.

**Residuals (documented, not solved here — spec §7/§9):** same-block dupes across different sats fail closed (`AMBIGUOUS_CANONICAL`) rather than being broken by a finer on-chain order; the verdict is only as complete as the provider's content index; legitimate cross-sat re-anchoring is out of scope.
