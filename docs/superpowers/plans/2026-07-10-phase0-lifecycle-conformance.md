# Phase 0: Lifecycle Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production lifecycle mint what it claims: `inscribeOnBitcoin` inscribes a resolvable `did:btco` DID document (#375), `publishToWeb` mints a real `did:webvh` with a hosted log (#376), ownership primitives land (#366), and permanence claims become honest (#378 words).

**Architecture:** Wire the existing, correct `DIDManager.migrateToDIDWebVH`/`migrateToDIDBTCO` machinery into `LifecycleManager` (do NOT promote `src/migration/`). The `OrdinalsProvider` gains a `buildContent(satoshi)` callback (the btco DID document needs the sat in its `id`, which is only known between commit and reveal) and a `targetSatoshi` option (reinscription for key rotation). This phase is backbone-independent — it precedes the did:cel/CEL convergence phases of `docs/superpowers/specs/2026-07-10-cel-backbone-did-cel-design.md` (§7 Phase 0).

**Tech Stack:** TypeScript, Bun (runtime + test), `didwebvh-ts` (via existing WebVHManager), `@noble/hashes`.

## Global Constraints

- Run tests with `bun test` from `packages/sdk/` (or a single file: `bun test tests/unit/...`). Setup is preloaded via bunfig.toml — never import `setup.bun.ts`.
- Errors: `throw new StructuredError('CODE', 'message', context?)` from `src/utils/telemetry.ts`.
- Keys: multibase Multikey only, never JWK. Noble imports use `.js` suffix (`@noble/hashes/sha2.js`).
- Imports within src use relative paths with `.js` extension (match surrounding files).
- Never remove existing validation. Preserve public API shapes except where a task explicitly changes them.
- Commit after every task with `--no-verify` (husky's commitlint binary is not installed in this checkout); still write conventional-commit messages. End commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Execution happens on a fresh branch off `main` (worktree created at execution time), NOT on `claude/turnkey-auth-hardening-*`.
- The tests listed per task are the known asserters of old behavior; if `bun test` surfaces others, fix them in the same task using the same pattern.

---

### Task 1: `buildContent` + `targetSatoshi` on OrdinalsProvider and OrdMockProvider

The btco DID document must contain `did:btco:<sat>` as its `id`, but today's `createInscription({ data })` only reveals the satoshi in its *result*. Add a deferred-content callback invoked once the sat is pinned, and a `targetSatoshi` param so reinscription (key rotation) can target an existing sat.

**Files:**
- Modify: `packages/sdk/src/adapters/types.ts` (the `createInscription` params, ~line 27)
- Modify: `packages/sdk/src/adapters/providers/OrdMockProvider.ts` (`createInscription`, ~line 57)
- Modify: `packages/sdk/src/adapters/providers/OrdHttpProvider.ts` and `QuickNodeProvider.ts` (guard clauses)
- Create: `packages/sdk/tests/unit/adapters/OrdMockProvider.buildContent.test.ts`

**Interfaces:**
- Consumes: existing `OrdinalsProvider.createInscription`.
- Produces: `createInscription(params: { data?: Buffer; buildContent?: (satoshi: string) => Buffer | Promise<Buffer>; contentType: string; feeRate?: number; targetSatoshi?: string })` — exactly one of `data`/`buildContent` required. Later tasks (2, 3, 9) rely on these exact param names.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sdk/tests/unit/adapters/OrdMockProvider.buildContent.test.ts
import { describe, test, expect } from 'bun:test';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';

describe('OrdMockProvider deferred content', () => {
  test('buildContent receives the satoshi that appears in the result', async () => {
    const provider = new OrdMockProvider();
    let seenSat: string | undefined;
    const result = await provider.createInscription({
      buildContent: (satoshi: string) => {
        seenSat = satoshi;
        return Buffer.from(JSON.stringify({ id: `did:btco:${satoshi}` }));
      },
      contentType: 'application/did+json'
    });
    expect(seenSat).toBe(result.satoshi);
    const stored = await provider.getInscriptionById(result.inscriptionId);
    expect(JSON.parse(stored!.content.toString()).id).toBe(`did:btco:${result.satoshi}`);
  });

  test('targetSatoshi reinscribes on the same sat (appends to sat history)', async () => {
    const provider = new OrdMockProvider();
    const first = await provider.createInscription({
      data: Buffer.from('one'), contentType: 'text/plain'
    });
    const second = await provider.createInscription({
      data: Buffer.from('two'), contentType: 'text/plain', targetSatoshi: first.satoshi
    });
    expect(second.satoshi).toBe(first.satoshi);
    const list = await provider.getInscriptionsBySatoshi(first.satoshi!);
    expect(list.map(i => i.inscriptionId)).toEqual([first.inscriptionId, second.inscriptionId]);
  });

  test('rejects when neither or both of data/buildContent given', async () => {
    const provider = new OrdMockProvider();
    await expect(provider.createInscription({ contentType: 'text/plain' } as never))
      .rejects.toThrow();
    await expect(provider.createInscription({
      data: Buffer.from('x'),
      buildContent: () => Buffer.from('y'),
      contentType: 'text/plain'
    } as never)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/adapters/OrdMockProvider.buildContent.test.ts`
Expected: FAIL (`buildContent` not a known param; `seenSat` undefined / TS error).

- [ ] **Step 3: Update the interface**

In `packages/sdk/src/adapters/types.ts`, replace the `createInscription` params type:

```typescript
  createInscription(params: {
    /** Static content. Provide exactly one of data / buildContent. */
    data?: Buffer;
    /**
     * Deferred content: called with the pinned satoshi between commit and
     * reveal, so content that must embed its own sat (a did:btco DID
     * document) can be constructed. Provide exactly one of data / buildContent.
     */
    buildContent?: (satoshi: string) => Buffer | Promise<Buffer>;
    contentType: string;
    feeRate?: number;
    /** Reinscribe on an existing sat (key rotation / DID update). */
    targetSatoshi?: string;
  }): Promise<{
    // ... keep the existing return type fields unchanged ...
  }>;
```

(Keep the return type exactly as it is today.)

- [ ] **Step 4: Implement in OrdMockProvider**

Replace the body of `createInscription` in `OrdMockProvider.ts`:

```typescript
  async createInscription(params: {
    data?: Buffer;
    buildContent?: (satoshi: string) => Buffer | Promise<Buffer>;
    contentType: string;
    feeRate?: number;
    targetSatoshi?: string;
  }) {
    if ((params.data === undefined) === (params.buildContent === undefined)) {
      throw new Error('createInscription requires exactly one of data or buildContent');
    }
    const inscriptionId = `insc-${Math.random().toString(36).slice(2)}`;
    const txid = `tx-${Math.random().toString(36).slice(2)}`;
    // Pin the sat FIRST (mirrors real commit-phase sat assignment), then let
    // deferred content embed it.
    const satoshi = params.targetSatoshi ?? `${Math.floor(Math.random() * 1e12)}`;
    const content = params.buildContent
      ? Buffer.from(await params.buildContent(satoshi))
      : params.data!;
    const vout = 0;
    const record = {
      inscriptionId,
      content,
      contentType: params.contentType,
      txid,
      vout,
      satoshi,
      blockHeight: 1
    };
    this.state.inscriptionsById.set(inscriptionId, record);
    const list = this.state.inscriptionsBySatoshi.get(satoshi) || [];
    list.push(inscriptionId);
    this.state.inscriptionsBySatoshi.set(satoshi, list);
    return {
      inscriptionId,
      revealTxId: txid,
      commitTxId: undefined,
      satoshi,
      txid,
      vout,
      blockHeight: 1,
      content,
      contentType: params.contentType,
      feeRate: params.feeRate
    };
  }
```

- [ ] **Step 5: Guard the network providers**

At the very top of `createInscription` in BOTH `OrdHttpProvider.ts` and `QuickNodeProvider.ts` (QuickNode's already throws by design — add the guard above its existing throw so the error names the actual gap):

```typescript
    if (params.buildContent || params.targetSatoshi) {
      throw new StructuredError(
        'ORD_PROVIDER_UNSUPPORTED',
        'This provider does not support deferred content (buildContent) or sat-targeted reinscription (targetSatoshi). Build the inscription locally and submit via broadcastTransaction.'
      );
    }
```

Import `StructuredError` from `../../utils/telemetry.js` if not already imported; if the file's existing error style is plain `Error`, match it instead.

- [ ] **Step 6: Run tests**

Run: `cd packages/sdk && bun test tests/unit/adapters/`
Expected: new file PASS; `OrdHttpProvider.not-implemented.test.ts` and `QuickNodeProvider.test.ts` still PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/adapters packages/sdk/tests/unit/adapters/OrdMockProvider.buildContent.test.ts
git commit --no-verify -m "feat(adapters): buildContent + targetSatoshi inscription params

Deferred content lets did:btco documents embed their own sat (#375);
targetSatoshi enables reinscription for key rotation (#366).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `BitcoinManager.inscribeData` accepts deferred content

**Files:**
- Modify: `packages/sdk/src/bitcoin/BitcoinManager.ts` (`inscribeData`, ~line 112)
- Create: `packages/sdk/tests/unit/bitcoin/BitcoinManager.deferred.test.ts`

**Interfaces:**
- Consumes: Task 1's provider params.
- Produces: `inscribeData(data: unknown | ((satoshi: string) => Buffer | Promise<Buffer>), contentType: string, feeRate?: number, options?: { targetSatoshi?: string }): Promise<OrdinalsInscription>` — Tasks 3 and 9 call it with a function / with `targetSatoshi`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sdk/tests/unit/bitcoin/BitcoinManager.deferred.test.ts
import { describe, test, expect } from 'bun:test';
import { BitcoinManager } from '../../../src/bitcoin/BitcoinManager';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';

describe('BitcoinManager.inscribeData deferred content', () => {
  const config = { network: 'regtest', defaultKeyType: 'ES256K', ordinalsProvider: new OrdMockProvider() } as never;

  test('passes a content-builder through to the provider', async () => {
    const bm = new BitcoinManager(config);
    const inscription = await bm.inscribeData(
      (satoshi: string) => Buffer.from(`sat=${satoshi}`),
      'text/plain'
    );
    expect(inscription.satoshi).toBeTruthy();
  });

  test('threads targetSatoshi for reinscription', async () => {
    const bm = new BitcoinManager(config);
    const first = await bm.inscribeData(Buffer.from('v1'), 'text/plain');
    const second = await bm.inscribeData(Buffer.from('v2'), 'text/plain', undefined, {
      targetSatoshi: first.satoshi
    });
    expect(second.satoshi).toBe(first.satoshi);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/bitcoin/BitcoinManager.deferred.test.ts`
Expected: FAIL — first test throws `INVALID_INPUT`-adjacent behavior or provider receives a function as `data`; second test: `options` param not accepted.

- [ ] **Step 3: Implement**

In `BitcoinManager.inscribeData`:

1. Change the signature to
   `async inscribeData(data: any, contentType: string, feeRate?: number, options?: { targetSatoshi?: string }): Promise<OrdinalsInscription>`.
2. The `if (!data)` validation stays (a function is truthy).
3. Replace the provider call
   `const creation = await this.ord.createInscription({ data, contentType, feeRate: effectiveFeeRate });`
   with:

```typescript
    const creation = typeof data === 'function'
      ? await this.ord.createInscription({
          buildContent: data as (satoshi: string) => Buffer | Promise<Buffer>,
          contentType,
          feeRate: effectiveFeeRate,
          ...(options?.targetSatoshi ? { targetSatoshi: options.targetSatoshi } : {})
        })
      : await this.ord.createInscription({
          data,
          contentType,
          feeRate: effectiveFeeRate,
          ...(options?.targetSatoshi ? { targetSatoshi: options.targetSatoshi } : {})
        });
```

- [ ] **Step 4: Run tests**

Run: `cd packages/sdk && bun test tests/unit/bitcoin/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/bitcoin/BitcoinManager.ts packages/sdk/tests/unit/bitcoin/BitcoinManager.deferred.test.ts
git commit --no-verify -m "feat(bitcoin): inscribeData accepts deferred content and targetSatoshi

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `inscribeOnBitcoin` inscribes the btco DID document (#375)

Replace the bare JSON manifest with a real `application/did+json` DID document (id `did:btco:<net>:<sat>`), carrying the asset's key, `alsoKnownAs` back-links, and the resource manifest as a service entry. Round-trip must resolve through the SDK's own resolver.

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` (`inscribeOnBitcoin`, ~lines 1109–1155)
- Modify: `packages/sdk/tests/unit/lifecycle/LifecycleManager.inscribe.test.ts` (payload assertions)
- Modify: `packages/sdk/tests/unit/lifecycle/LifecycleManager.prov.test.ts` (if it asserts manifest content)
- Create: `packages/sdk/tests/integration/BtcoRoundTrip.test.ts`

**Interfaces:**
- Consumes: `BitcoinManager.inscribeData(fn, 'application/did+json', feeRate)` (Task 2); `this.didManager.migrateToDIDBTCO(didDoc, satoshi): Promise<DIDDocument>` (exists, `src/did/DIDManager.ts:314`).
- Produces: inscription content = btco DID document with `id === bindings['did:btco']`, `alsoKnownAs: [peerDid, webvhDid?]`, and `service: [{ id: '<btcoDid>#resources', type: 'OriginalsResourceManifest', serviceEndpoint: { resources: [...], timestamp } }]`. `asset.bindings['did:btco']` is now set from the inscribed document's `id` (single source of truth for the network prefix).

- [ ] **Step 1: Write the failing round-trip test**

```typescript
// packages/sdk/tests/integration/BtcoRoundTrip.test.ts
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';

describe('did:btco round-trip (#375)', () => {
  test('lifecycle-inscribed asset resolves through the SDK resolver', async () => {
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'ES256K',
      ordinalsProvider: new OrdMockProvider()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'ab'.repeat(32), content: 'hello' }
    ]);
    const peerDid = asset.id;

    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings?.['did:btco'];
    expect(btcoDid).toMatch(/^did:btco:reg:\d+$/);

    // The SDK's own resolver must accept its own inscription.
    const doc = await sdk.did.resolveDID(btcoDid!);
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe(btcoDid!);
    expect(doc!.alsoKnownAs).toContain(peerDid);
    const svc = (doc!.service || []).find(s => s.type === 'OriginalsResourceManifest');
    expect(svc).toBeDefined();
    const endpoint = svc!.serviceEndpoint as { resources: Array<{ id: string; hash: string }> };
    expect(endpoint.resources[0].hash).toBe('ab'.repeat(32));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/integration/BtcoRoundTrip.test.ts`
Expected: FAIL — `resolveDID` returns `null` (inscription is a manifest, not a DID document).

- [ ] **Step 3: Implement**

In `inscribeOnBitcoin`, replace the manifest/payload/inscribe block (from `const manifest = {` through the `bitcoinManager.inscribeData(payload, 'application/json', feeRate)` call) with:

```typescript
    const bitcoinManager = this.deps?.bitcoinManager ?? new BitcoinManager(this.config);

    // Resource manifest rides INSIDE the DID document as a service entry —
    // the inscription itself must be the DID document (application/did+json)
    // or the SDK's own BtcoDidResolver rejects it (#375).
    const manifestEndpoint = {
      resources: asset.resources.map(res => ({ id: res.id, hash: res.hash, contentType: res.contentType, url: res.url })),
      timestamp: new Date().toISOString()
    };
    const backLinks = [asset.id, asset.bindings?.['did:webvh']].filter(
      (d): d is string => typeof d === 'string'
    );

    const inscription = await bitcoinManager.inscribeData(
      async (satoshi: string) => {
        const btcoDoc = await this.didManager.migrateToDIDBTCO(asset.did, satoshi);
        btcoDoc.alsoKnownAs = backLinks;
        btcoDoc.service = [
          ...(btcoDoc.service || []),
          {
            id: `${btcoDoc.id}#resources`,
            type: 'OriginalsResourceManifest',
            serviceEndpoint: manifestEndpoint
          }
        ];
        return Buffer.from(JSON.stringify(btcoDoc));
      },
      'application/did+json',
      feeRate
    ) as {
      revealTxId?: string;
      txid: string;
      commitTxId?: string;
      inscriptionId: string;
      satoshi?: string;
      feeRate?: number;
      content?: Buffer;
    };
```

Then replace the binding derivation. Delete the `btcoDidPrefix(...)`-based `bindingValue` lines and derive from the inscribed document (removes the config.network-vs-webvhNetwork prefix drift):

```typescript
    // Single source of truth: the binding IS the inscribed document's id.
    const inscribedDoc = inscription.content
      ? JSON.parse(inscription.content.toString()) as { id: string }
      : undefined;
    const bindingValue = inscribedDoc?.id
      ?? `${btcoDidPrefix(this.config.network || 'mainnet')}:${inscription.satoshi}`;
    asset.bindings = Object.assign({}, asset.bindings || {}, { 'did:btco': bindingValue });
```

(Keep the `ORD_SATOSHI_UNKNOWN` check and `asset.migrate(...)` call unchanged, in their current order — satoshi check BEFORE migrate.)

Notes:
- `migrateToDIDBTCO` keeps its own network resolution (explicit `network` wins over `webvhNetwork` mapping) — the binding now inherits that automatically.
- `asset.did` may be keyless — `migrateToDIDBTCO` already handles that (minimal keyless document, issue #318 behavior preserved).

- [ ] **Step 4: Update tests asserting the old manifest payload**

In `tests/unit/lifecycle/LifecycleManager.inscribe.test.ts` (~lines 73–74) and `LifecycleManager.prov.test.ts`: assertions that parse the inscribed payload and expect `{ assetId, resources, timestamp }` must now expect a DID document:

```typescript
    const parsed = JSON.parse(payload.toString());
    expect(parsed.id).toMatch(/^did:btco:/);
    const manifest = parsed.service.find((s: { type: string }) => s.type === 'OriginalsResourceManifest');
    expect(manifest.serviceEndpoint.resources.length).toBeGreaterThan(0);
```

Assertions on `bindings['did:btco']` shape (`did:btco:reg:123` etc.) remain valid.

- [ ] **Step 5: Run tests**

Run: `cd packages/sdk && bun test tests/integration/BtcoRoundTrip.test.ts tests/unit/lifecycle/`
Expected: PASS. Then full sweep: `bun test` — fix any other test parsing the old manifest with the Step-4 pattern.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/lifecycle/LifecycleManager.ts packages/sdk/tests
git commit --no-verify -m "feat(lifecycle): inscribe real did:btco DID document (#375)

The inscription is now application/did+json with the resource manifest
as a service entry; the SDK's own BtcoDidResolver round-trips it.
Binding derives from the inscribed document id.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `publishToWeb` mints the asset's own did:webvh (#376, core)

The asset gets its own `did:webvh:{SCID}:{domain}:{slug}` via the existing `DIDManager.migrateToDIDWebVH`; the publisher argument degrades to (domain + signing authority). The fabricated `did:webvh:{domain}:user` asset-binding disappears.

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` (`publishToWeb` ~566–647; `publishResources` ~795–871)
- Create: `packages/sdk/tests/unit/lifecycle/LifecycleManager.mintwebvh.test.ts`

**Interfaces:**
- Consumes: `this.didManager.migrateToDIDWebVH(didDoc, domain?, options?): Promise<MigrateToWebVHResult>` where the result is `{ did, didDocument, log, keyPair?, previousDid }` (`src/did/DIDManager.ts:198`, result type ~`:722`).
- Produces: `asset.bindings['did:webvh']` = the minted SCID'd DID; `asset.webvhMigration` is NOT added — instead Task 5 consumes a new private field `this.lastWebVHLogByAsset` is NOT added either. The migration result is passed to Task 5's `hostDIDLog` inline within `publishToWeb`. `publishToWeb`'s public signature is unchanged: `(asset, publisherDidOrSigner: string | ExternalSigner, options?)` — a bare domain string now means "host at this domain"; a `did:webvh:...` string means "reuse this DID's domain"; an ExternalSigner signs the new log.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sdk/tests/unit/lifecycle/LifecycleManager.mintwebvh.test.ts
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';

describe('publishToWeb mints a real did:webvh (#376)', () => {
  test('binding is a SCID DID owned by the asset, not the publisher shorthand', async () => {
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'ES256K',
      storageAdapter: new MemoryStorageAdapter()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'cd'.repeat(32), content: 'hi' }
    ]);
    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const binding = published.bindings?.['did:webvh'];
    // Real shape: did:webvh:{SCID}:{domain}[:slug] — SCID segment present, no ":user" fabrication.
    expect(binding).toMatch(/^did:webvh:[^:]+:example\.com(:.+)?$/);
    expect(binding).not.toBe('did:webvh:example.com:user');
    expect(published.bindings?.['did:peer']).toBe(asset.id);
  });
});
```

Note: if `MemoryStorageAdapter` lives elsewhere, locate with `grep -rn "class MemoryStorageAdapter" packages/sdk/src/storage/` and fix the import.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/LifecycleManager.mintwebvh.test.ts`
Expected: FAIL — binding equals `did:webvh:example.com:user`.

- [ ] **Step 3: Implement the minting**

In `publishToWeb`, replace the block from `const { publisherDid, signer } = this.extractPublisherInfo(...)` down through the `asset.bindings = ...` assignment (inside the `try`) with:

```typescript
      const { publisherDid, signer } = this.extractPublisherInfo(publisherDidOrSigner);
      const { domain, userPath } = this.parseWebVHDid(publisherDid);

      this.logger.info('Publishing asset to web', { assetId: asset.id, domain });

      const atomicRollback = options?.atomicRollback !== false;
      const urlSnapshots = asset.resources.map((resource: { url?: string }) => ({
        resource,
        url: resource.url
      }));
      const writtenObjects: Array<{ domain: string; relativePath: string }> = [];

      try {
        // Mint the asset's OWN did:webvh — genuine SCID, signed genesis log,
        // alsoKnownAs back-link to the peer DID (#376). The publisher argument
        // contributes the domain and (optionally) the log-signing authority.
        const migration = await this.didManager.migrateToDIDWebVH(
          asset.did,
          domain,
          signer ? { externalSigner: signer } : {}
        );

        // Persist the update key so the minted DID stays updatable. Without a
        // keyStore the DID still exists but cannot be rotated later — surface
        // that instead of silently dropping the key.
        const keyStore = this.deps?.keyStore;
        const newVmId = migration.didDocument.verificationMethod?.[0]?.id;
        if (migration.keyPair && keyStore && newVmId) {
          await keyStore.setPrivateKey(newVmId, migration.keyPair.privateKey);
        } else if (migration.keyPair && !keyStore) {
          await this.eventEmitter.emit({
            type: 'key:unpersisted',
            timestamp: new Date().toISOString(),
            asset: { id: asset.id },
            did: migration.did
          } as never);
        }

        // Host resources under the MINTED DID (urls now belong to the asset).
        await this.publishResources(asset, migration.did, domain, userPath, writtenObjects);

        // Host the signed DID log so the DID actually resolves (Task 5 helper).
        await this.hostDIDLog(migration.did, migration.log, writtenObjects);

        const originalPeerDid = asset.id;
        await asset.migrate('did:webvh');
        asset.bindings = {
          ...(asset.bindings || {}),
          'did:peer': originalPeerDid,
          'did:webvh': migration.did
        };
      } catch (publishError) {
        if (atomicRollback) {
          await this.rollbackPartialPublish(asset, urlSnapshots, writtenObjects);
        }
        throw publishError;
      }

      // Issue publication credential (Task 6 changes the issuer).
      await this.issuePublicationCredential(asset, asset.bindings['did:webvh']!, signer);
```

Until Task 5 lands, add a temporary no-op so this task compiles standalone:

```typescript
  private async hostDIDLog(
    _did: string,
    _log: unknown,
    _writtenObjects?: Array<{ domain: string; relativePath: string }>
  ): Promise<void> {
    // Implemented in the next task (storage-hosted did.jsonl).
  }
```

Check the keyStore accessor first: `grep -n "keyStore" packages/sdk/src/lifecycle/LifecycleManager.ts | head` — reuse however `signWithKeyStore` obtains it (`this.deps?.keyStore` vs a config field) and match its `setPrivateKey` signature (see how `createAsset` ~L262–270 registers the peer key; use the identical call shape).

- [ ] **Step 4: Keep `extractPublisherInfo` but stop leaking the shorthand**

No change to `extractPublisherInfo` itself (its `did:webvh:{domain}:user` output is now only ever used to carry the domain into `parseWebVHDid` and is never stored on the asset). Add one comment above it:

```typescript
  // NOTE: the fabricated did:webvh:{domain}:user shorthand never leaves this
  // class anymore — it is parsed for its domain only. The asset's real
  // did:webvh is minted in publishToWeb via DIDManager.migrateToDIDWebVH (#376).
```

- [ ] **Step 5: Run the new test, then the suite**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/LifecycleManager.mintwebvh.test.ts`
Expected: PASS.
Run: `bun test tests/unit/lifecycle tests/integration 2>&1 | tail -30`
Expected: FAILURES in tests asserting old behavior — fixed in Task 7 (do not fix here unless the failure is a bug in this task's code; the ones to expect are listed in Task 7).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/lifecycle/LifecycleManager.ts packages/sdk/tests/unit/lifecycle/LifecycleManager.mintwebvh.test.ts
git commit --no-verify -m "feat(lifecycle): publishToWeb mints the asset's own did:webvh (#376)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Host the DID log through the StorageAdapter

`WebVHManager.saveDIDLog` is fs-only; publication hosts via `config.storageAdapter`. Store the JSONL where the did:webvh resolution URL expects it.

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` (fill in `hostDIDLog`)
- Test: extend `packages/sdk/tests/unit/lifecycle/LifecycleManager.mintwebvh.test.ts`

**Interfaces:**
- Consumes: `MigrateToWebVHResult.log` (array of log entries), storage adapter `put(key, data, { contentType })` / `putObject(domain, path, bytes)` duck-typing exactly as `publishResources` does.
- Produces: storage object at key `${domain}/{...didPaths}/did.jsonl` (path form) or `${domain}/.well-known/did.jsonl` (no-path form) — one JSON object per line. Mirrors `WebVHManager.saveDIDLog`'s URL layout (`src/did/WebVHManager.ts:568-636`) minus the fs `did/` prefix.

- [ ] **Step 1: Write the failing test (add to the Task 4 file)**

```typescript
  test('hosts the signed DID log as JSONL in storage at the resolution path', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'ES256K',
      storageAdapter: storage
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'ef'.repeat(32), content: 'log me' }
    ]);
    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const did = published.bindings!['did:webvh']!;
    // did:webvh:{SCID}:example.com[:slug...] -> example.com/{slug...}/did.jsonl
    const paths = did.split(':').slice(4);
    const key = paths.length
      ? `example.com/${paths.join('/')}/did.jsonl`
      : 'example.com/.well-known/did.jsonl';
    const stored = await storage.get(key);
    expect(stored).not.toBeNull();
    const lines = stored!.content.toString().trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // Every line is valid JSON and the log is signed (has a proof).
    const first = JSON.parse(lines[0]);
    expect(first.proof ?? first.parameters).toBeDefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/LifecycleManager.mintwebvh.test.ts`
Expected: FAIL — `stored` is null (hostDIDLog is a no-op).

- [ ] **Step 3: Implement `hostDIDLog`**

Replace the Task-4 stub:

```typescript
  /**
   * Hosts the signed did:webvh log as JSONL through the storage adapter,
   * mirroring the resolution-URL layout WebVHManager.saveDIDLog uses on the
   * filesystem: did:webvh:{SCID}:{domain}:p1:p2 -> {domain}/p1/p2/did.jsonl,
   * no-path DIDs -> {domain}/.well-known/did.jsonl. No storage adapter is a
   * degraded (but allowed) mode: the DID exists and the signed log is
   * returned to the caller, but nothing hosts it — surfaced via event.
   */
  private async hostDIDLog(
    did: string,
    log: unknown,
    writtenObjects?: Array<{ domain: string; relativePath: string }>
  ): Promise<void> {
    const parts = did.split(':');
    if (parts.length < 4 || parts[0] !== 'did' || parts[1] !== 'webvh') {
      throw new StructuredError('INVALID_DID', `Cannot host log for non-webvh DID: ${did}`);
    }
    const domain = decodeURIComponent(parts[3]);
    const pathParts = parts.slice(4);
    const relativePath = pathParts.length
      ? `${pathParts.join('/')}/did.jsonl`
      : `.well-known/did.jsonl`;

    const entries = Array.isArray(log) ? log : [];
    const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');

    const storage = (this.config as { storageAdapter?: unknown }).storageAdapter;
    const withPut = storage as { put?: (key: string, data: Buffer, options: { contentType: string }) => Promise<unknown> } | undefined;
    const withPutObject = storage as { putObject?: (domain: string, path: string, data: Uint8Array) => Promise<unknown> } | undefined;

    if (withPut && typeof withPut.put === 'function') {
      await withPut.put(`${domain}/${relativePath}`, Buffer.from(jsonl), { contentType: 'application/jsonl' });
      writtenObjects?.push({ domain, relativePath });
    } else if (withPutObject && typeof withPutObject.putObject === 'function') {
      await withPutObject.putObject(domain, relativePath, new TextEncoder().encode(jsonl));
      writtenObjects?.push({ domain, relativePath });
    } else {
      await this.eventEmitter.emit({
        type: 'did:log-unhosted',
        timestamp: new Date().toISOString(),
        did,
        reason: 'NO_STORAGE_ADAPTER'
      } as never);
    }
  }
```

If the event emitter's type union rejects the new event types (`key:unpersisted`, `did:log-unhosted`), add them to `packages/sdk/src/events/types.ts` following the existing event-shape pattern there (type name, `timestamp`, payload fields as above) — golden event-contract tests may require an entry; run them and follow their error messages.

- [ ] **Step 4: Run tests**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/LifecycleManager.mintwebvh.test.ts tests/unit/events/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/lifecycle/LifecycleManager.ts packages/sdk/src/events packages/sdk/tests
git commit --no-verify -m "feat(lifecycle): host signed did:webvh log via StorageAdapter (#376)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Publication credential signed by the asset's peer key (#365 slice)

Today the credential is publisher-self-asserted (`issuer = publisherDid`) and the publisher DID never even existed. The cross-layer claim must be countersigned by the **previous layer's key** — the asset's peer key, registered in the keyStore at `createAsset`.

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` (`issuePublicationCredential`, ~903–964)
- Create: `packages/sdk/tests/unit/lifecycle/LifecycleManager.migrationcredential.test.ts`

**Interfaces:**
- Consumes: `this.signWithKeyStore(unsigned, did)` (exists, ~L966) — signs with the key registered for `did`'s verification method; `asset.id` (peer DID) whose key `createAsset` registers when a keyStore is configured.
- Produces: credential with `issuer = <peer DID>`, `credentialSubject = { id: peerDid, migratedTo: webvhDid, resourceId, fromLayer: 'did:peer', toLayer: 'did:webvh', migratedAt }`. External signers still supported (signer signs INSTEAD only when the caller passed one and the keyStore lacks the peer key).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sdk/tests/unit/lifecycle/LifecycleManager.migrationcredential.test.ts
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';

describe('publication credential is signed by the asset peer key (#365)', () => {
  test('issuer is the peer DID and subject records migratedTo', async () => {
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      storageAdapter: new MemoryStorageAdapter()
    });
    // NOTE: if OriginalsSDK.create does not wire a keyStore by default, build
    // the SDK the same way tests/unit/lifecycle/LifecycleManager.keymanagement.test.ts
    // does (it configures a keyStore) and reuse that setup here.
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: '12'.repeat(32), content: 'x' }
    ]);
    const peerDid = asset.id;
    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const cred = published.credentials.find(c => (c.type as string[]).includes('ResourceMigrated'));
    expect(cred).toBeDefined();
    const issuer = typeof cred!.issuer === 'string' ? cred!.issuer : cred!.issuer.id;
    expect(issuer).toBe(peerDid);
    const subject = cred!.credentialSubject as { id: string; migratedTo?: string };
    expect(subject.id).toBe(peerDid);
    expect(subject.migratedTo).toBe(published.bindings!['did:webvh']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/LifecycleManager.migrationcredential.test.ts`
Expected: FAIL — issuer is the webvh DID (or the credential is skipped).

- [ ] **Step 3: Implement**

In `issuePublicationCredential`, the second parameter is now the minted webvh DID (Task 4 passes `asset.bindings['did:webvh']`). Rename the param to `migratedTo` and change subject/issuer:

```typescript
  private async issuePublicationCredential(
    asset: OriginalsAsset,
    migratedTo: string,
    signer?: ExternalSigner
  ): Promise<void> {
    try {
      if (!asset.resources.length || !asset.resources[0].id) {
        throw new StructuredError(
          'EMPTY_RESOURCE_LIST',
          'Cannot issue publication credential: asset has no resources'
        );
      }

      // The cross-layer claim is countersigned by the PREVIOUS layer's key:
      // issuer = the asset's peer DID (its key was registered in the keyStore
      // at createAsset). A publisher-self-asserted credential proves nothing
      // about the asset (#365).
      const subject = {
        id: asset.id,
        migratedTo,
        resourceId: asset.resources[0].id,
        fromLayer: 'did:peer' as const,
        toLayer: 'did:webvh' as const,
        migratedAt: new Date().toISOString()
      };

      const unsigned = this.credentialManager.createResourceCredential(
        'ResourceMigrated',
        subject,
        asset.id
      );

      let signed;
      try {
        signed = await this.signWithKeyStore(unsigned, asset.id);
      } catch (keyStoreErr) {
        if (signer) {
          // Fallback: external signer attests the publication when the peer
          // key is unavailable (issuer becomes the signer's DID — recorded
          // truthfully rather than pretending the peer key signed).
          const vmDid = signer.getVerificationMethodId().split('#')[0];
          const resigned = this.credentialManager.createResourceCredential('ResourceMigrated', subject, vmDid);
          signed = await this.credentialManager.signCredentialWithExternalSigner(resigned, signer);
        } else {
          throw keyStoreErr;
        }
      }

      asset.credentials.push(signed);
      // ... keep the existing credential:issued event emission unchanged ...
```

Keep the outer `catch` (credential:skipped path) exactly as-is: issuance remains best-effort in Phase 0; fail-fast lands with the CEL convergence (Phase 2), where the signed event is mandatory.

- [ ] **Step 4: Run tests**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/LifecycleManager.migrationcredential.test.ts tests/unit/lifecycle/LifecycleManager.keymanagement.test.ts`
Expected: PASS (keymanagement tests may assert the old issuer — update them to expect the peer DID with the same pattern as Step 1).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/lifecycle/LifecycleManager.ts packages/sdk/tests
git commit --no-verify -m "feat(lifecycle): peer-key-signed migration credential with migratedTo (#365)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Update tests asserting the pre-#376 webvh behavior

Known asserters of the fabricated-publisher model. Fix them to the new contract; each fix follows one of two patterns — (a) binding/DID-shape regex gains the SCID segment, (b) "resolves to null" flips to a positive assertion or a storage assertion.

**Files (all Modify):**
- `packages/sdk/tests/integration/WebVhPublish.test.ts` — L30 `webBinding === publisherDid` → expect `webBinding` to match `/^did:webvh:[^:]+:.+/` and NOT equal the publisher shorthand; L34–35 currently asserts the binding resolves to `null` — remove that assertion (resolution requires HTTP hosting; the storage-hosted log is asserted in Task 5's unit test); L41 `r.url.startsWith(publisherDid)` → `r.url.startsWith(webBinding)`.
- `packages/sdk/tests/integration/DidPeerToWebVhFlow.test.ts` — L87 regex `^did:webvh:${domain}:` → `^did:webvh:[^:]+:${domain}`; same change at L236–247 and L341–343 where the binding shape is asserted.
- `packages/sdk/tests/integration/CompleteLifecycle.e2e.test.ts` — L171 same regex fix; L166/L217 (`id` stability) remain untouched — they must still pass; L208–209 credential fields: issuer expectation becomes the peer DID (Task 6), subject gains `migratedTo`; L222–223 & L569–590 binding-preservation assertions: the webvh binding value is now the minted DID (assert shape, not equality with publisher input).
- `packages/sdk/tests/unit/lifecycle/LifecycleManager.test.ts` — L28 `bindings['did:webvh']` contains `'example.com'` still passes (domain is inside the minted DID) — verify, adjust regex if it asserted a prefix.
- `packages/sdk/tests/unit/lifecycle/LifecycleManager.cleanapi.test.ts` L66, `publish-domain-validation.test.ts` L68/L79 — same shape fixes.
- `packages/sdk/tests/integration/Events.test.ts` — `resource:published` payload `publisherDid` is now the minted asset DID; update equality assertions to shape assertions.
- `packages/sdk/tests/unit/lifecycle/BatchOperations.test.ts`, `tests/stress/batch-operations-stress.test.ts`, `tests/security/multi-issue-review-regressions.test.ts` — run them; apply the same two patterns wherever they assert publisher-DID bindings.

**Interfaces:** none new — this task converges the suite on Tasks 4–6's contract.

- [ ] **Step 1: Run the full suite and collect failures**

Run: `cd packages/sdk && bun test 2>&1 | grep -E "(fail)" | head -40`

- [ ] **Step 2: Fix each listed file with the two patterns above**

Binding shape (pattern a):

```typescript
expect(binding).toMatch(/^did:webvh:[^:]+:example\.com(:.+)?$/);
```

Resolution-negative removals (pattern b): delete `expect(await sdk.did.resolveDID(binding)).toBeNull()`-style assertions and replace with a comment: `// Binding resolution over HTTP requires hosting; the storage-hosted log is asserted in LifecycleManager.mintwebvh.test.ts`.

- [ ] **Step 3: Run the full suite**

Run: `cd packages/sdk && bun test`
Expected: PASS (all).

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/tests
git commit --no-verify -m "test: converge suite on minted did:webvh contract (#376)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `getSatOwnership` + ownership resolution metadata (#366a)

Ownership is derived from sat state and reported as **resolution metadata** — the inscribed document stays byte-authoritative (never synthesize `controller` from an indexer).

**Files:**
- Modify: `packages/sdk/src/adapters/types.ts` (add optional method)
- Modify: `packages/sdk/src/adapters/providers/OrdMockProvider.ts` (track owner per sat)
- Modify: `packages/sdk/src/did/BtcoDidResolver.ts` (populate metadata; extend its provider-like interface, ~lines 36–40)
- Modify: wherever `DIDManager.resolveDID` adapts `config.ordinalsProvider` for the resolver — find with `grep -n "BtcoDidResolver\|OrdinalsClientProviderAdapter" packages/sdk/src/did/DIDManager.ts` and pass the method through the adapter (see `tests/unit/did/OrdinalsClientProviderAdapter.test.ts` for the adapter's contract)
- Create: `packages/sdk/tests/unit/did/BtcoDidResolver.ownership.test.ts`

**Interfaces:**
- Consumes: Task 1's provider changes (OrdMock only).
- Produces: `OrdinalsProvider.getSatOwnership?(satoshi: string): Promise<{ address: string; outpoint: string } | null>`; resolver result gains `didDocumentMetadata.ownership: { address: string; outpoint: string }` when the provider supports the lookup. Task 9 consumes `getSatOwnership` via BitcoinManager.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sdk/tests/unit/did/BtcoDidResolver.ownership.test.ts
import { describe, test, expect } from 'bun:test';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';

describe('sat ownership (#366)', () => {
  test('OrdMockProvider tracks owner across transfers', async () => {
    const provider = new OrdMockProvider();
    const insc = await provider.createInscription({ data: Buffer.from('x'), contentType: 'text/plain' });
    const before = await provider.getSatOwnership!(insc.satoshi!);
    expect(before).not.toBeNull();
    await provider.transferInscription(insc.inscriptionId, 'bcrt1qnewowner');
    const after = await provider.getSatOwnership!(insc.satoshi!);
    expect(after!.address).toBe('bcrt1qnewowner');
    expect(after!.outpoint).toMatch(/^[a-z0-9-]+:\d+$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/did/BtcoDidResolver.ownership.test.ts`
Expected: FAIL — `getSatOwnership` is not a function.

- [ ] **Step 3: Implement**

`types.ts` — add to `OrdinalsProvider`:

```typescript
  /**
   * Current ownership of the UTXO carrying this satoshi. Optional: providers
   * without an owner index simply omit it and resolution carries no
   * ownership metadata. Ownership is resolution METADATA — implementations
   * must never rewrite the inscribed DID document from it.
   */
  getSatOwnership?(satoshi: string): Promise<{ address: string; outpoint: string } | null>;
```

`OrdMockProvider.ts` — add `ownershipBySatoshi: Map<string, { address: string; outpoint: string }>` to the provider's state object (match how `inscriptionsById` is initialized); in `createInscription`, after storing the record:

```typescript
    this.state.ownershipBySatoshi.set(satoshi, { address: 'bcrt1qmockowner', outpoint: `${txid}:${vout}` });
```

In `transferInscription`, after building `txid`:

```typescript
    this.state.ownershipBySatoshi.set(rec.satoshi, { address: _toAddress, outpoint: `${txid}:0` });
```

(Rename `_toAddress` to `toAddress` since it is now used.) Add the method:

```typescript
  // eslint-disable-next-line @typescript-eslint/require-await
  async getSatOwnership(satoshi: string): Promise<{ address: string; outpoint: string } | null> {
    return this.state.ownershipBySatoshi.get(satoshi) ?? null;
  }
```

`BtcoDidResolver.ts` — extend the resolver's provider-like interface with the same optional method; after a successful document resolution, populate metadata:

```typescript
    if (typeof provider.getSatOwnership === 'function') {
      try {
        const ownership = await provider.getSatOwnership(satoshi);
        if (ownership) {
          (result.didDocumentMetadata as Record<string, unknown>).ownership = ownership;
        }
      } catch {
        // Ownership metadata is best-effort; resolution itself is not gated on it.
      }
    }
```

(Adapt names to the resolver's actual local variables — `satoshi`/`result` per the surrounding code; keep the fail-open catch, this is metadata not verification.)

Thread the method through the DIDManager→resolver provider adapter (grep target above): one pass-through line mirroring how `getInscriptionsBySatoshi` is adapted.

- [ ] **Step 4: Extend the test with resolver metadata assertion**

```typescript
  test('resolution carries ownership metadata after inscription', async () => {
    const { OriginalsSDK } = await import('../../../src');
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'ES256K', ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '34'.repeat(32), content: 'y' }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const resolver = new (await import('../../../src/did/BtcoDidResolver')).BtcoDidResolver({ provider } as never);
    const res = await resolver.resolve(asset.bindings!['did:btco']!);
    expect((res.didDocumentMetadata as { ownership?: { address: string } }).ownership?.address).toBe('bcrt1qmockowner');
  });
```

(Adjust the `BtcoDidResolver` constructor options to its actual shape — check the top of `BtcoDidResolver.test.ts` for how existing tests construct it, and mirror that.)

- [ ] **Step 5: Run tests**

Run: `cd packages/sdk && bun test tests/unit/did/ tests/unit/adapters/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src packages/sdk/tests
git commit --no-verify -m "feat(did): sat ownership as resolution metadata (#366)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: `rotateBtcoKeys` + `keyRotationPending` on transfer (#366b)

The recipient-side primitive of the rotation-first rule (spec §5): reinscribe an updated DID document (same `id`, new keys) on the same sat. The resolver's newest-valid-inscription-wins walk then serves the new keys. Non-cooperative `transferOwnership` flags that rotation is pending.

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` (new public method; `transferOwnership` event payload)
- Modify: `packages/sdk/src/events/types.ts` (if the `asset:transferred` payload type needs the new field)
- Create: `packages/sdk/tests/unit/lifecycle/LifecycleManager.rotateBtcoKeys.test.ts`

**Interfaces:**
- Consumes: Task 2's `inscribeData(data, contentType, feeRate, { targetSatoshi })`; `createBtcoDidDocument(satNumber, network, { publicKey, keyType })` from `src/did/createBtcoDidDocument.ts:34`; `multikey` from `src/crypto/Multikey.ts`; Task 1's OrdMock reinscription; Task 8's ownership tracking.
- Produces: `rotateBtcoKeys(asset: OriginalsAsset, newVerificationMethod: { publicKeyMultibase: string }, feeRate?: number): Promise<{ inscriptionId: string; did: string }>`; `asset:transferred` events gain `keyRotationPending: true`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sdk/tests/unit/lifecycle/LifecycleManager.rotateBtcoKeys.test.ts
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { multikey } from '../../../src/crypto/Multikey';

describe('rotateBtcoKeys (#366 rotation-first)', () => {
  test('reinscribes same-id document with the new key; resolver serves it', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32), content: 'z' }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings!['did:btco']!;

    // New owner's key (32 zero bytes is a valid Ed25519 point for encoding purposes in tests —
    // if multikey.encodePublicKey validates the point, generate via sdk.did/KeyManager instead;
    // check how tests/unit/crypto/Multikey.test.ts builds keys and reuse that).
    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');

    const rotation = await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });
    expect(rotation.did).toBe(btcoDid);

    const doc = await sdk.did.resolveDID(btcoDid, { skipCache: true });
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe(btcoDid);
    expect(doc!.verificationMethod?.[0]?.publicKeyMultibase).toBe(newKey);
  });

  test('rejects when asset is not on btco layer', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: new OrdMockProvider() });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '78'.repeat(32), content: 'w' }
    ]);
    await expect(
      sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: 'z6Mkfake' })
    ).rejects.toThrow(/btco/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/LifecycleManager.rotateBtcoKeys.test.ts`
Expected: FAIL — `rotateBtcoKeys` is not a function.

- [ ] **Step 3: Implement `rotateBtcoKeys`**

Add to `LifecycleManager` (near `transferOwnership`):

```typescript
  /**
   * Rotation-first ownership hand-off (#366): reinscribe the did:btco
   * document — same id, new verification method — on the SAME sat. Only the
   * current UTXO holder can do this (reinscription spends the output), so a
   * successful rotation simultaneously proves sat control and announces the
   * new owner's signing key. The resolver's newest-valid-inscription rule
   * then serves the rotated document.
   */
  async rotateBtcoKeys(
    asset: OriginalsAsset,
    newVerificationMethod: { publicKeyMultibase: string },
    feeRate?: number
  ): Promise<{ inscriptionId: string; did: string }> {
    if (asset.currentLayer !== 'did:btco') {
      throw new StructuredError('INVALID_STATE', 'Key rotation requires the asset to be on the did:btco layer.');
    }
    const btcoDid = asset.bindings?.['did:btco'];
    if (!btcoDid) {
      throw new StructuredError('INVALID_STATE', 'Asset has no did:btco binding to rotate.');
    }
    const satoshi = btcoDid.split(':').pop()!;
    const { key, type } = multikey.decodePublicKey(newVerificationMethod.publicKeyMultibase);
    const network = (this.config.network || 'mainnet') as 'mainnet' | 'regtest' | 'signet';
    const rotatedDoc = createBtcoDidDocument(satoshi, network, { publicKey: key, keyType: type });
    // Preserve lineage links across rotations.
    const backLinks = [asset.id, asset.bindings?.['did:webvh']].filter(
      (d): d is string => typeof d === 'string'
    );
    rotatedDoc.alsoKnownAs = backLinks;

    const bitcoinManager = this.deps?.bitcoinManager ?? new BitcoinManager(this.config);
    const inscription = await bitcoinManager.inscribeData(
      Buffer.from(JSON.stringify(rotatedDoc)),
      'application/did+json',
      feeRate,
      { targetSatoshi: satoshi }
    );

    await this.eventEmitter.emit({
      type: 'key:rotated',
      timestamp: new Date().toISOString(),
      asset: { id: asset.id },
      did: btcoDid,
      inscriptionId: inscription.inscriptionId
    } as never);

    return { inscriptionId: inscription.inscriptionId, did: btcoDid };
  }
```

Imports to add at the top of the file if absent: `createBtcoDidDocument` from `../did/createBtcoDidDocument.js`, `multikey` from `../crypto/Multikey.js`.

Network-prefix note: `btcoDid.split(':').pop()` yields the sat for all three forms (`did:btco:N`, `did:btco:reg:N`, `did:btco:sig:N`). The rotated document's `id` must equal `btcoDid` — `createBtcoDidDocument` re-derives the prefix from `network`; add an assertion after building:

```typescript
    if (rotatedDoc.id !== btcoDid) {
      throw new StructuredError('NETWORK_MISMATCH', `Rotated document id ${rotatedDoc.id} does not match binding ${btcoDid}; check config.network.`);
    }
```

- [ ] **Step 4: Flag pending rotation on transfer**

In `transferOwnership`, find the `asset:transferred` event emission (grep `'asset:transferred'` in the file) and add `keyRotationPending: true` to its payload. If `src/events/types.ts` types that payload, add the optional field:

```typescript
  /** True when ownership moved on-chain but the DID document still carries the previous owner's keys (rotation-first model, #366). */
  keyRotationPending?: boolean;
```

Run the event golden-contract tests (`bun test tests/unit/events/`) and follow their guidance if they pin payload shapes.

- [ ] **Step 5: Run tests**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/LifecycleManager.rotateBtcoKeys.test.ts tests/unit/events/ tests/unit/lifecycle/LifecycleManager.transfer.unit.test.ts`
Expected: PASS.

Caveat: the rotated-doc resolution assertion relies on `BtcoDidResolver` picking the NEWEST valid inscription — that walk exists (`BtcoDidResolver.ts` ~236–283). If the resolve returns the genesis doc instead, check `getInscriptionsBySatoshi` ordering in OrdMock (append order = oldest first) versus the resolver's expectation, and fix the ordering expectation in OrdMock rather than the resolver.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src packages/sdk/tests
git commit --no-verify -m "feat(lifecycle): rotateBtcoKeys primitive + keyRotationPending flag (#366)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Honest permanence docs + slop-spec cleanup (#378 words)

No code. Aligns written claims with what the system does, and stops the fabricated RFC from misleading future readers (human or agent).

**Files:**
- Modify: `originals-whitepaper.md` (line 74 and §6 "Security Considerations")
- Delete: `specs/protocol/originals-protocol-rfc.md`
- Create: `specs/protocol/README.md`
- Modify: `docs/IPFS_INTEGRATION_SPEC.md` (§8.3, one sentence)

**Interfaces:** none.

- [ ] **Step 1: Whitepaper — scope the permanence claim**

Replace line 74 (`● did:btco anchoring ensures provenance persists even if institutions dissolve or servers disappear — preserving cultural heritage with Bitcoin's permanence.`) with:

```markdown
● did:btco anchoring makes provenance and content integrity permanent: the asset's identity, history, and resource hashes survive any host. Content availability is permanent only for resources inscribed inline; referenced resources remain verifiable against the inscribed hashes (any surviving copy can be authenticated) but depend on at least one copy surviving.
```

In §6 (Security Considerations), append a 5th item:

```markdown
5. Content Permanence: Inscriptions anchor resource hashes; they do not by themselves host resource bytes. Implementations SHOULD inscribe content inline below a size threshold and MUST record which resources are inscribed versus referenced, so holders can assess availability risk.
```

- [ ] **Step 2: Delete the RFC, add the provenance README**

```bash
git rm specs/protocol/originals-protocol-rfc.md
```

Create `specs/protocol/README.md`:

```markdown
# specs/protocol — provenance warning

Everything in this directory landed in a single unreviewed bulk commit
(`210a8a4 "Up (#148)"`, 2026-03-16, agent-generated) and has not been
individually verified against the implementation.

`originals-protocol-rfc.md` was removed 2026-07-10: it mis-expanded CEL as
"Canonical Event Log" (the implementation and docs/ORIGINALS_CEL_SPEC.md
define the **Cryptographic** Event Log, a W3C CCG CEL profile) and specified
a five-event log schema matching neither `packages/sdk/src/cel/` nor the W3C
spec it cited.

Authoritative documents:
- `originals-whitepaper.md` — protocol vision
- `docs/ORIGINALS_CEL_SPEC.md` + `packages/sdk/src/cel/` — CEL mechanics
- `docs/superpowers/specs/2026-07-10-cel-backbone-did-cel-design.md` — current direction
- `ORIGINALS_PROTOCOL_SPECIFICATION.md` — corroborating (agent-written, Nov 2025)

The remaining btco method specs here may contain salvageable material but
must be verified against code before being cited.
```

- [ ] **Step 3: IPFS spec clarification**

In `docs/IPFS_INTEGRATION_SPEC.md` §8.3, append:

```markdown
IPFS is a redundancy and content-addressing layer. It does not satisfy the did:btco permanence claim: pinning is a service dependency, and only inline-inscribed bytes inherit Bitcoin's availability guarantees.
```

- [ ] **Step 4: Verify nothing referenced the RFC**

Run: `grep -rn "originals-protocol-rfc" --include="*.md" --include="*.ts" . | grep -v node_modules | grep -v ".claude/worktrees" | grep -v superpowers`
Expected: no hits outside this plan/spec and git history. If docs reference it, update them to point at `specs/protocol/README.md`.

- [ ] **Step 5: Commit**

```bash
git add originals-whitepaper.md specs/protocol docs/IPFS_INTEGRATION_SPEC.md
git commit --no-verify -m "docs: honest content-permanence scoping; remove fabricated protocol RFC (#378)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Full-suite verification + lint

- [ ] **Step 1: Full test run**

Run: `cd packages/sdk && bun test`
Expected: PASS, zero failures. Fix any straggler with the patterns from Tasks 3/7.

- [ ] **Step 2: Lint + build**

Run: `bun run lint && bun run build` (from repo root)
Expected: clean.

- [ ] **Step 3: Commit any stragglers**

```bash
git add -A packages/sdk
git commit --no-verify -m "test: phase-0 conformance sweep

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Skip the commit if the tree is clean.)
