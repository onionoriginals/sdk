# Phase 2: CEL Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The production lifecycle converges onto the CEL: `createAsset` mints a did:cel genesis, every operation appends a signed event, the inscribed btco document commits to the log's head digest, and `verify()` delegates to `verifyEventLog` — making "an Original asset IS a CEL" true in the shipping path (design spec §4/§7 Phase 2).

**Architecture:** LifecycleManager owns all appends (it holds keyStore + config); the asset carries the log (`celLog` getter + internal swap — `appendEvent` is immutable). A dedicated **Ed25519 controller keypair** is minted per asset at `createAsset` (CEL is Ed25519-only; `defaultKeyType` untouched). `asset.id` becomes the derived did:cel with a minimal synthesized DID document as facade plumbing; `did:cel` maps to the `'did:peer'` layer label (no new LayerType until Phase 4). Provenance/bindings stay write-through caches; a pure `replayProvenance` fold provides load/verify parity. Atomicity per operation: publish = operate-then-append inside the existing rollback; inscribe = **append-first** (the inscribed doc must commit to the post-append head digest); transfer/rotate = operate-then-append, fail loudly with the txid.

**Tech Stack:** TypeScript, Bun, existing CEL subsystem (Phase 1) + lifecycle (Phase 0).

## Global Constraints

- Run tests from `packages/sdk/` with `bun test`. Never import `tests/setup.bun.ts`.
- `.js`-suffixed relative imports in src. `src/cel` uses plain `Error`; `src/lifecycle` uses `StructuredError('CODE', 'message', context?)` — match the file you're in.
- CEL events are **Ed25519/eddsa-jcs-2022 only** — an ES256K key must never sign a CEL event (permanently unverifiable log). The adapter throws `StructuredError('CEL_ED25519_REQUIRED', ...)`.
- Verification stays fail-closed; never weaken an existing check. Legacy CEL suites stay green.
- Never remove existing validation. Preserve public API except where a task explicitly changes it.
- Commit per task, `git commit --no-verify`, conventional message, exact trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch: `worktree-phase2-cel-convergence` (stacked on Phase 1 / PR #385).
- Baseline: 3792 pass / 70 skip / 0 fail; tsc, build clean. `cel-cli-coverage.test.ts` subprocess tests are flaky under load — judge in isolation.
- Anchors below verified on this branch; if drifted, locate by quoted code.
- Layer-label rule (binding, phase-wide): did:cel assets report `currentLayer === 'did:peer'` (genesis-layer synonym). `bindings['did:cel'] = asset.id` replaces the old `bindings['did:peer']` write; tests asserting the old key are updated, not appeased.

---

### Task 1: CEL signer adapter + digest bridge

**Files:**
- Create: `packages/sdk/src/cel/signerAdapter.ts`
- Modify: `packages/sdk/src/cel/index.ts`, `packages/sdk/src/index.ts` (exports)
- Create: `packages/sdk/tests/unit/cel/signerAdapter.test.ts`

**Interfaces:**
- Consumes: `multikey` (`src/crypto/Multikey.ts`), `canonicalizeEvent` (`src/cel/canonicalize.ts:24`), `ed25519` from `@noble/curves/ed25519.js` (mirror `cli/create.ts:142-163`'s exact signing), `KeyStore`/`KeyPair` (`src/types/common.ts:57-60`), `CelSigner` type (from `src/cel/layers/PeerCelManager.ts`).
- Produces (Tasks 3–7 depend on exactly):
  - `celSignerFromKeyPair(keyPair: KeyPair): { signer: CelSigner; controller: string; verificationMethod: string }` — `controller = 'did:key:' + publicKeyMultibase`, `verificationMethod = controller + '#' + publicKeyMultibase`.
  - `createKeyStoreCelSigner(keyStore: KeyStore, verificationMethodId: string): CelSigner` — lazy per-sign lookup (stays rotation-fresh).
  - `hexSha256ToDigestMultibase(hexHash: string): string` — hex sha256 → multibase base64url multihash (`0x12 0x20` prefix; reuse `computeDigestMultibase`'s constants or build from `src/cel/hash.ts`'s multihash prefix + `src/utils/encoding.js` multibase).

- [ ] **Step 1: Failing test**

```typescript
// packages/sdk/tests/unit/cel/signerAdapter.test.ts
import { describe, test, expect } from 'bun:test';
import { celSignerFromKeyPair, createKeyStoreCelSigner, hexSha256ToDigestMultibase } from '../../../src/cel/signerAdapter';
import { KeyManager } from '../../../src/did/KeyManager';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { computeDigestMultibase } from '../../../src/cel/hash';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

describe('CEL signer adapter', () => {
  test('keypair variant produces a log verifyEventLog accepts as did:cel', async () => {
    const km = new KeyManager();
    const kp = await km.generateKeyPair('Ed25519');
    const { signer, controller, verificationMethod } = celSignerFromKeyPair(kp);
    expect(controller.startsWith('did:key:z')).toBe(true);
    expect(verificationMethod).toBe(`${controller}#${controller.slice('did:key:'.length)}`);
    const log = await createEventLog(
      { name: 'A', controller, resources: [], createdAt: '2026-07-10T00:00:00Z', nonce: 'u0001' },
      { signer, verificationMethod }
    );
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(true);
  });

  test('keyStore variant signs identically and reads lazily', async () => {
    const km = new KeyManager();
    const kp = await km.generateKeyPair('Ed25519');
    const { controller, verificationMethod } = celSignerFromKeyPair(kp);
    const store = new Map<string, string>();
    const keyStore = {
      getPrivateKey: async (vm: string) => store.get(vm) ?? null,
      setPrivateKey: async (vm: string, k: string) => { store.set(vm, k); }
    };
    const signer = createKeyStoreCelSigner(keyStore, verificationMethod);
    await expect(signer({ type: 'create', data: {} })).rejects.toThrow(/not found|KEYSTORE/i); // lazy: key absent yet
    await keyStore.setPrivateKey(verificationMethod, kp.privateKey);
    const log = await createEventLog(
      { name: 'B', controller, resources: [], createdAt: 'x', nonce: 'u0002' },
      { signer, verificationMethod }
    );
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('rejects non-Ed25519 keys', async () => {
    const km = new KeyManager();
    const kp = await km.generateKeyPair('ES256K');
    expect(() => celSignerFromKeyPair(kp)).toThrow(/CEL_ED25519_REQUIRED|Ed25519/);
  });

  test('hexSha256ToDigestMultibase matches computeDigestMultibase', () => {
    const bytes = new TextEncoder().encode('hello');
    const hex = bytesToHex(sha256(bytes));
    expect(hexSha256ToDigestMultibase(hex)).toBe(computeDigestMultibase(bytes));
  });
});
```

- [ ] **Step 2: RED** — `bun test tests/unit/cel/signerAdapter.test.ts` → module not found.

- [ ] **Step 3: Implement**

```typescript
// packages/sdk/src/cel/signerAdapter.ts
/**
 * Bridges the SDK's keyStore/KeyManager world (multibase Multikey strings)
 * to CelSigner (eddsa-jcs-2022 DataIntegrityProof over JCS bytes).
 * CEL verification is Ed25519-only end-to-end — non-Ed25519 keys throw.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { multikey } from '../crypto/Multikey.js';
import { canonicalizeEvent } from './canonicalize.js';
import { StructuredError } from '../utils/telemetry.js';
import { multibase } from '../utils/encoding.js';
import type { KeyStore, KeyPair } from '../types/common.js';
import type { DataIntegrityProof } from './types.js';
import type { CelSigner } from './layers/PeerCelManager.js';

const SHA2_256_MULTIHASH_PREFIX = Uint8Array.from([0x12, 0x20]);

function assertEd25519(privateKeyMultibase: string): Uint8Array {
  const decoded = multikey.decodePrivateKey(privateKeyMultibase);
  if (decoded.type !== 'Ed25519') {
    throw new StructuredError('CEL_ED25519_REQUIRED',
      `CEL events must be signed with Ed25519; got ${decoded.type}. Generate a dedicated Ed25519 controller key.`);
  }
  return decoded.key;
}

function buildProof(secret: Uint8Array, verificationMethod: string, data: unknown): Promise<DataIntegrityProof> {
  return ed25519.signAsync(canonicalizeEvent(data), secret).then((sig) => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod,
    proofPurpose: 'assertionMethod',
    proofValue: multikey.encodeMultibase(sig)
  }));
}

export function celSignerFromKeyPair(keyPair: KeyPair): {
  signer: CelSigner; controller: string; verificationMethod: string;
} {
  const secret = assertEd25519(keyPair.privateKey);
  const controller = `did:key:${keyPair.publicKey}`;
  const verificationMethod = `${controller}#${keyPair.publicKey}`;
  return { signer: (data) => buildProof(secret, verificationMethod, data), controller, verificationMethod };
}

/** Lazy per-sign lookup: rotation-fresh, and key absence fails at sign time. */
export function createKeyStoreCelSigner(keyStore: KeyStore, verificationMethodId: string): CelSigner {
  return async (data) => {
    const priv = await keyStore.getPrivateKey(verificationMethodId);
    if (!priv) {
      throw new StructuredError('CEL_SIGNING_KEY_NOT_FOUND',
        `No private key in keyStore for ${verificationMethodId}`);
    }
    return buildProof(assertEd25519(priv), verificationMethodId, data);
  };
}

/** AssetResource.hash (hex sha256) → CEL digestMultibase (multibase multihash). */
export function hexSha256ToDigestMultibase(hexHash: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hexHash)) {
    throw new StructuredError('INVALID_HASH', `Expected 64-char hex sha256, got ${hexHash.length} chars`);
  }
  const bytes = Uint8Array.from(hexHash.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const mh = new Uint8Array(2 + bytes.length);
  mh.set(SHA2_256_MULTIHASH_PREFIX, 0); mh.set(bytes, 2);
  return multibase.encode(mh, 'base64url');
}
```

Verify against actuals before finalizing: (a) `multikey.encodeMultibase` exists with that name (grep `Multikey.ts`; `cli/create.ts:154-161` shows the exact proofValue encoding — mirror it); (b) `KeyPair.publicKey` is the bare multibase string (check `src/types/common.ts`); (c) the `did:key` VM shape matches `cli/create.ts`'s. Adapt mechanically, keep signatures.

Exports in both index files.

- [ ] **Step 4: GREEN** — `bun test tests/unit/cel/signerAdapter.test.ts tests/unit/cel/` all pass.
- [ ] **Step 5: Commit** — `feat(cel): keyStore/KeyPair → CelSigner adapter + hex→digestMultibase bridge`

---

### Task 2: did:cel plumbing prerequisites

**Files:**
- Modify: `packages/sdk/src/utils/validation.ts:20` (`supportedMethods` gains `'cel'`)
- Modify: `packages/sdk/src/lifecycle/OriginalsAsset.ts` `determineCurrentLayer` (~562-567): `did:cel:` → `'did:peer'` (comment: genesis-layer synonym, Phase-4 renames)
- Create: `createCelDidDocument(didCel: string, controllerPublicKeyMultibase: string): DIDDocument` in `packages/sdk/src/cel/celDid.ts` (append to the existing file)
- Modify: `packages/sdk/src/cel/layers/PeerCelManager.ts` (~313-317) + `WebVHCelManager.ts` (~286-290): shapeless genesis (neither `controller` nor `did`) in `getCurrentState` → throw (align with verifier semantics; today they mint a did:cel the verifier refuses to back)
- Modify: `packages/sdk/src/cel/types.ts` (~118-130): advisory JSDoc on `verificationMethod` ("advisory — the recorded VM comes from the signer's proof")
- Test: extend `packages/sdk/tests/unit/cel/celDid.test.ts` + the two manager test files

**Interfaces:**
- Produces: `createCelDidDocument` returning
  `{ '@context': ['https://www.w3.org/ns/did/v1','https://w3id.org/security/multikey/v1'], id: didCel, verificationMethod: [{ id: didCel+'#key-0', type: 'Multikey', controller: didCel, publicKeyMultibase }], authentication: [didCel+'#key-0'], assertionMethod: [didCel+'#key-0'], alsoKnownAs: ['did:key:'+publicKeyMultibase] }` — Task 3 consumes it; `validateDIDDocument` must accept it.

- [ ] **Step 1: Failing tests** — (a) `createCelDidDocument` shape + `validateDIDDocument(doc)` passes (import from wherever `OriginalsAsset.verify` gets it — grep `validateDIDDocument` in `src/utils/validation.ts`); (b) `determineCurrentLayer` on a did:cel doc → `'did:peer'` (construct an `OriginalsAsset` with the synthesized doc and assert `currentLayer`); (c) shapeless genesis → `getCurrentState` throws `/genesis|controller|did/i` in both managers (build the log by hand as existing shapeless tests do — grep `shapeless` in tests/unit/cel first; the verifier tests have the pattern).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** per the file list. `determineCurrentLayer`: add `if (didId.startsWith('did:cel:')) return 'did:peer';` before the throw.
- [ ] **Step 4: GREEN** — `bun test tests/unit/cel/ tests/unit/lifecycle/OriginalsAsset.test.ts tests/unit/utils/`.
- [ ] **Step 5: Commit** — `feat(cel): did:cel DID-document facade + layer mapping; shapeless-genesis fail-closed`

---

### Task 3: `OriginalsAsset.celLog` + createAsset mints did:cel

The convergence keystone — biggest blast radius.

**Files:**
- Modify: `packages/sdk/src/lifecycle/OriginalsAsset.ts` (constructor gains 4th param; `celLog` getter; `/** @internal */ _replaceCelLog`)
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` `createAsset` (~263-317)
- Modify: `packages/sdk/tests/unit/lifecycle/LifecycleManager.test.ts` (canonical `asset.id.startsWith('did:peer:')` at ~:20) + the id-shape assertion set (see blast-radius list below)
- Create: `packages/sdk/tests/unit/lifecycle/LifecycleManager.celgenesis.test.ts`

**Interfaces:**
- Consumes: Task 1's `celSignerFromKeyPair` + `hexSha256ToDigestMultibase`; Task 2's `createCelDidDocument`; `PeerCelManager` (`src/cel/layers/PeerCelManager.ts:139-177`, `create(name, resources) → { log, did }` with `ExternalReference[]`); `deriveDidCel`.
- Produces: `new OriginalsAsset(resources, did, credentials, eventLog?)`; `asset.celLog: EventLog | undefined`; `asset._replaceCelLog(log)`; createAsset yields `asset.id = did:cel:…`, `asset.currentLayer === 'did:peer'`, private key registered under BOTH the did:key VM (CEL signing) and `${didCel}#key-0` (so `signWithKeyStore`'s `${issuer}#key-0` probe at LifecycleManager.ts:~1181 keeps working). Asset name for the genesis: use the first resource's `id` (there is no name param on createAsset — do NOT add one; comment it).

- [ ] **Step 1: Failing test**

```typescript
// packages/sdk/tests/unit/lifecycle/LifecycleManager.celgenesis.test.ts
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { deriveDidCel } from '../../../src/cel/celDid';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';

// Build the SDK WITH a keyStore the way LifecycleManager.keymanagement.test.ts does — copy its setup.
describe('createAsset mints did:cel genesis (#Phase2)', () => {
  test('asset.id is the derived did:cel; log verifies; layer label is did:peer', async () => {
    const sdk = makeSdkWithKeyStore(); // fixture per keymanagement test
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'ab'.repeat(32) }
    ]);
    expect(asset.id.startsWith('did:cel:u')).toBe(true);
    expect(asset.celLog).toBeDefined();
    expect(deriveDidCel(asset.celLog!)).toBe(asset.id);
    expect(asset.currentLayer).toBe('did:peer');
    const result = await verifyEventLog(asset.celLog!, { expectedDid: asset.id });
    expect(result.verified).toBe(true);
    // genesis resource digest matches the AssetResource hash (bridged)
    const genesis = asset.celLog!.events[0].data as { resources: Array<{ digestMultibase: string }> };
    expect(genesis.resources[0].digestMultibase.startsWith('u')).toBe(true);
  });

  test('keyStore holds the controller key under both VM ids', async () => {
    const { sdk, keyStore } = makeSdkWithKeyStoreExposed();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: 'cd'.repeat(32) }
    ]);
    const genesis = asset.celLog!.events[0].data as { controller: string };
    const didKeyVm = `${genesis.controller}#${genesis.controller.slice('did:key:'.length)}`;
    expect(await keyStore.getPrivateKey(didKeyVm)).toBeTruthy();
    expect(await keyStore.getPrivateKey(`${asset.id}#key-0`)).toBeTruthy();
  });
});
```

(Write the two fixtures by copying LifecycleManager.keymanagement.test.ts's SDK+keyStore construction.)

- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement**

`OriginalsAsset`: 4th optional constructor param `eventLog?: EventLog`; store private `#celLog`; `get celLog()` returns it; `_replaceCelLog(log)` swaps (JSDoc `@internal — LifecycleManager owns appends`).

`createAsset` (keep ALL existing validation): after resource validation —
1. `const controllerKp = await this.keyManager.generateKeyPair('Ed25519')` (find how LifecycleManager reaches KeyManager — grep; if it goes through didManager, mirror that path).
2. `const { signer, controller, verificationMethod } = celSignerFromKeyPair(controllerKp)`.
3. Bridge resources: `resources.map(r => ({ digestMultibase: hexSha256ToDigestMultibase(r.hash), ...(r.contentType ? { mediaType: r.contentType } : {}) }))`.
4. `const manager = new PeerCelManager(signer, { verificationMethod }); const { log, did } = await manager.create(resources[0]?.id ?? 'asset', externalRefs);`
5. `const didDoc = createCelDidDocument(did, controllerKp.publicKey);`
6. keyStore registration (when keyStore configured, mirroring the existing block ~265-280): set under `verificationMethod` AND `${did}#key-0`.
7. `new OriginalsAsset(resources, didDoc, [], log)`.
8. The old `createDIDPeer` call is REMOVED from this path. Keep `DIDManager.createDIDPeer` itself (public API; other consumers).

- [ ] **Step 4: Blast-radius sweep** — run full `bun test`; update id-shape assertions in (verified list): `tests/unit/lifecycle/LifecycleManager.test.ts`, `LifecycleManager.cleanapi.test.ts`, `lifecycle-coverage.test.ts`, `LifecycleManager.keymanagement.test.ts`, `tests/security/multi-issue-review-regressions.test.ts`, `tests/integration/DidPeerToWebVhFlow.test.ts`, `CompleteLifecycle.e2e.test.ts`, `tests/unit/utils/MetricsIntegration.test.ts`, `tests/unit/migration/migration-scenarios.test.ts`, `migration-coverage.test.ts` — pattern: `startsWith('did:peer:')` → `startsWith('did:cel:')` where the asset came from `createAsset`; `currentLayer === 'did:peer'` assertions SURVIVE (do not touch); tests that construct `OriginalsAsset` directly from a did:peer doc keep working (constructor unchanged for 3-arg calls). `bindings['did:peer']` reads break in publish tests — Task 4's territory if publish-related; if a failure is purely the binding KEY, note it for Task 4 rather than half-fixing. Expected-red discipline: list any file you leave red for Task 4 with one line why.
- [ ] **Step 5: GREEN** on everything except (possibly) publish-binding tests listed for Task 4. Full-suite failure list in the report.
- [ ] **Step 6: Commit** — `feat(lifecycle): createAsset mints did:cel genesis; asset carries the CEL (#Phase2)`

---

### Task 4: publishToWeb appends the migrate event

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` `publishToWeb` (~584-700)
- Test: extend `packages/sdk/tests/unit/lifecycle/LifecycleManager.mintwebvh.test.ts`; fix binding-key tests left red by Task 3

**Interfaces:**
- Consumes: `appendEvent` (`src/cel/algorithms/appendEvent.ts`), `createKeyStoreCelSigner` (Task 1), `asset.celLog`/`_replaceCelLog` (Task 3). Current controller VM: fold the log — genesis `controller` unless a later valid `rotateKey` (reuse the fold pattern from `PeerCelManager.getCurrentState` ~399-407; extract a tiny `currentControllerVm(log): string` helper in signerAdapter.ts if not trivial inline).
- Produces: after publish, `asset.celLog` ends with `{ type: 'migrate', data: { sourceDid: asset.id, targetDid: migration.did, layer: 'webvh', domain, migratedAt } }` signed by the controller; the CEL hosted as JSONL-sibling `cel.json` at the same storage path as `did.jsonl` (reuse the `hostDIDLog` layout, key `${domain}/{paths}/cel.json`, serialized via `serializeEventLogJson` — grep `src/cel/serialization/json.ts` for the exact export name); `bindings['did:cel'] = asset.id` written alongside `'did:webvh'` (the old `'did:peer'` binding key is retired — update remaining tests).

Atomicity (binding): operate-then-append INSIDE the existing try/rollback — snapshot `const logBefore = asset.celLog` at the top of the try; on catch, `asset._replaceCelLog(logBefore)` alongside `rollbackPartialPublish`. Append after `hostDIDLog` succeeds, BEFORE `asset.migrate('did:webvh')`; host `cel.json` AFTER the append (so the hosted log includes the migrate event).

Order inside the try: mint webvh → persist key → publishResources → append migrate event → hostDIDLog → hostCelLog → asset.migrate → bindings.

Note: keyStore-less SDKs (several unit tests) can't sign — when no keyStore is configured OR the asset has no celLog (3-arg constructed legacy assets), SKIP the append and emit the existing-style degraded event `{ type: 'cel:append-skipped', reason: 'NO_KEYSTORE' | 'NO_CEL_LOG' }` (register the event type in `src/events/types.ts` + `src/utils/EventLogger.ts` like Task 5 of Phase 0 did — warn level). Publish must not hard-require a keyStore in Phase 2 (that flip is Phase 4's fail-fast decision).

- [ ] **Step 1: Failing test** — extend mintwebvh test: after `publishToWeb`, assert last event `type === 'migrate'`, `data.targetDid === bindings['did:webvh']`, `verifyEventLog(asset.celLog, { expectedDid: asset.id }).verified === true`, and storage contains `example.com/{slug}/cel.json` whose parsed content round-trips to the same log (use the storage fixture's getObject as the did.jsonl assertion does). Plus: keyStore-less SDK publish still succeeds and emits `cel:append-skipped`.
- [ ] **Step 2: RED.** **Step 3: Implement** per above. **Step 4: GREEN** incl. binding-key test fixes left from Task 3; full `bun test` — zero non-flaky fails.
- [ ] **Step 5: Commit** — `feat(lifecycle): publishToWeb appends signed migrate event; CEL hosted beside did.jsonl`

---

### Task 5: inscribeOnBitcoin — append-first + head-digest commitment

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` `inscribeOnBitcoin` (~1258-1360)
- Test: extend `packages/sdk/tests/integration/BtcoRoundTrip.test.ts` + `tests/unit/lifecycle/LifecycleManager.inscribe.test.ts`

**Interfaces:**
- Consumes: Tasks 1/3/4 surfaces; `computeDigestMultibase` + `canonicalizeEntryForChain` (head digest = digest of the LAST event of the post-append log — the same expression as chain links).
- Produces: order = (1) append `{ type: 'migrate', data: { sourceDid: <current: bindings['did:webvh'] ?? asset.id>, layer: 'btco', network, migratedAt } }` (match `BtcoMigrationData`, `src/cel/layers/BtcoCelManager.ts:45-72` — NO satoshi/txid in data; they arrive via witness proofs later); (2) compute `headDigestMultibase` over the appended log's last entry; (3) `buildContent(satoshi)` embeds a second service entry `{ id: `${btcoDoc.id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase } }` alongside the existing `#resources`; (4) inscribe; (5) on inscription failure, restore the pre-append log (`_replaceCelLog(logBefore)` — pure in-memory, nothing paid before broadcast fails); keyStore-less/celLog-less degrade exactly as Task 4 (`cel:append-skipped`, and then NO `#cel` service entry — the doc just lacks the anchor).
- `rotateBtcoKeys` (~1584-1594): the rotated document must RE-EMBED the `#cel` service entry (recompute the head digest over the current log INCLUDING a newly-appended `{ type: 'rotateKey', data: { newController, rotatedAt } }` event — append the rotateKey event BEFORE reinscription, same append-first logic, signed by the CURRENT controller per the cooperative-rotation contract; on inscription failure restore). Note in code: non-cooperative rotation acceptance is a Phase-3+ verifier design (post-transfer stale-key window, design §5) — this wires the cooperative path only.

- [ ] **Step 1: Failing tests** — BtcoRoundTrip: after inscribe, resolved doc has `#cel` service whose `headDigestMultibase` equals `computeDigestMultibase(canonicalizeEntryForChain(asset.celLog!.events.at(-1)!))`; last event is `migrate` with `layer: 'btco'`; `verifyEventLog(asset.celLog, { expectedDid: asset.id }).verified` true. rotateBtcoKeys test: after rotation, last event `type === 'rotateKey'`, resolved doc still carries `#cel` (fresh digest) AND `#resources`.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** + full suite. **Step 5: Commit** — `feat(lifecycle): inscribe commits to CEL head digest; rotateKey event on rotation (#365)`

---

### Task 6: transferOwnership appends the transfer event

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` `transferOwnership` (~1440-1520)
- Test: extend `packages/sdk/tests/unit/lifecycle/LifecycleManager.transfer.unit.test.ts`

**Interfaces:**
- Consumes: Tasks 1/3; the tx result from `bm.transferInscription` (~1498).
- Produces: after the sat moves, append `{ type: 'transfer', data: { previousOwner: <current controller did:key>, newOwner: <toAddress>, txid: tx.txid, transferredAt } }` signed by the OUTGOING controller, then `recordTransfer` as today. **Fail loudly**: if the append fails after a successful transfer, throw `StructuredError('CEL_APPEND_FAILED_POST_TRANSFER', msg, { txid })` — never a silent degrade (the sat moved; provenance must not silently truncate). keyStore-less/celLog-less: `cel:append-skipped` degrade IS allowed here only when there was never a log/keyStore to begin with (same guards as Task 4) — the loud path is for real append failures on CEL-carrying assets.

- [ ] **Step 1: Failing test** — after `transferOwnership`, last event `type === 'transfer'`, `data.txid` equals the returned tx id, log verifies with expectedDid. Plus: mock a signer that throws → transfer result already happened → expect `CEL_APPEND_FAILED_POST_TRANSFER` with `context.txid`.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** + full suite. **Step 5: Commit** — `feat(lifecycle): transfer appends signed CEL transfer event, fails loudly with txid`

---

### Task 7: `replayProvenance` fold + cache-parity

**Files:**
- Create: `packages/sdk/src/lifecycle/replayProvenance.ts`
- Test: `packages/sdk/tests/unit/lifecycle/replayProvenance.test.ts`

**Interfaces:**
- Consumes: `EventLog`, Phase-1 event shapes, `deriveDidCel`.
- Produces: `replayProvenance(log: EventLog): { currentLayer: 'did:peer'|'did:webvh'|'did:btco'; bindings: Record<string,string>; migrations: Array<{ from: string; to: string; timestamp: string }>; transfers: Array<{ from: string; to: string; timestamp: string; transactionId?: string }> }` — a PURE fold: genesis → layer `did:peer`, `bindings['did:cel']`; migrate events advance layer + write `bindings['did:webvh']` (targetDid) / `did:btco` derived from `network` + the migrate event's bitcoin-witness satoshi when present (mirror `BtcoCelManager.getCurrentState`'s satoshi-from-witness extraction ~L382); transfer events append to transfers. Phase 3's `loadAsset` consumes this; Phase 2 uses it only for parity tests.
- Parity tests: drive `createAsset → publishToWeb → inscribeOnBitcoin → transferOwnership` (OrdMock + Memory storage + keyStore fixture), then assert `replayProvenance(asset.celLog!)` agrees with the live caches: same `currentLayer`, same webvh/btco binding values, same transfer count/txid. (Known, documented divergence: cache carries commitTxId/feeRate the fold can't recover — assert only the shared fields.)

- [ ] Steps: failing test → RED → implement → GREEN + full suite → Commit `feat(lifecycle): pure replayProvenance fold with live-cache parity tests`

---

### Task 8: verify() delegates to verifyEventLog + resolveDidCel helper

**Files:**
- Modify: `packages/sdk/src/lifecycle/OriginalsAsset.ts` `verify()`/`runVerificationChecks` (~283-354)
- Modify: `packages/sdk/src/cel/celDid.ts` (add `resolveDidCel`)
- Modify: `packages/sdk/src/did/DIDManager.ts` `resolveDID` (~534-537 unsupported-method branch)
- Test: extend `packages/sdk/tests/unit/lifecycle/OriginalsAsset.test.ts` + `tests/unit/cel/celDid.test.ts`

**Interfaces:**
- Consumes: `verifyEventLog` + `createDidManagerKeyResolver` (`src/cel/keyResolver.ts`), `OrdinalsLookup` (`src/cel/types.ts:166-175`), Task 2's `createCelDidDocument`.
- Produces:
  - `verify(deps?)` gains: when `this.celLog` exists, run `verifyEventLog(this.celLog, { expectedDid: this.id, resolveKey: deps?.didManager ? createDidManagerKeyResolver(deps.didManager) : undefined, ordinalsProvider: deps?.ordinalsProvider })` as a GATING first check — `!result.verified` → `verify()` false. Existing checks (DID-doc structure, resource hashes, credentials) stay. Assets without a celLog verify exactly as today (legacy path).
  - `resolveDidCel(did: string, log: EventLog): Promise<DIDDocument | null>` in celDid.ts — `verifyEventLog(log, { expectedDid: did })`; on verified, fold the current controller (genesis controller, updated by valid rotateKeys — reuse the replay from Task 4's helper) and return `createCelDidDocument(did, <controller's publicKeyMultibase>)`; else null.
  - `DIDManager.resolveDID('did:cel:...')`: check the resolution CACHE only; on miss, log a warning naming `resolveDidCel(did, log)` and return null. Honest — no fake network resolution (persistence-backed lookup is Phase 3).
- Sign-off note for tests: `verify()` with a tampered log (mutate an event's data post-hoc) → false; with the intact log → true; a 3-arg legacy asset (no log) keeps its current verify behavior byte-identical.

- [ ] Steps: failing tests → RED → implement → GREEN (`tests/unit/lifecycle/ tests/unit/cel/ tests/unit/did/`) + full suite → Commit `feat(verify): whole-chain CEL verification gates asset verify(); resolveDidCel helper (#367 slice)`

---

### Task 9: End-to-end round-trip + docs

**Files:**
- Create: `packages/sdk/tests/integration/CelConvergence.e2e.test.ts`
- Modify: `CLAUDE.md` (architecture section: CEL is the provenance backbone; lifecycle appends signed events; did:cel genesis)
- Modify: `docs/superpowers/specs/2026-07-10-cel-backbone-did-cel-design.md` (§7: mark Phase 2 delivered; move the two deferred items — persistence-backed did:cel resolution, non-cooperative rotation acceptance — into Phase 3's bullet)

**The e2e is the protocol's promise as one test:**

```typescript
// create → publish → inscribe → transfer → rotate; the log tells the whole story and verifies at every step
const sdk = makeSdkWithKeyStore({ ordinalsProvider: new OrdMockProvider(), storageAdapter: new MemoryStorageAdapter() });
const asset = await sdk.lifecycle.createAsset([{ id: 'art', type: 'image', contentType: 'image/png', hash: realSha256Hex }]);
const didCel = asset.id;
await sdk.lifecycle.publishToWeb(asset, 'example.com');
await sdk.lifecycle.inscribeOnBitcoin(asset);
await sdk.lifecycle.transferOwnership(asset, 'bcrt1qnewowner');
const newKey = /* KeyManager Ed25519 */;
await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey.publicKey });

const log = asset.celLog!;
expect(log.events.map(e => e.type)).toEqual(['create', 'migrate', 'migrate', 'transfer', 'rotateKey']);
expect((await verifyEventLog(log, { expectedDid: didCel, ordinalsProvider: providerAdapter })).verified).toBe(true);
const folded = replayProvenance(log);
expect(folded.currentLayer).toBe('did:btco');
expect(folded.bindings['did:webvh']).toBe(asset.bindings!['did:webvh']);
// the inscribed doc's #cel anchor matches a mid-log digest (the btco migrate entry, not the head after transfer/rotate)
```

(Fill in the fixtures from the earlier tasks' tests; the `#cel` anchor assertion compares against the digest of the log entry that WAS the head at inscription time — index 2.)

- [ ] Steps: write test → run (should pass if Tasks 3–8 landed; failures here are integration bugs — fix in this task) → docs edits → full suite → Commit `test+docs: CEL-convergence end-to-end; architecture docs reflect the backbone`

---

### Task 10: Full-suite verification + final review

- [ ] `bun test` zero non-flaky failures; `bunx tsc --noEmit` clean; changed-files eslint zero net-new errors; `bun run build` clean.
- [ ] Final whole-branch review (fable) over `f5a2a36..HEAD` per subagent-driven-development, with the accumulated Minor roll-up; fix Critical/Important; re-verify.
