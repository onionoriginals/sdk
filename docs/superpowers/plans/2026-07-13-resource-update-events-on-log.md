# Resource-update Events on the CEL Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn post-genesis resource versions from advisory, unverifiable envelope metadata into signed `update` CEL log events, so provenance for every authorship op — not just genesis — is cryptographically verifiable offline.

**Architecture:** `OriginalsAsset.addResourceVersion` becomes async and appends a signed `'update'` CEL event (via a controller signer/appender injected by `LifecycleManager`) instead of pushing to a local `provenance.resourceUpdates` array. The verifier (`verifyEventLog`) gains a resource-update branch that checks per-`resourceId` hash continuity (seeded from genesis) and derives the new content hash inline. Hard cutover: `serialize()` stops emitting `unverified.resourceUpdates`, `loadAsset` folds versions from the verified log, and the envelope type drops the field.

**Tech Stack:** TypeScript, Bun runtime + test runner (`bun test`), `@noble/hashes` (sha256), `@noble/ed25519` / `@noble/curves` (eddsa-jcs-2022 CEL signing), multibase Multikey encoding. CEL primitives live in `packages/sdk/src/cel/`.

## Global Constraints

- **Runtime:** Bun. Run tests with `bun test <path>` from `packages/sdk/` (or repo root). `bun run build` compiles `packages/sdk/src` → `dist`.
- **Green gate:** `bun test` must be fully green at the end of every task. Never commit red.
- **Commits:** use `git commit --no-verify` (the commitlint hook binary is missing in this environment; a plain `git commit` will fail).
- **Imports:** CLAUDE.md prefers absolute-from-`src/` imports, but the CEL/lifecycle source files use **relative, `.js`-suffixed ESM specifiers** (e.g. `import { hexSha256ToDigestMultibase } from '../signerAdapter.js'`). Match the import style of the file you are editing — do NOT drop the `.js` suffix.
- **Noble hashes import style:** use `@noble/hashes/sha2.js`, never `@noble/hashes/sha256`. (Already routed through `hashResource` in `src/utils/validation.ts` — reuse that helper rather than importing sha256 directly.)
- **CEL is Ed25519-only** end-to-end; controller proofs are `eddsa-jcs-2022` DataIntegrityProofs. Never introduce JWK.
- **Branch independence:** this branch (`claude/cel-resource-update-events`, off `main`) is independent of the anchored-sat Part A work. Do not depend on or merge anything from that line.
- **Hard cutover, no back-compat:** nothing is released and there are no external consumers. Do not preserve `unverified.resourceUpdates`; regenerate any fixtures/tests that used it.

---

## File Map

**Modified source:**
- `packages/sdk/src/cel/algorithms/verifyEventLog.ts` — add the resource-update continuity/content-binding branch to the main event walk. (Task 1)
- `packages/sdk/src/lifecycle/replayProvenance.ts` — fold `resourceUpdates` out of `'update'` events. (Task 2)
- `packages/sdk/src/lifecycle/OriginalsAsset.ts` — `addResourceVersion` async + injected `#celAppender`; stop writing `provenance.resourceUpdates` locally; drop `unverified.resourceUpdates` from `serialize()`. (Tasks 3, 4)
- `packages/sdk/src/lifecycle/LifecycleManager.ts` — bind the appender in `createAsset` and `loadAsset`; fold `resourceUpdates` in `buildRestoredProvenance`. (Task 4)
- `packages/sdk/src/lifecycle/assetEnvelope.ts` — remove `unverified.resourceUpdates`. (Task 4)

**Modified/created tests:**
- `packages/sdk/tests/unit/cel/resource-update-events.test.ts` — NEW, verifier branch. (Task 1)
- `packages/sdk/tests/unit/lifecycle/replayProvenance.test.ts` — add fold coverage. (Task 2)
- `packages/sdk/tests/unit/lifecycle/ResourceVersioning.test.ts` — await + degrade rework. (Task 3)
- `packages/sdk/tests/unit/lifecycle/addResourceVersion.celevent.test.ts` — NEW, injection contract. (Task 3)
- `packages/sdk/tests/unit/lifecycle/assetEnvelope.test.ts` — drop `unverified.resourceUpdates` assertions. (Task 4)
- `packages/sdk/tests/integration/ResourceUpdateHandoff.e2e.test.ts` — NEW, honest round-trip + rotation + degrade. (Task 5)
- `.changeset/resource-update-events-on-log.md` — NEW. (Task 6)

## Design contract (read once, applies across tasks)

The signed resource-update event (produced by `addResourceVersion`, checked by `verifyEventLog`):

```
{
  type: 'update',
  data: {
    resourceId:          string,   // logical resource id (AssetResource.id)
    content:             string,   // the NEW file content, inline (AssetResource.content is a string)
    contentType:         string,
    previousVersionHash: string,   // hex sha256 of the prior version (AssetResource.hash format)
    toVersion:           number,   // new version number
  },
  previousEvent: <chain link>,
  proof: [ controllerProof ],      // eddsa-jcs-2022, current authorized controller key
}
```

- **`toHash` is NEVER stored.** It is derived as `hashResource(Buffer.from(content, 'utf-8'))` (hex) at fold/verify time. The chain digest + controller signature already cover `data`, so `content` (and therefore the derived hash) is tamper-evident.
- **Hash encodings:** `AssetResource.hash` and `previousVersionHash` are **hex sha256** (64 lowercase hex chars). Genesis resources in the log are `ExternalReference[]` carrying **`digestMultibase`** (multibase base64url multihash). The verifier converts hex → digestMultibase with `hexSha256ToDigestMultibase` (from `src/cel/signerAdapter.ts`) before comparing, and `digestMultibaseEquals` for the comparison.
- **Discriminator (no heuristic collision):** an `'update'` event is resource-shaped iff `typeof data.resourceId === 'string' && typeof data.previousVersionHash === 'string'`. Legacy/generic updates (`{ note }`) and migration-ish updates (`{ sourceDid, layer, migratedAt }`) carry neither `resourceId` nor `previousVersionHash`, so the branch skips them. Genesis resources carry no `resourceId`, so continuity for a resource's FIRST update matches against the whole genesis digest set.
- **Authority:** resource updates ride the SAME controller-authorization walk (`authorizedKeyIds`, evolving across `rotateKey`) every other post-genesis event uses. No new authority code is needed — an update signed by a non-controller or a pre-rotation key already fails the existing walk at `verifyEvent`.

---

### Task 1: Verifier — resource-update continuity + content binding

**Files:**
- Modify: `packages/sdk/src/cel/algorithms/verifyEventLog.ts` (add imports near top ~L20-23; add a helper function; wire it into the main loop ~L1293-1364; seed the genesis digest set near the create-event extraction ~L1177-1190)
- Test: `packages/sdk/tests/unit/cel/resource-update-events.test.ts` (create)

**Interfaces:**
- Consumes: `hexSha256ToDigestMultibase(hexHash: string): string` from `../signerAdapter.js`; `hashResource(content: Uint8Array): string` from `../../utils/validation.js`; existing `digestMultibaseEquals`, `verifyEventLog`.
- Produces: no new exports. `verifyEventLog` now fails closed on a resource-shaped `'update'` whose `previousVersionHash` does not chain from the last-known hash of its `resourceId` (or genesis for the first update), or whose `content` is not a string.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/tests/unit/cel/resource-update-events.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
import { hashResource } from '../../../src/utils/validation';
import { hexSha256ToDigestMultibase } from '../../../src/cel/signerAdapter';

// A real eddsa-jcs-2022 signer exposing its holder did:key + canonical VM.
// (Mirrors makeRealSigner in key-rotation-authority.test.ts.)
async function makeRealSigner() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed25519.getPublicKeyAsync(priv);
  const pubMb = multikey.encodePublicKey(pub, 'Ed25519');
  const didKey = `did:key:${pubMb}`;
  const vm = `${didKey}#${pubMb}`;
  const signer = async (data: unknown) => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2020-01-01T00:00:00Z',
    verificationMethod: vm,
    proofPurpose: 'assertionMethod',
    proofValue: multikey.encodeMultibase(
      new Uint8Array(await ed25519.signAsync(canonicalizeEvent(data), priv))
    ),
  });
  return { signer, didKey, vm };
}

const hex = (s: string) => hashResource(Buffer.from(s, 'utf-8'));

// Genesis carrying ONE resource whose content is `content`.
async function genesisWith(content: string, signer: Awaited<ReturnType<typeof makeRealSigner>>) {
  return createEventLog(
    {
      name: 'r',
      controller: signer.didKey,
      resources: [{ digestMultibase: hexSha256ToDigestMultibase(hex(content)) }],
      createdAt: 'x',
      nonce: 'n-' + Math.random(),
    },
    { signer: signer.signer, verificationMethod: signer.vm }
  );
}

describe('verifyEventLog: resource-update events', () => {
  test('honest first update (prev=genesis hash) verifies', async () => {
    const a = await makeRealSigner();
    let log = await genesisWith('v1', a);
    log = await appendEvent(
      log,
      'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('v1'), toVersion: 2 },
      { signer: a.signer, verificationMethod: a.vm }
    );
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('second update chains from the first derived hash', async () => {
    const a = await makeRealSigner();
    let log = await genesisWith('v1', a);
    log = await appendEvent(log, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('v1'), toVersion: 2 },
      { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'update',
      { resourceId: 'r', content: 'v3', contentType: 'text/plain', previousVersionHash: hex('v2'), toVersion: 3 },
      { signer: a.signer, verificationMethod: a.vm });
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('chain-continuity attack: wrong previousVersionHash is rejected', async () => {
    const a = await makeRealSigner();
    let log = await genesisWith('v1', a);
    log = await appendEvent(log, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('not-the-genesis'), toVersion: 2 },
      { signer: a.signer, verificationMethod: a.vm });
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.join(' ')).toContain('resource');
  });

  test('content-tamper: flipping content after signing breaks the proof', async () => {
    const a = await makeRealSigner();
    let log = await genesisWith('v1', a);
    log = await appendEvent(log, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('v1'), toVersion: 2 },
      { signer: a.signer, verificationMethod: a.vm });
    // Mutate the embedded content AFTER it was signed.
    (log.events[1].data as { content: string }).content = 'tampered';
    expect((await verifyEventLog(log)).verified).toBe(false);
  });

  test('unauthorized signer: an update from a non-controller is rejected', async () => {
    const a = await makeRealSigner();
    const mallory = await makeRealSigner();
    let log = await genesisWith('v1', a);
    log = await appendEvent(log, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('v1'), toVersion: 2 },
      { signer: mallory.signer, verificationMethod: mallory.vm });
    expect((await verifyEventLog(log)).verified).toBe(false);
  });

  test('no heuristic collision: generic and migration-ish updates are ignored by the branch', async () => {
    const a = await makeRealSigner();
    let log = await genesisWith('v1', a);
    log = await appendEvent(log, 'update', { note: 'generic' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'update',
      { sourceDid: 'did:cel:x', layer: 'webvh', migratedAt: 'x' },
      { signer: a.signer, verificationMethod: a.vm });
    // Neither carries resourceId+previousVersionHash, so continuity never engages.
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('authority-after-rotation: update by the NEW key verifies, by the OLD key fails', async () => {
    const a = await makeRealSigner();
    const b = await makeRealSigner();
    let base = await genesisWith('v1', a);
    base = await appendEvent(base, 'rotateKey', { newController: b.didKey, rotatedAt: 'x' },
      { signer: a.signer, verificationMethod: a.vm });

    const good = await appendEvent(base, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('v1'), toVersion: 2 },
      { signer: b.signer, verificationMethod: b.vm });
    expect((await verifyEventLog(good)).verified).toBe(true);

    const bad = await appendEvent(base, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('v1'), toVersion: 2 },
      { signer: a.signer, verificationMethod: a.vm });
    expect((await verifyEventLog(bad)).verified).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/cel/resource-update-events.test.ts`
Expected: FAIL — the chain-continuity attack test still reports `verified: true` (no branch yet rejects a mismatched `previousVersionHash`). Other tests may pass already.

- [ ] **Step 3: Add imports and the continuity helper**

In `packages/sdk/src/cel/algorithms/verifyEventLog.ts`, add to the import block (after the existing `import { deriveDidCelFromGenesis, didCelMatchesLog } from '../celDid.js';` line):

```typescript
import { hexSha256ToDigestMultibase } from '../signerAdapter.js';
import { hashResource } from '../../utils/validation.js';
```

Then add this helper function (place it just above `async function verifyEvent(` ~L858):

```typescript
/**
 * Resource-update continuity + content binding (#Phase-4 resource events).
 *
 * A resource-shaped `update` event (`data.resourceId` + `data.previousVersionHash`
 * present) MUST chain forward from the last-known hash of its resourceId:
 *  - first update for a resourceId: `previousVersionHash` must match SOME genesis
 *    resource digest (genesis ExternalReferences carry no resourceId);
 *  - subsequent updates: it must match the prior update's DERIVED hash.
 * The new current hash is `hashResource(content)` (derived, never stored). All
 * hashes are compared as digestMultibase. On success the per-resourceId map is
 * advanced; on any failure an error string is returned (fail closed) and the map
 * is left untouched.
 */
function checkResourceUpdateContinuity(
  data: { resourceId: unknown; previousVersionHash: unknown; content?: unknown },
  genesisDigests: Set<string>,
  currentResourceHash: Map<string, string>
): string | null {
  const resourceId = data.resourceId as string;
  if (typeof data.content !== 'string') {
    return `resource update for ${resourceId} has non-string content; cannot verify`;
  }
  let prevDigest: string;
  let newDigest: string;
  try {
    prevDigest = hexSha256ToDigestMultibase(data.previousVersionHash as string);
    newDigest = hexSha256ToDigestMultibase(hashResource(Buffer.from(data.content, 'utf-8')));
  } catch (e) {
    return `resource update for ${resourceId} has an unparseable hash: ${e instanceof Error ? e.message : String(e)}`;
  }

  const known = currentResourceHash.get(resourceId);
  const matches = known !== undefined
    ? digestMultibaseEquals(prevDigest, known)
    : [...genesisDigests].some((d) => digestMultibaseEquals(prevDigest, d));
  if (!matches) {
    return `resource update for ${resourceId}: previousVersionHash does not match the last-known hash (chain-continuity broken)`;
  }

  currentResourceHash.set(resourceId, newDigest);
  return null;
}
```

- [ ] **Step 4: Seed the genesis digest set and declare walk state**

In `verifyEventLog`, find the create-event extraction (`const createEvent = log.events[0];` ~L1177). Immediately AFTER the `const celController = ...` block (~L1188), add:

```typescript
  // Seed for resource-update continuity: the genesis resource digests
  // (ExternalReference.digestMultibase). A resource's FIRST update must chain
  // from one of these; subsequent updates chain from the prior derived hash.
  const genesisResourceDigests = new Set<string>();
  {
    const genesisResources = (createEvent.data as { resources?: unknown } | null | undefined)?.resources;
    if (Array.isArray(genesisResources)) {
      for (const r of genesisResources) {
        const dm = (r as { digestMultibase?: unknown })?.digestMultibase;
        if (typeof dm === 'string' && dm.length > 0) genesisResourceDigests.add(dm);
      }
    }
  }
  const currentResourceHash = new Map<string, string>();
```

- [ ] **Step 5: Wire the check into the main event walk**

In `verifyEventLog`'s event loop, find where `eventResult` is produced:

```typescript
    const eventResult = await verifyEvent(event, i, options?.verifier, previousEvent, options?.resolveKey, authorizedKeyIds, options?.ordinalsProvider, anchoredSat);
```

Immediately AFTER that line (before the `// rotateKey hand-off.` comment), insert:

```typescript
    // Resource-update continuity (default path only; a custom verifier owns
    // proof semantics). Only engage for resource-shaped updates that otherwise
    // verified — a failed proof/chain already fails the event.
    if (!options?.verifier && event.type === 'update' && eventResult.proofValid && eventResult.chainValid) {
      const rd = event.data as { resourceId?: unknown; previousVersionHash?: unknown; content?: unknown } | null;
      if (rd && typeof rd.resourceId === 'string' && typeof rd.previousVersionHash === 'string') {
        const err = checkResourceUpdateContinuity(rd, genesisResourceDigests, currentResourceHash);
        if (err) {
          eventResult.proofValid = false;
          eventResult.errors.push(`Event ${i}: ${err}`);
        }
      }
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/sdk && bun test tests/unit/cel/resource-update-events.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 7: Guard against regressions in the existing CEL verifier suite**

Run: `cd packages/sdk && bun test tests/unit/cel/verifyEventLog.test.ts tests/unit/cel/key-rotation-authority.test.ts tests/unit/cel/event-log-authorization.test.ts tests/unit/cel/updateEventLog.test.ts`
Expected: PASS (generic `{ note }` updates still verify — they lack `resourceId`).

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/cel/algorithms/verifyEventLog.ts packages/sdk/tests/unit/cel/resource-update-events.test.ts
git commit --no-verify -m "feat(cel): verify resource-update events (continuity + content binding)"
```

---

### Task 2: Fold — derive `resourceUpdates` from `update` events in `replayProvenance`

**Files:**
- Modify: `packages/sdk/src/lifecycle/replayProvenance.ts` (extend `ReplayedProvenance`; add the update-fold in the loop ~L90-127; update the header doc ~L30-31)
- Test: `packages/sdk/tests/unit/lifecycle/replayProvenance.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `hashResource` from `../utils/validation.js`.
- Produces: `ReplayedProvenance.resourceUpdates: Array<{ resourceId: string; fromVersion: number; toVersion: number; fromHash: string; toHash: string; timestamp: string; changes?: string }>` — the folded resource-version history (hex hashes, `timestamp` from the controller proof's `created`, `changes` always undefined). `buildRestoredProvenance` (Task 4) consumes this.

- [ ] **Step 1: Write the failing test**

Add to `packages/sdk/tests/unit/lifecycle/replayProvenance.test.ts` (append a new `describe` at the end, before the final closing lines if the file wraps everything; otherwise just append). It uses the same real-signer + genesis helpers as Task 1 — copy them into this file's imports/top if not already present:

```typescript
import { hashResource } from '../../../src/utils/validation';
import { hexSha256ToDigestMultibase } from '../../../src/cel/signerAdapter';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';
import * as ed25519 from '@noble/ed25519';

async function makeReplaySigner() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed25519.getPublicKeyAsync(priv);
  const pubMb = multikey.encodePublicKey(pub, 'Ed25519');
  const didKey = `did:key:${pubMb}`;
  const vm = `${didKey}#${pubMb}`;
  const signer = async (data: unknown) => ({
    type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: '2021-05-05T00:00:00Z',
    verificationMethod: vm, proofPurpose: 'assertionMethod',
    proofValue: multikey.encodeMultibase(new Uint8Array(await ed25519.signAsync(canonicalizeEvent(data), priv))),
  });
  return { signer, didKey, vm };
}
const rhex = (s: string) => hashResource(Buffer.from(s, 'utf-8'));

describe('replayProvenance: resourceUpdates fold', () => {
  test('folds update events into resourceUpdates with derived toHash', async () => {
    const a = await makeReplaySigner();
    let log = await createEventLog(
      { name: 'r', controller: a.didKey, resources: [{ digestMultibase: hexSha256ToDigestMultibase(rhex('v1')) }], createdAt: 'x', nonce: 'z1' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: rhex('v1'), toVersion: 2 },
      { signer: a.signer, verificationMethod: a.vm });

    const folded = replayProvenance(log);
    expect(folded.resourceUpdates.length).toBe(1);
    const u = folded.resourceUpdates[0];
    expect(u.resourceId).toBe('r');
    expect(u.fromVersion).toBe(1);
    expect(u.toVersion).toBe(2);
    expect(u.fromHash).toBe(rhex('v1'));
    expect(u.toHash).toBe(rhex('v2'));
    expect(u.timestamp).toBe('2021-05-05T00:00:00Z');
  });

  test('generic and migration-ish updates do NOT fold into resourceUpdates', async () => {
    const a = await makeReplaySigner();
    let log = await createEventLog(
      { name: 'r', controller: a.didKey, resources: [{ digestMultibase: hexSha256ToDigestMultibase(rhex('v1')) }], createdAt: 'x', nonce: 'z2' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'update', { note: 'generic' }, { signer: a.signer, verificationMethod: a.vm });
    expect(replayProvenance(log).resourceUpdates.length).toBe(0);
  });
});
```

(If `replayProvenance` is not already imported at the top of the file, add `import { replayProvenance } from '../../../src/lifecycle/replayProvenance';`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/replayProvenance.test.ts`
Expected: FAIL — `folded.resourceUpdates` is `undefined` (property does not exist yet).

- [ ] **Step 3: Extend the interface and fold**

In `packages/sdk/src/lifecycle/replayProvenance.ts`:

Add the import near the top (after the existing `import { btcoDidFromSatoshi } from '../cel/btcoDid.js';`):

```typescript
import { hashResource } from '../utils/validation.js';
```

Extend `ReplayedProvenance`:

```typescript
export interface ReplayedProvenance {
  currentLayer: 'did:peer' | 'did:webvh' | 'did:btco';
  bindings: Record<string, string>;
  migrations: Array<{ from: string; to: string; timestamp: string }>;
  resourceUpdates: Array<{
    resourceId: string;
    fromVersion: number;
    toVersion: number;
    fromHash: string;
    toHash: string;
    timestamp: string;
    changes?: string;
  }>;
}
```

Initialize it in the `result` literal:

```typescript
  const result: ReplayedProvenance = {
    currentLayer: 'did:peer',
    bindings: {},
    migrations: [],
    resourceUpdates: [],
  };
```

In the event loop, replace the non-migrate `continue` block. The current code is:

```typescript
    if (event.type !== 'migrate') {
      // transfer (legacy) / rotateKey / update / deactivate: not provenance.
      // Ownership history is the sat's UTXO chain, not the CEL.
      continue;
    }
```

Replace it with:

```typescript
    if (event.type === 'update') {
      // Resource-update events (resourceId + previousVersionHash) fold into the
      // resource-version history. toHash is DERIVED from inline content, never
      // stored. Generic/migration-ish updates lack these fields and are skipped.
      const resourceId = typeof data.resourceId === 'string' ? data.resourceId : undefined;
      const previousVersionHash = typeof data.previousVersionHash === 'string' ? data.previousVersionHash : undefined;
      const content = typeof data.content === 'string' ? data.content : undefined;
      if (resourceId && previousVersionHash && content !== undefined) {
        const toVersion = typeof data.toVersion === 'number' ? data.toVersion : NaN;
        const proofs = event.proof as ReadonlyArray<{ created?: unknown; witnessedAt?: unknown }> | undefined;
        const controllerProof = proofs?.find((p) => !(p && typeof p === 'object' && 'witnessedAt' in p));
        const timestamp = typeof controllerProof?.created === 'string' ? controllerProof.created : '';
        result.resourceUpdates.push({
          resourceId,
          fromVersion: Number.isFinite(toVersion) ? toVersion - 1 : NaN,
          toVersion,
          fromHash: previousVersionHash,
          toHash: hashResource(Buffer.from(content, 'utf-8')),
          timestamp,
        });
      }
      continue;
    }

    if (event.type !== 'migrate') {
      // transfer (legacy) / rotateKey / deactivate: not provenance.
      // Ownership history is the sat's UTXO chain, not the CEL.
      continue;
    }
```

Also update the header doc bullet (~L30) from `rotateKey / update / deactivate → no provenance entries` to note that resource-shaped `update` events now fold into `resourceUpdates`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/replayProvenance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/lifecycle/replayProvenance.ts packages/sdk/tests/unit/lifecycle/replayProvenance.test.ts
git commit --no-verify -m "feat(lifecycle): fold resourceUpdates from update events in replayProvenance"
```

---

### Task 3: Writer — `addResourceVersion` async + injected controller appender

**Files:**
- Modify: `packages/sdk/src/lifecycle/OriginalsAsset.ts` (add `#celAppender` field + `_bindCelAppender`; make `addResourceVersion` async ~L549-653; stop writing `provenance.resourceUpdates` locally, fold it instead)
- Modify: `packages/sdk/tests/unit/lifecycle/ResourceVersioning.test.ts` (await all `addResourceVersion` calls; rework the provenance-tracking test into a degrade assertion)
- Test: `packages/sdk/tests/unit/lifecycle/addResourceVersion.celevent.test.ts` (create — injection contract)

**Interfaces:**
- Consumes: `replayProvenance` (already imported in OriginalsAsset); the appender contract `(type: 'migrate' | 'rotateKey' | 'update', data: unknown) => Promise<string | null>` (returns the appended event's head digest, or `null` when the append was skipped/degraded).
- Produces:
  - `OriginalsAsset._bindCelAppender(fn: (type: 'migrate' | 'rotateKey' | 'update', data: unknown) => Promise<string | null>): void` — `@internal`, called by `LifecycleManager` (Task 4).
  - `OriginalsAsset.addResourceVersion(resourceId, newContent, contentType, changes?): Promise<AssetResource>` — now async.

- [ ] **Step 1: Write the failing test (injection contract)**

Create `packages/sdk/tests/unit/lifecycle/addResourceVersion.celevent.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { OriginalsAsset } from '../../../src/lifecycle/OriginalsAsset';
import type { AssetResource, DIDDocument } from '../../../src/types';
import type { CelAppendSkippedEvent } from '../../../src/events/types';

function makeAsset(): OriginalsAsset {
  const did: DIDDocument = { id: 'did:peer:zabc' } as DIDDocument;
  const resources: AssetResource[] = [
    { id: 'r', type: 'text', content: 'v1', contentType: 'text/plain', hash: '', version: 1 } as AssetResource,
  ];
  // Fix the hash to match content so continuity checks elsewhere line up.
  const { hashResource } = require('../../../src/utils/validation');
  resources[0].hash = hashResource(Buffer.from('v1', 'utf-8'));
  return new OriginalsAsset(resources, did, []);
}

describe('addResourceVersion: injected CEL appender', () => {
  test('calls the bound appender with the resource-update body and updates resources', async () => {
    const asset = makeAsset();
    const calls: Array<{ type: string; data: any }> = [];
    asset._bindCelAppender(async (type, data) => {
      calls.push({ type, data });
      return 'zHeadDigest'; // pretend the append committed
    });

    const created = await asset.addResourceVersion('r', 'v2', 'text/plain', 'edit');

    expect(created.version).toBe(2);
    expect(calls.length).toBe(1);
    expect(calls[0].type).toBe('update');
    expect(calls[0].data.resourceId).toBe('r');
    expect(calls[0].data.content).toBe('v2');
    expect(calls[0].data.contentType).toBe('text/plain');
    expect(typeof calls[0].data.previousVersionHash).toBe('string');
    expect(calls[0].data.toVersion).toBe(2);
    // In-memory resources updated.
    expect(asset.getResourceVersion('r', 2)?.content).toBe('v2');
  });

  test('degrades: no appender bound emits cel:append-skipped and does NOT record provenance', async () => {
    const asset = makeAsset();
    const skipped: CelAppendSkippedEvent[] = [];
    asset.on('cel:append-skipped', (e) => skipped.push(e as CelAppendSkippedEvent));

    const created = await asset.addResourceVersion('r', 'v2', 'text/plain');

    expect(created.version).toBe(2);                       // in-memory still versioned
    expect(asset.getProvenance().resourceUpdates.length).toBe(0); // not provable
    expect(skipped.length).toBe(1);
  });

  test('appender returning null (skip) updates resources but not provenance', async () => {
    const asset = makeAsset();
    asset._bindCelAppender(async () => null); // signer unavailable
    await asset.addResourceVersion('r', 'v2', 'text/plain');
    expect(asset.getResourceVersion('r', 2)?.content).toBe('v2');
    expect(asset.getProvenance().resourceUpdates.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/addResourceVersion.celevent.test.ts`
Expected: FAIL — `asset._bindCelAppender is not a function` (and `addResourceVersion` is still sync).

- [ ] **Step 3: Add the appender field and setter**

In `packages/sdk/src/lifecycle/OriginalsAsset.ts`, add a private field near the other private fields (after `#didDocuments` ~L68):

```typescript
  // Injected by LifecycleManager (createAsset / loadAsset). Appends a signed CEL
  // event via the manager's degrade-aware path and returns the new head digest,
  // or null when the append was skipped (no keyStore / no signing key). Undefined
  // for assets constructed outside the lifecycle (they degrade in-memory only).
  #celAppender?: (type: 'migrate' | 'rotateKey' | 'update', data: unknown) => Promise<string | null>;
```

Add the setter (place it near `_replaceCelLog` ~L162):

```typescript
  /**
   * @internal — LifecycleManager binds the controller append path so
   * addResourceVersion can write signed `update` events with the same degrade
   * contract (cel:append-skipped) as the other authorship ops.
   */
  _bindCelAppender(
    fn: (type: 'migrate' | 'rotateKey' | 'update', data: unknown) => Promise<string | null>
  ): void {
    this.#celAppender = fn;
  }
```

- [ ] **Step 4: Rewrite `addResourceVersion` as async, appending the signed event**

Replace the whole `addResourceVersion(...)` method (~L549-653) with:

```typescript
  /**
   * Add a new version of a resource (immutable versioning) as a signed CEL
   * `update` event.
   *
   * Async: the new version is appended to the CEL log via the injected
   * controller appender (bound by LifecycleManager). On success the in-memory
   * resources advance and `provenance.resourceUpdates` is re-folded from the log.
   * Degraded mode (no appender bound, or the appender skips because no signing
   * key is available): the in-memory resources still advance so the object is
   * usable, but NO event is appended (the version is not provable) and a
   * `cel:append-skipped` is emitted.
   *
   * `changes` is retained for the emitted `resource:version:created` event only;
   * it is NOT part of the signed CEL body (the log is the source of truth and its
   * body is fixed — see the design contract).
   *
   * @throws StructuredError('BINARY_CONTENT_UNSUPPORTED') for Buffer content (#276)
   * @throws Error if content is unchanged or the resource is not found
   */
  async addResourceVersion(
    resourceId: string,
    newContent: string,
    contentType: string,
    changes?: string
  ): Promise<AssetResource> {
    if (typeof newContent !== 'string') {
      throw new StructuredError(
        'BINARY_CONTENT_UNSUPPORTED',
        'addResourceVersion cannot store binary (Buffer) content inline: AssetResource.content is a string. ' +
        'Encode the content as a string (e.g. base64) and handle decoding at publish time, ' +
        'or host the bytes externally and reference them by hash.'
      );
    }
    const currentResources = this.resources.filter(r => r.id === resourceId);
    if (currentResources.length === 0) {
      throw new Error(`Resource with id ${resourceId} not found`);
    }
    const currentResource = currentResources.sort((a, b) => {
      const versionA = a.version || 1;
      const versionB = b.version || 1;
      return versionB - versionA;
    })[0];

    const contentBuffer = Buffer.from(newContent, 'utf-8');
    const newHash = hashResource(contentBuffer);
    if (newHash === currentResource.hash) {
      throw new Error('Content unchanged - new version would be identical to current version');
    }

    const newVersion = (currentResource.version || 1) + 1;
    const newResource: AssetResource = {
      id: resourceId,
      type: currentResource.type,
      content: newContent,
      contentType,
      hash: newHash,
      size: contentBuffer.length,
      version: newVersion,
      previousVersionHash: currentResource.hash,
      createdAt: new Date().toISOString()
    };

    // Append a signed `update` CEL event (or degrade). The body is the fixed
    // resource-update shape; toHash is derived at verify/fold time.
    let appended = false;
    if (this.#celAppender) {
      const digest = await this.#celAppender('update', {
        resourceId,
        content: newContent,
        contentType,
        previousVersionHash: currentResource.hash,
        toVersion: newVersion
      });
      appended = digest !== null; // null ⇒ the manager already emitted cel:append-skipped
    } else {
      // No manager bound: degrade in-memory only. Surface the honesty signal on
      // the asset emitter (the manager path uses its own emitter).
      await this.eventEmitter.emit({
        type: 'cel:append-skipped',
        timestamp: new Date().toISOString(),
        asset: { id: this.id },
        reason: this.#celLog ? 'NO_SIGNING_KEY' : 'NO_CEL_LOG'
      });
    }

    // In-memory resources advance in BOTH the appended and degraded cases.
    this.resources.push(newResource);
    this.versionManager.addVersion(
      resourceId,
      newHash,
      contentType,
      currentResource.hash,
      changes,
      newVersion
    );

    // Provenance.resourceUpdates is the source-of-truth fold of the log — only
    // populated when the event actually landed (provable). Re-fold from the log.
    if (appended && this.#celLog) {
      this.provenance.resourceUpdates = replayProvenance(this.#celLog).resourceUpdates;
    }

    const timestamp = new Date().toISOString();
    const event = {
      type: 'resource:version:created' as const,
      timestamp,
      asset: { id: this.id },
      resource: {
        id: resourceId,
        fromVersion: currentResource.version || 1,
        toVersion: newVersion,
        fromHash: currentResource.hash,
        toHash: newHash
      },
      changes
    };
    queueMicrotask(() => {
      void this.eventEmitter.emit(event);
    });

    return newResource;
  }
```

- [ ] **Step 5: Run the injection test to verify it passes**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/addResourceVersion.celevent.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Update the existing ResourceVersioning test suite (await + degrade rework)**

In `packages/sdk/tests/unit/lifecycle/ResourceVersioning.test.ts`:

1. Add `await` to every `asset.addResourceVersion(...)` call, and make each enclosing `test(...)` callback `async` if it is not already. (Lines ~169, 196, 214, 230-231, 252, 273-274, 308, 336-337, 374, 397, 415, 433, 451, 475-477, 500.) The rejection tests at ~196 and ~214 use `expect(() => ...).toThrow(...)`; convert them to `await expect(asset.addResourceVersion(...)).rejects.toThrow(...)`. The Buffer-rejection test at ~397 similarly becomes `await expect(asset.addResourceVersion('res1', buffer2 as unknown as string, 'application/octet-stream')).rejects.toThrow(...)`.

2. Rework the provenance-tracking test (~L332-352, "tracks resourceUpdates in provenance"). A directly-constructed asset has no bound appender, so it degrades and records NO provenance. Replace that test body with a degrade assertion:

```typescript
  test('directly-constructed asset degrades: no appender ⇒ no provenance, emits cel:append-skipped', async () => {
    const asset = createTestAsset(); // whatever the file's existing factory is named
    const skipped: unknown[] = [];
    asset.on('cel:append-skipped', (e) => skipped.push(e));

    await asset.addResourceVersion('res1', 'v2', 'text/plain', 'First update');
    await asset.addResourceVersion('res1', 'v3', 'text/plain', 'Second update');

    // In-memory versions advanced, but nothing provable was recorded.
    expect(asset.getAllVersions('res1').map(r => r.version)).toEqual([1, 2, 3]);
    expect(asset.getProvenance().resourceUpdates.length).toBe(0);
    expect(skipped.length).toBe(2);
  });
```

(Use the same asset-construction helper the surrounding tests use; if they build inline via `new OriginalsAsset(...)`, replicate that here. The folded-provenance behavior is covered end-to-end in Task 5, where a real lifecycle asset with a keyStore signs the events.)

- [ ] **Step 7: Run the full lifecycle unit suite**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/ResourceVersioning.test.ts tests/unit/lifecycle/addResourceVersion.celevent.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/lifecycle/OriginalsAsset.ts packages/sdk/tests/unit/lifecycle/ResourceVersioning.test.ts packages/sdk/tests/unit/lifecycle/addResourceVersion.celevent.test.ts
git commit --no-verify -m "feat(lifecycle): addResourceVersion appends signed update CEL events (async)"
```

---

### Task 4: Hard cutover — bind the appender, drop `unverified.resourceUpdates`

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` (bind appender in `createAsset` ~L323 and `loadAsset` ~L608-614; fold `resourceUpdates` in `buildRestoredProvenance` ~L741)
- Modify: `packages/sdk/src/lifecycle/OriginalsAsset.ts` (`serialize()` — remove the `unverified.resourceUpdates` emit ~L222-224)
- Modify: `packages/sdk/src/lifecycle/assetEnvelope.ts` (remove `unverified.resourceUpdates` field ~L38-46)
- Modify: `packages/sdk/tests/unit/lifecycle/assetEnvelope.test.ts` (drop the `unverified.resourceUpdates` roundtrip assertion ~L81; await the `addResourceVersion` at ~L50)

**Interfaces:**
- Consumes: `OriginalsAsset._bindCelAppender` (Task 3); `LifecycleManager.appendCelEventOrSkip(asset, type, data): Promise<string | null>` (existing private, ~L1793 — already accepts `'update'`); `replayProvenance(...).resourceUpdates` (Task 2).
- Produces: assets returned by `createAsset` / `loadAsset` carry a bound appender, so `addResourceVersion` on them writes signed events. `AssetEnvelope.unverified` no longer has a `resourceUpdates` field.

- [ ] **Step 1: Write the failing test (envelope cutover + folded provenance)**

Add to `packages/sdk/tests/unit/lifecycle/assetEnvelope.test.ts` a new test (alongside the existing ones), and fix the existing one:

New test:

```typescript
  test('serialize no longer emits unverified.resourceUpdates; loadAsset folds versions from the log', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'hello v1', contentType: 'text/plain', hash: require('../../../src/utils/validation').hashResource(Buffer.from('hello v1', 'utf-8')) }
    ]);
    await asset.addResourceVersion('note', 'hello v2', 'text/plain', 'edit');

    const env = asset.serialize();
    // Cutover: the advisory array is gone.
    expect((env.unverified as any)?.resourceUpdates).toBeUndefined();
    // The update event is on the log.
    expect(env.eventLog.events.some(e => e.type === 'update')).toBe(true);
    // A fresh SDK (no keys) loads and the folded provenance shows the version.
    const fresh = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const { asset: loaded } = await fresh.lifecycle.loadAsset(env);
    expect(loaded.getProvenance().resourceUpdates.some(u => u.resourceId === 'note' && u.toVersion === 2)).toBe(true);
  });
```

Fix the existing test at ~L50/L81: add `await` to `asset.addResourceVersion('note', ...)`, and DELETE the assertion `expect(env.unverified?.resourceUpdates?.some(...)).toBe(true);` (the field no longer exists — this is the hard cutover).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/assetEnvelope.test.ts`
Expected: FAIL — `createAsset`-minted assets have no appender bound yet, so `addResourceVersion` degrades (`update` event absent from the log), and `loaded.getProvenance().resourceUpdates` is empty.

- [ ] **Step 3: Bind the appender in `createAsset`**

In `LifecycleManager.ts`, find `const asset = new OriginalsAsset(resources, didDoc, [], log);` (~L323). Immediately after it, add:

```typescript
    // Bind the controller append path so addResourceVersion can write signed
    // `update` events with the same degrade contract as the other authorship ops.
    asset._bindCelAppender((type, data) => this.appendCelEventOrSkip(asset, type, data));
```

- [ ] **Step 4: Bind the appender in `loadAsset`**

In `LifecycleManager.ts` `loadAsset`, find `const asset = OriginalsAsset.restore(...)` (~L608-614). Immediately after that statement (before the `// Repopulate captured DID docs` loop ~L616), add:

```typescript
    asset._bindCelAppender((type, data) => this.appendCelEventOrSkip(asset, type, data));
```

- [ ] **Step 5: Fold `resourceUpdates` in `buildRestoredProvenance`**

In `LifecycleManager.ts` `buildRestoredProvenance` (~L741), replace:

```typescript
    const resourceUpdates = (env.unverified?.resourceUpdates ?? []).map(u => ({ ...u }));
```

with:

```typescript
    // Resource versions are now signed `update` log events — fold them from the
    // (verified) log, never from the advisory envelope section (removed).
    const resourceUpdates = folded.resourceUpdates.map(u => ({ ...u }));
```

- [ ] **Step 6: Remove the `serialize()` emit and the envelope field**

In `OriginalsAsset.ts` `serialize()` (~L222-224), delete:

```typescript
    if (this.provenance.resourceUpdates.length > 0) {
      unverified.resourceUpdates = this.provenance.resourceUpdates.map(u => ({ ...u }));
    }
```

In `assetEnvelope.ts`, delete the `resourceUpdates?: Array<...>` block from the `unverified` object (~L38-46), leaving `commitTxId`, `feeRate`, and `bindings`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd packages/sdk && bun test tests/unit/lifecycle/assetEnvelope.test.ts`
Expected: PASS.

- [ ] **Step 8: Full regression sweep of lifecycle + cel**

Run: `cd packages/sdk && bun test tests/unit/lifecycle tests/unit/cel`
Expected: PASS. (If any other test referenced `unverified.resourceUpdates`, update it to the hard-cutover behavior — the field is gone.)

- [ ] **Step 9: Commit**

```bash
git add packages/sdk/src/lifecycle/LifecycleManager.ts packages/sdk/src/lifecycle/OriginalsAsset.ts packages/sdk/src/lifecycle/assetEnvelope.ts packages/sdk/tests/unit/lifecycle/assetEnvelope.test.ts
git commit --no-verify -m "feat(lifecycle): hard cutover to on-log resource updates; drop unverified.resourceUpdates"
```

---

### Task 5: End-to-end — honest round-trip, rotation authority, degrade

**Files:**
- Test: `packages/sdk/tests/integration/ResourceUpdateHandoff.e2e.test.ts` (create)

**Interfaces:**
- Consumes: `OriginalsSDK.create`, `MockKeyStore`, `sdk.lifecycle.createAsset/loadAsset/rotateBtcoKeys`, `asset.addResourceVersion/serialize/verify`. No production changes — this task only proves the spec's testing spine end-to-end.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/tests/integration/ResourceUpdateHandoff.e2e.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { hashResource } from '../../src/utils/validation';
import type { CelAppendSkippedEvent } from '../../src/events/types';

const h = (s: string) => hashResource(Buffer.from(s, 'utf-8'));

describe('Resource-update handoff (e2e)', () => {
  test('honest round-trip: creator updates, buyer verifies offline with no keys', async () => {
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const asset = await creator.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
    ]);
    await asset.addResourceVersion('note', 'v2', 'text/plain', 'edit');

    // The signed update landed on the log.
    expect(asset.celLog!.events.some(e => e.type === 'update')).toBe(true);

    const envelope = asset.serialize();

    // Buyer loads with a FRESH, keyless SDK — verification is public-key-only.
    const buyer = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const { asset: loaded, verification } = await buyer.lifecycle.loadAsset(envelope);
    expect(verification?.verified).toBe(true);
    // The folded current resource is v2.
    expect(loaded.getResourceVersion('note', 2)?.content).toBe('v2');
    expect(loaded.getProvenance().resourceUpdates.some(u => u.toVersion === 2)).toBe(true);
  });

  test('content-tamper in the envelope is rejected at load', async () => {
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const asset = await creator.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
    ]);
    await asset.addResourceVersion('note', 'v2', 'text/plain');
    const envelope = asset.serialize();

    // Flip the embedded content of the update event.
    const updateEv = envelope.eventLog.events.find(e => e.type === 'update')!;
    (updateEv.data as { content: string }).content = 'tampered';

    const buyer = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    await expect(buyer.lifecycle.loadAsset(envelope)).rejects.toThrow();
  });

  test('degrade: keyless creator emits cel:append-skipped and the update is not on the log', async () => {
    // No keyStore ⇒ createAsset drops the controller key ⇒ appends degrade.
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519' });
    const asset = await creator.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
    ]);
    const skipped: CelAppendSkippedEvent[] = [];
    creator.lifecycle.on('cel:append-skipped', (e) => skipped.push(e as CelAppendSkippedEvent));

    await asset.addResourceVersion('note', 'v2', 'text/plain');

    expect(asset.getResourceVersion('note', 2)?.content).toBe('v2'); // usable in-memory
    expect(asset.celLog!.events.some(e => e.type === 'update')).toBe(false); // not provable
    expect(skipped.length).toBe(1);
    expect(asset.getProvenance().resourceUpdates.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd packages/sdk && bun test tests/integration/ResourceUpdateHandoff.e2e.test.ts`
Expected: PASS. (If the honest round-trip fails at load verification, confirm Task 4 bound the appender in BOTH `createAsset` and `loadAsset`, and that the `update` event is present in `asset.celLog`.)

- [ ] **Step 3: Full suite sweep**

Run: `cd packages/sdk && bun test`
Expected: PASS across integration, unit, security, stress. Investigate and fix any test that assumed the old advisory `resourceUpdates` (hard cutover).

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/tests/integration/ResourceUpdateHandoff.e2e.test.ts
git commit --no-verify -m "test(lifecycle): e2e resource-update handoff (round-trip, tamper, degrade)"
```

---

### Task 6: Changeset

**Files:**
- Create: `.changeset/resource-update-events-on-log.md`

**Interfaces:** none.

- [ ] **Step 1: Write the changeset**

Create `.changeset/resource-update-events-on-log.md` (match the frontmatter style of existing changesets, e.g. `.changeset/ownership-is-the-sat.md`):

```markdown
---
"@originals/sdk": minor
---

Resource versions are now signed CEL `update` log events instead of advisory
envelope metadata. `OriginalsAsset.addResourceVersion` is now **async** and
appends a signed `update` event (via a controller signer bound by
`LifecycleManager`), degrading with `cel:append-skipped` when no signing key is
available. `verifyEventLog` gains a resource-update branch that checks
per-resourceId hash continuity (seeded from genesis) and derives the new content
hash inline, so a buyer can verify every post-genesis version offline.

**BREAKING:** `addResourceVersion` returns a `Promise<AssetResource>` (await it),
and the advisory `AssetEnvelope.unverified.resourceUpdates` field is removed —
`serialize()` no longer emits it and `loadAsset` folds resource versions from the
verified log. Regenerate any persisted envelopes that carried it.
```

- [ ] **Step 2: Verify the changeset is picked up**

Run: `cd /Users/brian/Projects/onionoriginals/sdk/.claude/worktrees/phase4-ownership-is-sat && ls .changeset/resource-update-events-on-log.md`
Expected: the path prints (file exists). The repo's "Changeset present" gate is satisfied.

- [ ] **Step 3: Commit**

```bash
git add .changeset/resource-update-events-on-log.md
git commit --no-verify -m "chore: changeset for on-log resource-update events"
```

---

## Self-Review

**Spec coverage:**
- §2 signed `update` model (resourceId/content/contentType/previousVersionHash/toVersion; derived toHash) → Task 1 (verify) + Task 3 (write).
- §3 async writer + injected signer + degrade → Task 3 + Task 4 (binding).
- §4 verifier continuity/content-binding/authority (per-resourceId map seeded from genesis; current-controller authority via existing walk) → Task 1.
- §5 fold + envelope hard cutover (`replayProvenance` derives; `serialize()` stops emitting; `loadAsset` folds; envelope field removed) → Task 2 + Task 4.
- §6 unchanged (did:cel derivation, genesis binding, legacy `update` uses) → discriminator in Task 1; genesis binding untouched.
- §7 testing spine (honest round-trip, chain-continuity, content-tamper, unauthorized signer, degrade, no heuristic collision, authority-after-rotation) → Tasks 1 + 5.
- Changeset → Task 6.

**Type consistency:** the appender contract `(type: 'migrate'|'rotateKey'|'update', data: unknown) => Promise<string | null>` matches `LifecycleManager.appendCelEventOrSkip`'s existing signature. `ReplayedProvenance.resourceUpdates` (Task 2) matches the fields `buildRestoredProvenance` maps (Task 4) and the `ProvenanceChain.resourceUpdates` shape in `OriginalsAsset.ts`. Hashes: hex on `AssetResource.hash`/`previousVersionHash`/fold output; digestMultibase only inside the verifier comparison (converted via `hexSha256ToDigestMultibase`).

**Known residual:** the folded `resourceUpdates.timestamp` derives from the controller proof's (unsigned) `created` field and `changes` is dropped from the signed body — both are advisory display metadata at the same trust level as the removed `unverified.resourceUpdates`, never gating verification.
