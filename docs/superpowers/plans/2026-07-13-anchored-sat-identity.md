# Anchored Sat Identity (Part A — the signed anchoring sat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind an Originals asset's on-chain identity to a *controller-signed* anchoring satoshi carried in the migrate-to-btco event body (`data.to = did:btco:<network>:<sat>`), so the verifier derives the anchored sat from signed material instead of the strippable/unsigned Bitcoin witness array — closing the cross-sat-fork and witness-stripping soundness residuals.

**Architecture:** The writer (`LifecycleManager.inscribeOnBitcoin`) moves its `migrate` CEL append into the `buildContent(satoshi)` deferred-content window where the target sat is pinned, and signs `to: did:btco:<network>:<sat>` into the event. The verifier (`verifyEventLog`) derives `anchoredSat` from that signed `data.to` via `parseSatoshiIdentifier`, requires the Bitcoin witness proof to carry the *same* sat, raises `UNBOUND_ANCHOR` for a btco migrate with no parseable signed sat, and retires the old ">1 witness poisons the anchor" ambiguity branch (the signed `to` now disambiguates). Fold/restore code that scraped the sat off the witness reads it from `data.to` instead.

**Tech Stack:** TypeScript, Bun runtime + `bun test`, `@noble/ed25519` / `@noble/hashes` for CEL signing, `OrdMockProvider` as the in-test "chain", Data Integrity proofs (`eddsa-jcs-2022` controller proofs, `bitcoin-ordinals-2024` witness proofs).

## Global Constraints

- **Runtime:** Bun. Run tests with `bun test <path>` from `packages/sdk/`. `bun test` (whole suite) MUST stay green at the end of every task.
- **Commits:** the commitlint binary is missing in this environment — every `git commit` MUST use `--no-verify`.
- **Imports:** absolute from the `src/` root within a file's own tree using the existing relative style already in that file (e.g. `../../utils/satoshi-validation.js` from `src/cel/algorithms/`); noble imports use the `@noble/hashes/sha2.js` style (already established — do not change import shapes).
- **Scope — Part A ONLY.** Implement only the signed anchoring sat. Explicitly OUT of scope (do NOT implement, do NOT add tasks for): first-anchor-wins uniqueness, `getAnchoringsForDidCel`, and the `alsoKnownAs` `did:cel` back-link on the inscribed DID document. Those belong to the follow-up spec `2026-07-13-did-cel-uniqueness-first-anchor-wins-design.md`. In particular, DO NOT touch `btcoDoc.alsoKnownAs = backLinks` in `inscribeOnBitcoin` beyond what already exists.
- **Hard cutover (no back-compat shim):** a btco-anchored log whose migrate event does not sign a parseable sat MUST fail `UNBOUND_ANCHOR`. Nothing is released; only test logs exist. Regenerate test fixtures rather than adding a legacy fallback.
- **Ownership is unchanged:** ownership is live sat control read via `getCurrentOwner`; this plan changes only how the *authoring* record binds the sat. Do not add or emit `transfer` CEL events.

**Source of truth:** `docs/superpowers/specs/2026-07-13-anchored-sat-identity-design.md`.

**Key real-code anchors (verified against the tree):**
- Writer: `packages/sdk/src/lifecycle/LifecycleManager.ts` — `inscribeOnBitcoin` at ~L1822; current pre-inscription append at L1882-1887; `buildContent` callback at L1906-1927 (`async (satoshi: string) => { … }`); `#cel` service block L1919-1923; witness-splice L1963-1985; `getConfiguredBitcoinNetwork()` at L2699-2703 returns `'mainnet' | 'regtest' | 'signet'`.
- Writer already imports `parseSatoshiIdentifier` (L25) and `btcoDidPrefix` (L26) from `../utils/satoshi-validation.js` / `../cel/btcoDid.js`.
- Fold: `packages/sdk/src/lifecycle/replayProvenance.ts` — `extractWitnessSatoshi` L58-67, btco branch L111-126, `BTCO_SATOSHI_UNKNOWN = 'did:btco:?'` L50, imports `btcoDidFromSatoshi` L47.
- Restore: `LifecycleManager.buildRestoredProvenance` L691-761; btco migration re-materialization L724-738 (reads `wp?.satoshi` via `extractBitcoinWitnessProof` L764-776).
- Verifier: `packages/sdk/src/cel/algorithms/verifyEventLog.ts` — `anchoredSat`/`sawBtcoAnchorAttempt` walk state L1287-1292; migrate anchoredSat derivation + poison branch L1329-1357; head-freshness dispatch L1376-1389; `bitcoinWitnessProofs()` L581-598; `verifyBitcoinWitnessProof` L326-421; `verifyHeadFreshness` L491+; `evaluateNonCooperativeRotation` L670+; `AnchoredSat` interface L570-573.
- Helpers: `btcoDidFromSatoshi(satoshi, network)` in `packages/sdk/src/cel/btcoDid.ts` (mainnet bare, `sig`/`reg` prefixes); `parseSatoshiIdentifier(identifier)` in `packages/sdk/src/utils/satoshi-validation.ts` (accepts `did:btco:<sat>`, `did:btco:reg:<sat>`, `did:btco:sig:<sat>`, `did:btco:test:<sat>`, or a bare number; returns a `number`; throws `StructuredError` on unparseable).
- Test harness: `OrdMockProvider` (`packages/sdk/src/adapters/providers/OrdMockProvider.ts`) — `createInscription({ buildContent | data, targetSatoshi })` pins the sat and records `blockHeight: 1`. Shared builders: `makeAnchoredLog` in `tests/unit/cel/non-cooperative-rotation.test.ts` (L111-126, `SAT='1234567890'`) and `tests/unit/cel/head-freshness.test.ts` (L88-103). E2E: `tests/integration/CreatorBuyerHandoff.e2e.test.ts`, `tests/integration/CelConvergence.e2e.test.ts`, `tests/integration/head-freshness-attack.e2e.test.ts`.

---

### Task 1: Writer — sign the anchoring sat into the migrate event

Move the `migrate` CEL append into the `buildContent(satoshi)` window and sign `to: did:btco:<network>:<sat>`. This is self-contained green: the verifier still reads the witness for now, so the log verifies exactly as before, but the migrate body now additionally carries the signed sat.

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` (import L26; `inscribeOnBitcoin` L1877-1927)
- Test: `packages/sdk/tests/integration/LifecycleManager.test.ts` (add one test; reuse its existing SDK+OrdMock+MockKeyStore setup patterns)

**Interfaces:**
- Consumes: `btcoDidFromSatoshi(satoshi: string | number, network: string | undefined): string`; `this.getConfiguredBitcoinNetwork(): 'mainnet'|'regtest'|'signet'`; `this.appendCelEventOrSkip(asset, 'migrate', data): Promise<string | null>`.
- Produces: a btco `migrate` event whose signed `data` is `{ sourceDid, layer: 'btco', network, to: 'did:btco:<network>:<sat>', migratedAt }`. Later tasks (verifier, fold) rely on `data.to` being the resolvable network-scoped did:btco string.

- [ ] **Step 1: Write the failing test**

Add to `packages/sdk/tests/integration/LifecycleManager.test.ts` (inside the top-level `describe`, matching the file's existing imports for `OriginalsSDK`, `OrdMockProvider`, `MockKeyStore`; if any import is missing, add it alongside the others):

```typescript
  test('inscribeOnBitcoin signs the anchoring sat into the migrate event (data.to)', async () => {
    const ordinalsProvider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      keyStore: new MockKeyStore(),
    } as any);

    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) },
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const btcoBinding = asset.bindings!['did:btco']!;
    expect(btcoBinding).toMatch(/^did:btco:reg:\d+$/);

    const migrate = asset.celLog!.events.find(
      (e) => e.type === 'migrate' && (e.data as any)?.layer === 'btco'
    );
    expect(migrate).toBeDefined();
    const data = migrate!.data as any;
    // The signed body now carries the resolvable, network-scoped anchor.
    expect(data.to).toBe(btcoBinding);
    // The bitcoin witness proof carries the SAME sat the migrate signed.
    const witness = (migrate!.proof as any[]).find(
      (p) => p?.cryptosuite === 'bitcoin-ordinals-2024'
    );
    expect(witness).toBeDefined();
    const signedSat = data.to.split(':').pop();
    expect(witness.satoshi).toBe(signedSat);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/integration/LifecycleManager.test.ts -t "signs the anchoring sat"`
Expected: FAIL — `data.to` is `undefined` (the current migrate body carries no `to`).

- [ ] **Step 3: Add the `btcoDidFromSatoshi` import**

In `packages/sdk/src/lifecycle/LifecycleManager.ts`, change the btcoDid import (currently `import { btcoDidPrefix } from '../cel/btcoDid.js';` at L26) to:

```typescript
import { btcoDidPrefix, btcoDidFromSatoshi } from '../cel/btcoDid.js';
```

- [ ] **Step 4: Remove the pre-inscription append**

Delete the current pre-inscription append block (L1877-1887):

```typescript
    // Append-first (#365): the signed btco migrate event lands BEFORE the
    // inscription so the on-chain document can commit to the post-append head.
    // Satoshi/txid are unknown pre-inscription and are deliberately NOT in the
    // signed data — they arrive later via witness proofs (BtcoMigrationData).
    celLogBefore = asset.celLog;
    celHeadDigest = await this.appendCelEventOrSkip(asset, 'migrate', {
      sourceDid: asset.bindings?.['did:webvh'] ?? asset.id,
      layer: 'btco',
      network: this.getConfiguredBitcoinNetwork(),
      migratedAt: new Date().toISOString()
    });
```

Replace it with just the pre-inscription log snapshot (rollback point) plus the captured network — the append now happens inside `buildContent`:

```typescript
    // Anchor-in-signed-body (design 2026-07-13): the btco migrate event is
    // signed INSIDE buildContent, where the target sat is pinned, so its body
    // can carry the resolvable `to: did:btco:<network>:<sat>`. Snapshot the
    // pre-append log here for rollback; the append itself is deferred below.
    celLogBefore = asset.celLog;
    const network = this.getConfiguredBitcoinNetwork();
```

- [ ] **Step 5: Sign the migrate inside `buildContent`**

In the `buildContent` callback passed to `bitcoinManager.inscribeData` (currently starting `async (satoshi: string) => {` at L1906), insert the append as the FIRST statement, before `migrateToDIDBTCO`, so the `#cel` service (which reads `celHeadDigest`, already declared `let` at L1836) commits to this migrate's digest. The callback becomes:

```typescript
      async (satoshi: string) => {
        // Sign the migrate event NOW that the sat is pinned: the body carries
        // the resolvable did:btco anchor, and the DID doc's #cel commits to
        // this event's digest — so the append MUST precede doc construction.
        celHeadDigest = await this.appendCelEventOrSkip(asset, 'migrate', {
          sourceDid: asset.bindings?.['did:webvh'] ?? asset.id,
          layer: 'btco',
          network,
          to: btcoDidFromSatoshi(satoshi, network),
          migratedAt: new Date().toISOString()
        });
        const btcoDoc = await this.didManager.migrateToDIDBTCO(asset.did, satoshi);
        btcoDoc.alsoKnownAs = backLinks;
        btcoDoc.service = [
          ...(btcoDoc.service || []),
          {
            id: `${btcoDoc.id}#resources`,
            type: 'OriginalsResourceManifest',
            serviceEndpoint: manifestEndpoint
          },
          // On-chain commitment to the entire signed history (#365): anchors
          // the CEL head so the log cannot be swapped or truncated post-hoc.
          // Absent when the append degraded — the doc simply lacks the anchor.
          ...(celHeadDigest !== null ? [{
            id: `${btcoDoc.id}#cel`,
            type: 'OriginalsCelAnchor',
            serviceEndpoint: { headDigestMultibase: celHeadDigest }
          }] : [])
        ];
        inscribedBtcoDoc = btcoDoc;
        return Buffer.from(JSON.stringify(btcoDoc));
      },
```

Note: the witness-splice block at L1963-1985 already sets `witnessProof.satoshi = inscription.satoshi`, which equals the sat passed to `buildContent`, i.e. the sat signed into `data.to`. Leave the splice as-is — it now inherently carries the signed sat. No further writer change is required in this task.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/sdk && bun test tests/integration/LifecycleManager.test.ts -t "signs the anchoring sat"`
Expected: PASS.

- [ ] **Step 7: Run the writer-flow regressions**

Run: `cd packages/sdk && bun test tests/integration/LifecycleManager.test.ts tests/integration/CreatorBuyerHandoff.e2e.test.ts tests/integration/CelConvergence.e2e.test.ts`
Expected: PASS (the verifier still reads the witness; adding `data.to` is additive).

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/lifecycle/LifecycleManager.ts packages/sdk/tests/integration/LifecycleManager.test.ts
git commit --no-verify -m "feat(lifecycle): sign the anchoring sat into the btco migrate event"
```

---

### Task 2: Pre-stage test fixtures with the signed `to`

The verifier (Task 4) and fold (Task 3) will require `data.to` on every btco `migrate`. Add it now to every hand-built btco *migrate* fixture. Under the CURRENT verifier (witness-based) and CURRENT fold (witness-based), adding `to` is harmless — so the suite stays green. This pre-stage lets Tasks 3 and 4 flip logic without breaking unrelated fixtures.

Only real `migrate` events with `data.layer === 'btco'` need `to`. Do NOT touch: `OriginalsCel` manager configs (`new OriginalsCel({ layer: 'btco' })`, e.g. `tests/unit/cel/OriginalsCel.test.ts:108,774`), `update`-typed events carrying `layer: 'btco'` (e.g. `BtcoCelManager.test.ts:564`, `cli-inspect.test.ts:258,418`), or degraded migrates that intentionally omit a binding.

**Files (all under `packages/sdk/`):**
- Modify: `tests/unit/cel/non-cooperative-rotation.test.ts` (L119 `makeAnchoredLog`; L316; L512)
- Modify: `tests/unit/cel/head-freshness.test.ts` (L96 `makeAnchoredLog`)
- Modify: `tests/unit/cel/event-log-authorization.test.ts` (L279)
- Modify: `tests/unit/lifecycle/replayProvenance.test.ts` (L134)
- Modify: `tests/unit/cel/cli-inspect.test.ts` (L535-539 migrate)

**Interfaces:**
- Consumes: nothing new.
- Produces: fixtures whose btco `migrate` body carries `to: did:btco:<network>:<sat>` matching each fixture's witness satoshi. Tasks 3 & 4 rely on this.

- [ ] **Step 1: Update the non-cooperative-rotation `makeAnchoredLog` builder**

In `tests/unit/cel/non-cooperative-rotation.test.ts`, the builder appends the migrate with the `sat` parameter available. Replace the migrate append (L116-121) so `to` matches the inscribed sat:

```typescript
  log = await appendEvent(
    log,
    'migrate',
    { sourceDid: 'did:cel:uPlaceholder', layer: 'btco', network: 'regtest', to: `did:btco:reg:${sat}`, migratedAt: '2026-07-10T00:00:00Z' },
    { signer: a.signer, verificationMethod: a.vm }
  );
```

- [ ] **Step 2: Update the two inline migrate builders in the same file**

At L316 and L512 the migrate inscribes on `SAT` (`'1234567890'`). Replace each occurrence of:

```typescript
    log = await appendEvent(log, 'migrate', { sourceDid: 'did:cel:uP', layer: 'btco', network: 'regtest', migratedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
```

with (identical on both lines — indentation matches each site):

```typescript
    log = await appendEvent(log, 'migrate', { sourceDid: 'did:cel:uP', layer: 'btco', network: 'regtest', to: `did:btco:reg:${SAT}`, migratedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
```

- [ ] **Step 3: Update the head-freshness `makeAnchoredLog` builder**

In `tests/unit/cel/head-freshness.test.ts` (migrate at L94-97), replace with:

```typescript
    'migrate',
    { sourceDid: 'did:cel:uPlaceholder', layer: 'btco', network: 'regtest', to: `did:btco:reg:${sat}`, migratedAt: '2026-07-10T00:00:00Z' },
```

- [ ] **Step 4: Update event-log-authorization migrate (witness sat `'123'`)**

In `tests/unit/cel/event-log-authorization.test.ts` (L279), replace:

```typescript
        { sourceDid: 'did:cel:uPlaceholder', layer: 'btco', network: 'regtest', migratedAt: '2026-07-10T00:00:00Z' },
```

with:

```typescript
        { sourceDid: 'did:cel:uPlaceholder', layer: 'btco', network: 'regtest', to: 'did:btco:reg:123', migratedAt: '2026-07-10T00:00:00Z' },
```

- [ ] **Step 5: Update the replayProvenance fold fixture (witness sat `'123456789'`)**

In `tests/unit/lifecycle/replayProvenance.test.ts` (migrate data at L132-137), replace:

```typescript
          data: {
            sourceDid: genesisDid,
            layer: 'btco',
            network: 'regtest',
            migratedAt: '2026-07-10T00:05:00.000Z',
          },
```

with:

```typescript
          data: {
            sourceDid: genesisDid,
            layer: 'btco',
            network: 'regtest',
            to: 'did:btco:reg:123456789',
            migratedAt: '2026-07-10T00:05:00.000Z',
          },
```

- [ ] **Step 6: Update the cli-inspect migrate (witness sat `'123456789'`, mainnet)**

In `tests/unit/cel/cli-inspect.test.ts` (migrate at L537-540, which carries no `network` → mainnet), replace:

```typescript
      log = await appendEvent(log, 'migrate', {
        sourceDid: 'did:webvh:example.com:btco1',
        layer: 'btco',
        migratedAt: '2026-01-20T11:00:00Z',
      }, options);
```

with:

```typescript
      log = await appendEvent(log, 'migrate', {
        sourceDid: 'did:webvh:example.com:btco1',
        layer: 'btco',
        to: 'did:btco:123456789',
        migratedAt: '2026-01-20T11:00:00Z',
      }, options);
```

- [ ] **Step 7: Run all touched fixtures (still green under current logic)**

Run: `cd packages/sdk && bun test tests/unit/cel/non-cooperative-rotation.test.ts tests/unit/cel/head-freshness.test.ts tests/unit/cel/event-log-authorization.test.ts tests/unit/lifecycle/replayProvenance.test.ts tests/unit/cel/cli-inspect.test.ts`
Expected: PASS (the added `to` is inert under witness-based verify/fold).

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/tests/unit/cel/non-cooperative-rotation.test.ts packages/sdk/tests/unit/cel/head-freshness.test.ts packages/sdk/tests/unit/cel/event-log-authorization.test.ts packages/sdk/tests/unit/lifecycle/replayProvenance.test.ts packages/sdk/tests/unit/cel/cli-inspect.test.ts
git commit --no-verify -m "test: pre-stage signed did:btco to on btco migrate fixtures"
```

---

### Task 3: Fold/restore — read the anchoring sat from the signed `data.to`

Replace witness-scraping in the two fold paths with reads of the signed `data.to`.

**Files (under `packages/sdk/`):**
- Modify: `src/lifecycle/replayProvenance.ts` (import block L45-47; btco branch L111-126; `extractWitnessSatoshi` L58-67 becomes unused)
- Modify: `src/lifecycle/LifecycleManager.ts` (`buildRestoredProvenance` btco branch L724-738)
- Test: `tests/unit/lifecycle/replayProvenance.test.ts` (add one assertion-focused test)

**Interfaces:**
- Consumes: `data.to` on the btco migrate (Task 1/2); `parseSatoshiIdentifier`, `btcoDidFromSatoshi`, `BTCO_SATOSHI_UNKNOWN`.
- Produces: `replayProvenance(log).bindings['did:btco']` derived from `data.to`; `BTCO_SATOSHI_UNKNOWN` sentinel when `data.to` is absent/unparseable.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/lifecycle/replayProvenance.test.ts` (reuse the file's existing `replayProvenance` import and event-log construction helpers; build a minimal create→migrate log inline if no shared builder fits):

```typescript
  test('btco binding is derived from the signed data.to, not the witness sat', async () => {
    // A migrate whose SIGNED to disagrees with a (spoofable) witness sat must
    // fold to the SIGNED sat. Build create + btco-migrate with data.to on one
    // sat and a bitcoin witness proof naming a DIFFERENT sat.
    const log = {
      events: [
        {
          type: 'create',
          data: { controller: 'did:key:zSigner', name: 'A', resources: [], createdAt: '2026-07-13T00:00:00Z' },
          proof: [{ type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', verificationMethod: 'did:key:zSigner#zSigner', proofPurpose: 'assertionMethod', proofValue: 'z1' }],
        },
        {
          type: 'migrate',
          data: { sourceDid: 'did:cel:uX', layer: 'btco', network: 'regtest', to: 'did:btco:reg:111', migratedAt: '2026-07-13T00:01:00Z' },
          previousEvent: 'uPrev',
          proof: [
            { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', verificationMethod: 'did:key:zSigner#zSigner', proofPurpose: 'assertionMethod', proofValue: 'z2' },
            { type: 'DataIntegrityProof', cryptosuite: 'bitcoin-ordinals-2024', witnessedAt: 'x', created: 'x', verificationMethod: 'did:btco:witness', proofPurpose: 'assertionMethod', proofValue: 'zinsc', satoshi: '999', inscriptionId: 'insc' },
          ],
        },
      ],
    } as any;
    const folded = replayProvenance(log);
    expect(folded.currentLayer).toBe('did:btco');
    expect(folded.bindings['did:btco']).toBe('did:btco:reg:111'); // signed, not the witness 999
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/replayProvenance.test.ts -t "signed data.to"`
Expected: FAIL — the current fold reads the witness (`'999'`) → `did:btco:reg:999`.

- [ ] **Step 3: Add the `parseSatoshiIdentifier` import to replayProvenance**

In `src/lifecycle/replayProvenance.ts`, add below the existing btcoDid import (L47):

```typescript
import { parseSatoshiIdentifier } from '../utils/satoshi-validation.js';
```

- [ ] **Step 4: Rewrite the btco fold branch**

In `src/lifecycle/replayProvenance.ts`, replace the btco branch (L111-126):

```typescript
    } else if (data.layer === 'btco') {
      result.currentLayer = 'did:btco';
      const satoshi = extractWitnessSatoshi(event);
      let to = BTCO_SATOSHI_UNKNOWN;
      if (satoshi) {
        const network = typeof data.network === 'string' ? data.network : undefined;
        const btcoDid = btcoDidFromSatoshi(satoshi, network);
        result.bindings['did:btco'] = btcoDid;
        to = btcoDid;
      }
      result.migrations.push({
        from: typeof data.sourceDid === 'string' ? data.sourceDid : '',
        to,
        timestamp: typeof data.migratedAt === 'string' ? data.migratedAt : '',
      });
    }
```

with (sat now comes from the SIGNED `data.to`; witness is no longer consulted):

```typescript
    } else if (data.layer === 'btco') {
      result.currentLayer = 'did:btco';
      // The anchoring sat is the controller-SIGNED did:btco in data.to (design
      // 2026-07-13), never the unsigned witness proof. Absent/unparseable to
      // (degraded/legacy) folds to the honest sentinel.
      let to = BTCO_SATOSHI_UNKNOWN;
      if (typeof data.to === 'string') {
        try {
          const satoshi = String(parseSatoshiIdentifier(data.to));
          const network = typeof data.network === 'string' ? data.network : undefined;
          const btcoDid = btcoDidFromSatoshi(satoshi, network);
          result.bindings['did:btco'] = btcoDid;
          to = btcoDid;
        } catch {
          // unparseable signed anchor → leave the sentinel, omit the binding
        }
      }
      result.migrations.push({
        from: typeof data.sourceDid === 'string' ? data.sourceDid : '',
        to,
        timestamp: typeof data.migratedAt === 'string' ? data.migratedAt : '',
      });
    }
```

- [ ] **Step 5: Remove the now-unused `extractWitnessSatoshi` helper**

Delete `extractWitnessSatoshi` (L58-67) and its `/** Mirrors BtcoCelManager… */` comment. (If `bun`/tsc flags it as unused elsewhere, confirm with `grep -n extractWitnessSatoshi src/lifecycle/replayProvenance.ts` returns nothing after deletion.)

- [ ] **Step 6: Rewrite the restore btco branch in LifecycleManager**

In `src/lifecycle/LifecycleManager.ts`, `buildRestoredProvenance`, replace the btco branch (L724-738):

```typescript
      } else if (data.layer === 'btco') {
        const wp = this.extractBitcoinWitnessProof(ev);
        migrations.push({
          from: layer,
          to: 'did:btco',
          timestamp,
          transactionId: wp?.txid,
          inscriptionId: wp?.inscriptionId,
          satoshi: wp?.satoshi,
          commitTxId: env.unverified?.commitTxId,
          revealTxId: wp?.txid,
          feeRate: env.unverified?.feeRate
        });
        layer = 'did:btco';
      }
```

with (sat from the signed `data.to`; txid/inscriptionId remain advisory tx metadata off the witness):

```typescript
      } else if (data.layer === 'btco') {
        const wp = this.extractBitcoinWitnessProof(ev);
        // The anchoring sat is the SIGNED data.to (design 2026-07-13). txid /
        // inscriptionId stay advisory transaction metadata scraped off the
        // (unsigned) witness — they are not identity-bearing.
        let satoshi: string | undefined;
        if (typeof data.to === 'string') {
          try { satoshi = String(parseSatoshiIdentifier(data.to)); } catch { satoshi = undefined; }
        }
        migrations.push({
          from: layer,
          to: 'did:btco',
          timestamp,
          transactionId: wp?.txid,
          inscriptionId: wp?.inscriptionId,
          satoshi,
          commitTxId: env.unverified?.commitTxId,
          revealTxId: wp?.txid,
          feeRate: env.unverified?.feeRate
        });
        layer = 'did:btco';
      }
```

- [ ] **Step 7: Run the fold tests**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/replayProvenance.test.ts tests/integration/CelConvergence.e2e.test.ts tests/integration/CreatorBuyerHandoff.e2e.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/lifecycle/replayProvenance.ts packages/sdk/src/lifecycle/LifecycleManager.ts packages/sdk/tests/unit/lifecycle/replayProvenance.test.ts
git commit --no-verify -m "feat(lifecycle): fold the btco anchor from the signed data.to"
```

---

### Task 4: Verifier — anchor from the signed body; UNBOUND_ANCHOR; witness must match; retire the poison branch

The security core. Derive `anchoredSat` from the signed `data.to`; require the Bitcoin witness to carry the same sat; raise `UNBOUND_ANCHOR` for a btco migrate with no parseable signed sat; delete the `sawBtcoAnchorAttempt` / ">1 witness poisons the anchor" machinery.

**Files (under `packages/sdk/`):**
- Modify: `src/cel/algorithms/verifyEventLog.ts` (imports L20-23; walk state L1287-1292; migrate anchoredSat block L1329-1357; head-freshness dispatch L1376-1389)
- Rewrite: `tests/unit/cel/head-freshness.test.ts` (POISONED ANCHOR test L218-238)
- Test: `tests/unit/cel/anchored-sat-identity.test.ts` (NEW — attack + round-trip suite)

**Interfaces:**
- Consumes: `data.to` on btco migrate; `parseSatoshiIdentifier`; existing `bitcoinWitnessProofs(event)`, `AnchoredSat`, `verifyHeadFreshness`.
- Produces: verifier that fails with `UNBOUND_ANCHOR` (bare/unparseable signed sat), rejects a witness sat ≠ signed sat, and sets `anchoredSat = { satoshi: <signed>, inscriptionId: <matching witness> }`. `sawBtcoAnchorAttempt` no longer exists.

- [ ] **Step 1: Write the new failing attack + round-trip tests**

Create `packages/sdk/tests/unit/cel/anchored-sat-identity.test.ts`. It reuses the exact `makeKey` / `chainDigest` / `btcoDoc` / `attachWitness` / `inscribeDoc` / `makeAnchoredLog` harness style from `non-cooperative-rotation.test.ts` (copy those helpers verbatim into this file — the existing suite deliberately duplicates them per file rather than sharing a module):

```typescript
/**
 * Anchored-sat identity (design 2026-07-13, Part A): the verifier binds btco
 * identity to the SIGNED anchoring sat in the migrate body (data.to), not the
 * unsigned witness. Closes cross-sat fork + witness-stripping.
 */
import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent, canonicalizeEntryForChain } from '../../../src/cel/canonicalize';
import { computeDigestMultibase } from '../../../src/cel/hash';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
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
    proofValue: multikey.encodeMultibase(new Uint8Array(await ed25519.signAsync(canonicalizeEvent(data), priv))),
  });
  return { signer, didKey, vm, pubMb };
}
type Key = Awaited<ReturnType<typeof makeKey>>;
const chainDigest = (e: LogEntry) => computeDigestMultibase(canonicalizeEntryForChain(e));

function btcoDoc(satoshi: string, headDigestMultibase: string) {
  const id = `did:btco:reg:${satoshi}`;
  return { '@context': ['https://www.w3.org/ns/did/v1'], id, service: [{ id: `${id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase } }] };
}
function attachWitness(log: EventLog, insc: { inscriptionId: string; txid: string }, satoshi: string): EventLog {
  const last = log.events[log.events.length - 1];
  const witnessProof = { type: 'DataIntegrityProof', cryptosuite: 'bitcoin-ordinals-2024', created: 'x', verificationMethod: 'did:btco:witness', proofPurpose: 'assertionMethod', proofValue: `z${insc.inscriptionId}`, witnessedAt: 'x', txid: insc.txid, satoshi, inscriptionId: insc.inscriptionId };
  return { events: [...log.events.slice(0, -1), { ...last, proof: [...last.proof, witnessProof] }] };
}
async function inscribeDoc(provider: OrdMockProvider, satoshi: string, headDigest: string) {
  const res = await provider.createInscription({ data: Buffer.from(JSON.stringify(btcoDoc(satoshi, headDigest))), contentType: 'application/did+json', targetSatoshi: satoshi });
  return { inscriptionId: res.inscriptionId, txid: res.txid };
}
const SAT = '1234567890';

// create(a) -> signed btco migrate (to = did:btco:reg:SAT) -> witness on SAT.
async function makeAnchoredLog(provider: OrdMockProvider, a: Key, sat = SAT) {
  let log = await createEventLog(
    { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-07-13T00:00:00Z', nonce: 'ai-1' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  log = await appendEvent(
    log, 'migrate',
    { sourceDid: 'did:cel:uPlaceholder', layer: 'btco', network: 'regtest', to: `did:btco:reg:${sat}`, migratedAt: '2026-07-13T00:00:00Z' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  const insc = await inscribeDoc(provider, sat, chainDigest(log.events[log.events.length - 1]));
  return { log: attachWitness(log, insc, sat), inscriptionId: insc.inscriptionId };
}

describe('anchored-sat identity — signed-body binding', () => {
  test('honest round-trip: a signed-sat btco migrate verifies with a provider', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const result = await verifyEventLog(log, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
  });

  test('UNBOUND_ANCHOR: a btco migrate with bare to:did:btco (no sat) fails closed', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    let log = await createEventLog(
      { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-07-13T00:00:00Z', nonce: 'ai-2' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    // Old-shape body: no parseable sat in `to`.
    log = await appendEvent(log, 'migrate', { sourceDid: 'did:cel:uP', layer: 'btco', network: 'regtest', to: 'did:btco', migratedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    const insc = await inscribeDoc(provider, SAT, chainDigest(log.events[1]));
    log = attachWitness(log, insc, SAT);
    const result = await verifyEventLog(log, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /UNBOUND_ANCHOR/.test(e))).toBe(true);
  });

  test('cross-sat fork (repoint witness): witness sat != signed sat -> reject', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const { log } = await makeAnchoredLog(provider, a); // signed + witnessed on SAT
    // Attacker inscribes an anchor doc on a sat THEY control, committing to the
    // public migrate digest, and repoints the witness to it.
    const ATT = '9999999999';
    const insc2 = await inscribeDoc(provider, ATT, chainDigest(log.events[1]));
    const forked = attachWitness({ events: [log.events[0], { ...log.events[1], proof: log.events[1].proof.filter((p: any) => p.cryptosuite !== 'bitcoin-ordinals-2024') }] } as EventLog, insc2, ATT);
    const result = await verifyEventLog(forked, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /does not match the signed anchoring sat/.test(e))).toBe(true);
  });

  test('cross-sat fork (rewrite signed to): controller signature no longer verifies', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    // Tamper the SIGNED body to the attacker sat without re-signing.
    const tampered = { events: [log.events[0], { ...log.events[1], data: { ...(log.events[1].data as any), to: 'did:btco:reg:9999999999' } }] } as EventLog;
    const result = await verifyEventLog(tampered, { ordinalsProvider: provider });
    expect(result.verified).toBe(false); // migrate controller proof breaks
  });

  test('witness-stripping (witness removed), no provider -> fail closed, NOT never-anchored', async () => {
    const a = await makeKey();
    // Build the signed migrate WITHOUT any witness proof.
    let log = await createEventLog(
      { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-07-13T00:00:00Z', nonce: 'ai-3' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'migrate', { sourceDid: 'did:cel:uP', layer: 'btco', network: 'regtest', to: `did:btco:reg:${SAT}`, migratedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    const result = await verifyEventLog(log, {}); // no provider, no witness
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /no verifiable bitcoin witness proof/.test(e))).toBe(true);
  });

  test('witness-stripping (witness removed), WITH provider -> still fail closed (no on-chain witness to confirm)', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    let log = await createEventLog(
      { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-07-13T00:00:00Z', nonce: 'ai-4' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'migrate', { sourceDid: 'did:cel:uP', layer: 'btco', network: 'regtest', to: `did:btco:reg:${SAT}`, migratedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    const result = await verifyEventLog(log, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /no verifiable bitcoin witness proof/.test(e))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd packages/sdk && bun test tests/unit/cel/anchored-sat-identity.test.ts`
Expected: FAIL — the current verifier derives the anchor from the witness, so the fork/UNBOUND/stripping cases wrongly pass and the error strings don't exist yet. (The honest round-trip may pass already; that's fine.)

- [ ] **Step 3: Add the `parseSatoshiIdentifier` import to verifyEventLog**

In `src/cel/algorithms/verifyEventLog.ts`, add after the `celDid.js` import (L23):

```typescript
import { parseSatoshiIdentifier } from '../../utils/satoshi-validation.js';
```

- [ ] **Step 4: Remove `sawBtcoAnchorAttempt` walk state**

Replace the walk-state declaration block (L1287-1292):

```typescript
  let anchoredSat: AnchoredSat | undefined;
  // Tracks whether ANY verified migrate event carried a bitcoin witness proof —
  // even when the anchor-poison rule below voids anchoredSat. Head-freshness
  // needs this to distinguish never-btco-anchored (legit no-op) from
  // btco-anchored-but-poisoned (must fail closed).
  let sawBtcoAnchorAttempt = false;
```

with (the poison distinction no longer exists — a verified btco migrate always yields a defined `anchoredSat`, or the log fails):

```typescript
  // Companion walk state (#366): once a btco migrate's SIGNED anchoring sat is
  // confirmed by a matching bitcoin witness proof, the log's authority is
  // anchored to that sat. Default-path only; a custom verifier owns semantics.
  let anchoredSat: AnchoredSat | undefined;
```

- [ ] **Step 5: Rewrite the migrate anchoredSat derivation (signed body + witness match; UNBOUND_ANCHOR)**

Replace the migrate/rotateKey anchoredSat maintenance block (L1329-1357):

```typescript
    if (!options?.verifier && eventResult.proofValid && eventResult.chainValid) {
      if (event.type === 'migrate') {
        // proofValid=true ⇒ every bitcoin witness proof on the event verified,
        // so its satoshi/inscriptionId are chain-attested. But the proof array
        // is UNSIGNED: with more than one verified bitcoin witness proof an
        // attacker who controls the array order (or injected a proof anchored
        // to a sat THEY control, committing to this public digest) could pick
        // which sat "anchors" authority and rotate on it. Ambiguity therefore
        // POISONS the anchor (mirrors the exactly-one-controller-proof rule on
        // the create event): only an unambiguous single proof anchors, and the
        // non-cooperative rotation arm stays unavailable otherwise — the log's
        // verdict itself is unchanged.
        const witnessed = bitcoinWitnessProofs(event);
        // Any verified bitcoin-witnessed migrate marks the log btco-anchored,
        // INCLUDING the poisoned (>1) case — freshness must still fail closed.
        if (witnessed.length >= 1) {
          sawBtcoAnchorAttempt = true;
        }
        if (witnessed.length === 1) {
          anchoredSat = { satoshi: witnessed[0].satoshi, inscriptionId: witnessed[0].inscriptionId };
        } else if (witnessed.length > 1) {
          anchoredSat = undefined;
        }
      } else if (event.type === 'rotateKey' && eventResult.nonCooperativeRotation && anchoredSat) {
        // The accepted reinscription becomes the new anchor, so a CHAINED
        // non-cooperative rotation must reinscribe strictly after it.
        anchoredSat = { satoshi: anchoredSat.satoshi, inscriptionId: eventResult.nonCooperativeRotation.inscriptionId };
      }
    }
```

with (the SIGNED `data.to` is the canonical sat; the witness must match it; no poison branch):

```typescript
    if (!options?.verifier && eventResult.proofValid && eventResult.chainValid) {
      if (event.type === 'migrate') {
        const mdata = event.data as { layer?: unknown; to?: unknown } | null | undefined;
        if (mdata?.layer === 'btco') {
          // The canonical anchoring sat is the controller-SIGNED did:btco in
          // data.to (design 2026-07-13), NOT the unsigned witness array. A btco
          // migrate that does not sign a parseable sat is UNBOUND.
          let signedSat: string | undefined;
          if (typeof mdata.to === 'string') {
            try { signedSat = String(parseSatoshiIdentifier(mdata.to)); } catch { signedSat = undefined; }
          }
          if (signedSat === undefined) {
            eventResult.proofValid = false;
            eventResult.errors.push(
              `Event ${i}: UNBOUND_ANCHOR: a btco migrate must sign a resolvable did:btco anchoring sat in data.to (found ${String(mdata.to)})`
            );
          } else {
            // proofValid=true ⇒ every bitcoin witness proof already verified
            // on-chain. Require them to carry the SIGNED sat: a witness on any
            // other sat is a cross-sat fork attempt; none on the signed sat is
            // witness-stripping. Both fail closed.
            const witnessed = bitcoinWitnessProofs(event);
            const offSignedSat = witnessed.find(w => w.satoshi !== signedSat);
            const onSignedSat = witnessed.find(w => w.satoshi === signedSat);
            if (offSignedSat) {
              eventResult.proofValid = false;
              eventResult.errors.push(
                `Event ${i}: bitcoin witness proof satoshi ${offSignedSat.satoshi} does not match the signed anchoring sat ${signedSat}`
              );
            } else if (!onSignedSat) {
              eventResult.proofValid = false;
              eventResult.errors.push(
                `Event ${i}: btco migrate signs anchoring sat ${signedSat} but carries no verifiable bitcoin witness proof on it`
              );
            } else {
              anchoredSat = { satoshi: signedSat, inscriptionId: onSignedSat.inscriptionId };
            }
          }
        }
      } else if (event.type === 'rotateKey' && eventResult.nonCooperativeRotation && anchoredSat) {
        // The accepted reinscription becomes the new anchor, so a CHAINED
        // non-cooperative rotation must reinscribe strictly after it.
        anchoredSat = { satoshi: anchoredSat.satoshi, inscriptionId: eventResult.nonCooperativeRotation.inscriptionId };
      }
    }

    // A migrate that failed the anchor checks above must surface in the log
    // errors just like any other failing event (mirrors the loop's tail).
```

Note: because `eventResult` is pushed and its errors are collected right below (existing L1359-1363), a mutation of `eventResult.proofValid`/`.errors` here is picked up — the same pattern the rotateKey unbindable-newController check uses at L1314-1318. Leave the existing `eventVerifications.push(eventResult); if (!eventResult.proofValid …) errors.push(...eventResult.errors);` tail unchanged; delete the extra trailing comment line if it reads awkwardly.

- [ ] **Step 6: Simplify the head-freshness dispatch (drop the poison branch)**

Replace the head-freshness dispatch block (L1376-1389):

```typescript
  let staleLogError: string | undefined;
  if (options?.checkHeadFreshness) {
    if (options?.verifier) {
      staleLogError =
        `head-freshness check is incompatible with a custom verifier: the custom path skips the ` +
        `on-chain authority walk that head freshness is validated against`;
    } else if (anchoredSat) {
      staleLogError = await verifyHeadFreshness(log, anchoredSat, options?.ordinalsProvider) ?? undefined;
    } else if (sawBtcoAnchorAttempt) {
      staleLogError =
        `STALE_LOG: the log is bitcoin-anchored but its anchor is ambiguous (a migrate event carries ` +
        `more than one verified bitcoin witness proof), so head freshness cannot be checked; failing closed`;
    }
  }
```

with (a verified btco migrate always sets `anchoredSat`; `undefined` here means never-btco-anchored → the flag is a genuine no-op):

```typescript
  let staleLogError: string | undefined;
  if (options?.checkHeadFreshness) {
    if (options?.verifier) {
      staleLogError =
        `head-freshness check is incompatible with a custom verifier: the custom path skips the ` +
        `on-chain authority walk that head freshness is validated against`;
    } else if (anchoredSat) {
      staleLogError = await verifyHeadFreshness(log, anchoredSat, options?.ordinalsProvider) ?? undefined;
    }
    // No anchoredSat ⇒ the log was never btco-anchored (a signed btco migrate
    // that failed the anchor checks failed the whole log above), so there is
    // nothing to be fresh against — the flag is a no-op.
  }
```

- [ ] **Step 7: Rewrite the POISONED ANCHOR head-freshness test**

In `tests/unit/cel/head-freshness.test.ts`, replace the whole `test('POISONED ANCHOR: …')` (L218-238) with a test that asserts the new rule: a second witness on a DIFFERENT sat now fails the migrate outright (witness ≠ signed sat), independent of head-freshness:

```typescript
  test('a migrate with a second witness on a NON-signed sat fails closed (witness must match the signed anchoring sat)', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const { log: prefix, migrateDigest } = await makeAnchoredLog(provider, a);
    // Attacker adds a SECOND verified witness on a sat they control, committing
    // to the public migrate digest. Under the signed-anchor rule this witness
    // disagrees with the signed data.to (SAT) and rejects the migrate.
    const SAT2 = '9999999999';
    const insc2 = await inscribeDoc(provider, SAT2, migrateDigest);
    const twoWitness = attachWitness(prefix, insc2, SAT2);
    const result = await verifyEventLog(twoWitness, { ordinalsProvider: provider, checkHeadFreshness: true });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /does not match the signed anchoring sat/.test(e))).toBe(true);
  });
```

(If `makeAnchoredLog` in this file does not return `migrateDigest`, it does — L102 `return { log, migrateInscriptionId, migrateDigest }`. Keep using it.)

- [ ] **Step 8: Run the verifier test suites**

Run: `cd packages/sdk && bun test tests/unit/cel/anchored-sat-identity.test.ts tests/unit/cel/head-freshness.test.ts tests/unit/cel/non-cooperative-rotation.test.ts tests/unit/cel/key-rotation-authority.test.ts tests/unit/cel/verifyEventLog.test.ts tests/integration/head-freshness-attack.e2e.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full suite (hard-cutover check)**

Run: `cd packages/sdk && bun test`
Expected: PASS. If any test fails with `UNBOUND_ANCHOR` or `does not match the signed anchoring sat`, it is a hand-built btco migrate fixture missed in Task 2 — add its `to: did:btco:<network>:<sat>` (matching that fixture's witness sat) and re-run. Use `superpowers:systematic-debugging` if a failure is not an obvious missing-`to`.

- [ ] **Step 10: Commit**

```bash
git add packages/sdk/src/cel/algorithms/verifyEventLog.ts packages/sdk/tests/unit/cel/anchored-sat-identity.test.ts packages/sdk/tests/unit/cel/head-freshness.test.ts
git commit --no-verify -m "feat(cel): bind btco identity to the signed anchoring sat in verifyEventLog"
```

---

### Task 5: Changeset

The repo gates on "Changeset present". This is a minor with breaking verifier behavior.

**Files:**
- Create: `.changeset/anchored-sat-identity.md`

**Interfaces:** none (release metadata).

- [ ] **Step 1: Write the changeset**

Create `.changeset/anchored-sat-identity.md` (match the style of `.changeset/ownership-is-the-sat.md`):

```markdown
---
"@originals/sdk": minor
---

Bind btco asset identity to the controller-**signed** anchoring satoshi. The migrate-to-btco CEL event now signs `data.to = did:btco:<network>:<sat>` (upgraded from a bare `'did:btco'`), and `verifyEventLog` derives the anchored sat from that signed body instead of the unsigned Bitcoin witness proof array. This closes two keyless-verifier soundness residuals: the **cross-sat fork** (repointing the witness to an attacker-controlled sat) and **witness-stripping** (dropping the witness so the log reads as never-anchored).

- **Breaking (verifier behavior):** a btco-anchored log whose migrate event does not sign a parseable sat now fails with `UNBOUND_ANCHOR`. A Bitcoin witness proof whose satoshi disagrees with the signed `data.to` is rejected. A signed btco migrate with no verifiable witness on the signed sat fails closed. This is a **hard cutover** — logs built with the old bare-`did:btco` migrate shape must be regenerated (nothing is released; only test logs existed).
- **Removed:** the ">1 witness poisons the anchor" ambiguity rule and the `STALE_LOG`-for-poisoned-anchor path — the signed `to` now disambiguates the canonical sat, so extra witnesses on other sats are simply invalid.
- Provenance fold (`replayProvenance`) and envelope restore now read the btco binding from the signed `data.to`, not the witness satoshi.

Unchanged: `did:cel` derivation, forward resolution, and the ownership-is-the-sat model (ownership is live sat control via `getCurrentOwner`). The `did:cel` uniqueness / first-anchor-wins work and the DID-document `alsoKnownAs` `did:cel` back-link are a separate follow-up spec, not included here.
```

- [ ] **Step 2: Verify the whole suite once more**

Run: `cd packages/sdk && bun test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add .changeset/anchored-sat-identity.md
git commit --no-verify -m "chore: changeset for signed anchored-sat identity (Part A)"
```

---

## Self-Review

**Spec coverage:**
- §3 Writer (append moved into `buildContent`, signs `to: did:btco:<network>:<sat>`, `#cel` commits to migrate digest, witness carries the signed sat) → Task 1. Fold/restore read from `data.to` → Task 3.
- §4 Verifier (anchor from signed body; `UNBOUND_ANCHOR`; witness must match; head-freshness + non-cooperative rotation key off the signed sat; retire the poison/`sawBtcoAnchorAttempt` branch) → Task 4.
- §7 Testing spine — cross-sat fork (both variants), witness-stripping (no provider + with provider), honest round-trip (Task 4 unit + the untouched `CreatorBuyerHandoff.e2e` regression), hard-cutover guard (`UNBOUND_ANCHOR`), full-tail-truncation boundary via existing `STALE_LOG` path (untouched `head-freshness` + `head-freshness-attack.e2e`) → Task 4.
- Fixture regeneration (hard cutover) → Task 2 (pre-stage) + Task 4 Step 9 (sweep any missed).
- Changeset → Task 5.
- Out of scope (uniqueness, `getAnchoringsForDidCel`, `alsoKnownAs` `did:cel` back-link) → explicitly excluded in Global Constraints; the changeset notes the back-link belongs to the follow-up.

**Placeholder scan:** every code step carries complete code; commands carry expected outcomes. No `TODO`/`similar to`/`add validation`.

**Type consistency:** `anchoredSat: AnchoredSat | undefined` and `{ satoshi, inscriptionId }` shape preserved from the existing interface (L570-573). `signedSat` is a canonical decimal string (`String(parseSatoshiIdentifier(...))`), matching the `AnchoredSat.satoshi: string` and witness `satoshi: string` types. `data.to` is the network-scoped did:btco string produced by `btcoDidFromSatoshi` in the writer and parsed by `parseSatoshiIdentifier` in the verifier/fold — round-trip consistent.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-13-anchored-sat-identity.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration (REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`).
2. **Inline Execution** — execute tasks in this session with checkpoints (REQUIRED SUB-SKILL: `superpowers:executing-plans`).

Which approach?
