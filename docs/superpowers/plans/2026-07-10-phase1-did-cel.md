# Phase 1: did:cel Genesis Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `did:cel` — a genesis DID derived from the hash of the CEL create event — plus first-class `migrate`/`transfer`/`rotateKey` event types and an evolving-authority verifier, per the design spec `docs/superpowers/specs/2026-07-10-cel-backbone-did-cel-design.md` §2 and §7 Phase 1.

**Architecture:** The DID is `did:cel:<digestMultibase(canonicalizeEntryForChain(genesisEvent))>` — the exact chain-digest expression already used for `previousEvent` links, so the log's second event's `previousEvent` equals the DID suffix by construction. The genesis event stops embedding the asset DID (it can't — the DID is derived FROM the event); it carries the holder's `controller` key DID instead, separating asset identity from holder identity. `verifyEventLog`'s authority set becomes evolving: `rotateKey` events REPLACE the authorized key set (hand-off semantics). Back-compat: dual-accept on read/verify (legacy `data.did` logs still verify), new-shape-only on write.

**Tech Stack:** TypeScript, Bun, existing CEL subsystem (`src/cel/` — W3C CCG CEL profile, `eddsa-jcs-2022`).

## Global Constraints

- Run tests from `packages/sdk/` with `bun test`. Never import `tests/setup.bun.ts`.
- Relative imports with `.js` extension inside src. Errors: match each file's existing style (`src/cel` mostly uses plain `Error`).
- Multibase Multikey / did:key only for holder keys — never JWK.
- **Verification must remain fail-closed**: any change to `verifyEventLog` that cannot positively authorize an event must fail it. Never weaken an existing check.
- **Legacy logs keep verifying**: existing did:peer-shaped logs (`data.did` present) must pass verification unchanged. The adversarial suites (`tests/unit/cel/event-log-authorization.test.ts`, `hash-chain-tamper.test.ts`, `proof-verification.test.ts`, `tests/security/critical-high-fix-regressions.test.ts`) are the guard — they may be RENAMED/reframed as legacy-log tests but their assertions must keep passing (except where a task explicitly rewrites a test to the new write-shape; never delete an adversarial case without an equivalent).
- Write path emits ONLY the new shapes (no dual-write, no flags).
- Commit per task with `git commit --no-verify` (commitlint binary missing), conventional message, exact trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch: `worktree-phase1-did-cel` (stacked on Phase 0 / PR #383).
- Baseline: full suite 3737 pass / 0 fail (CEL-CLI subprocess tests occasionally flaky).
- Line anchors below were verified against this branch; if drifted, locate by the quoted code.

---

### Task 1: `celDid.ts` — did:cel derivation helpers

**Files:**
- Create: `packages/sdk/src/cel/celDid.ts`
- Modify: `packages/sdk/src/cel/index.ts` (export), `packages/sdk/src/index.ts` (re-export next to the btcoDid exports)
- Create: `packages/sdk/tests/unit/cel/celDid.test.ts`

**Interfaces:**
- Consumes: `computeDigestMultibase` (`src/cel/hash.ts:34`), `canonicalizeEntryForChain` (`src/cel/canonicalize.ts:91`), `digestMultibaseEquals` (`src/cel/hash.ts:86`), types `EventLog`/`LogEntry`.
- Produces (later tasks depend on these exact names):
  - `DID_CEL_PREFIX = 'did:cel:'`
  - `deriveDidCel(log: EventLog): string` — throws on empty log or non-`create` first event
  - `deriveDidCelFromGenesis(genesis: LogEntry): string` — throws unless `genesis.type === 'create'`
  - `isDidCel(did: string): boolean`
  - `didCelMatchesLog(did: string, log: EventLog): boolean` — suffix comparison via `digestMultibaseEquals`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sdk/tests/unit/cel/celDid.test.ts
import { describe, test, expect } from 'bun:test';
import { deriveDidCel, deriveDidCelFromGenesis, isDidCel, didCelMatchesLog, DID_CEL_PREFIX } from '../../../src/cel/celDid';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
import type { DataIntegrityProof } from '../../../src/cel/types';

const fakeSigner = async (_data: unknown): Promise<DataIntegrityProof> => ({
  type: 'DataIntegrityProof',
  cryptosuite: 'eddsa-jcs-2022',
  created: '2026-07-10T00:00:00Z',
  verificationMethod: 'did:key:z6MkfakeSigner#z6MkfakeSigner',
  proofPurpose: 'assertionMethod',
  proofValue: 'zFakeSig'
});

async function makeLog() {
  return createEventLog(
    { name: 'A', controller: 'did:key:z6MkfakeSigner', resources: [], createdAt: '2026-07-10T00:00:00Z', nonce: 'u9zzz' },
    { signer: fakeSigner, verificationMethod: 'did:key:z6MkfakeSigner#z6MkfakeSigner' }
  );
}

describe('did:cel derivation', () => {
  test('derives a stable did:cel with multihash-multibase suffix', async () => {
    const log = await makeLog();
    const did = deriveDidCel(log);
    expect(did.startsWith(DID_CEL_PREFIX)).toBe(true);
    expect(did.slice(DID_CEL_PREFIX.length).startsWith('u')).toBe(true); // base64url multibase
    expect(deriveDidCel(log)).toBe(did); // deterministic
    expect(deriveDidCelFromGenesis(log.events[0])).toBe(did);
  });

  test('INVARIANT: second event previousEvent equals the DID suffix', async () => {
    const log = await makeLog();
    const did = deriveDidCel(log);
    const updated = await updateEventLog(log, { note: 'x' }, {
      signer: fakeSigner, verificationMethod: 'did:key:z6MkfakeSigner#z6MkfakeSigner'
    });
    expect(updated.events[1].previousEvent).toBe(did.slice(DID_CEL_PREFIX.length));
    expect(didCelMatchesLog(did, updated)).toBe(true);
  });

  test('proof does not affect the DID (proof excluded from digest)', async () => {
    const log = await makeLog();
    const mutated = { ...log, events: [{ ...log.events[0], proof: [{ ...log.events[0].proof[0], proofValue: 'zDifferent' }] }] };
    expect(deriveDidCel(mutated as never)).toBe(deriveDidCel(log));
  });

  test('rejects empty logs and non-create genesis; isDidCel discriminates', async () => {
    expect(() => deriveDidCel({ events: [] })).toThrow(/empty/i);
    const log = await makeLog();
    const badGenesis = { ...log.events[0], type: 'update' as const };
    expect(() => deriveDidCelFromGenesis(badGenesis)).toThrow(/create/i);
    expect(isDidCel('did:cel:uEiAabc')).toBe(true);
    expect(isDidCel('did:peer:4zQm')).toBe(false);
    expect(didCelMatchesLog('did:cel:uEiAwrong', log)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/cel/celDid.test.ts`
Expected: FAIL — module `src/cel/celDid` not found.

- [ ] **Step 3: Implement**

```typescript
// packages/sdk/src/cel/celDid.ts
/**
 * did:cel — genesis identity derived from the CEL create event.
 *
 * did:cel:<digestMultibase(canonicalizeEntryForChain(genesisEvent))>
 *
 * Reuses the exact chain-link digest (proof excluded, {type,data} preimage
 * for a first event), so a log's second event's `previousEvent` equals the
 * DID suffix by construction. The genesis event must NOT embed the asset
 * DID (it is derived from the event); the holder's key lives in
 * `data.controller` instead.
 */
import type { EventLog, LogEntry } from './types.js';
import { computeDigestMultibase, digestMultibaseEquals } from './hash.js';
import { canonicalizeEntryForChain } from './canonicalize.js';

export const DID_CEL_PREFIX = 'did:cel:';

export function deriveDidCelFromGenesis(genesis: LogEntry): string {
  if (genesis.type !== 'create') {
    throw new Error('did:cel derives from a create event; got ' + String(genesis.type));
  }
  return DID_CEL_PREFIX + computeDigestMultibase(canonicalizeEntryForChain(genesis));
}

export function deriveDidCel(log: EventLog): string {
  if (!log.events || log.events.length === 0) {
    throw new Error('Cannot derive did:cel from an empty event log');
  }
  return deriveDidCelFromGenesis(log.events[0]);
}

export function isDidCel(did: string): boolean {
  return typeof did === 'string' && did.startsWith(DID_CEL_PREFIX);
}

/** Suffix comparison via digestMultibaseEquals (tolerates legacy bare digests). */
export function didCelMatchesLog(did: string, log: EventLog): boolean {
  if (!isDidCel(did) || !log.events || log.events.length === 0) return false;
  const expected = computeDigestMultibase(canonicalizeEntryForChain(log.events[0]));
  return digestMultibaseEquals(did.slice(DID_CEL_PREFIX.length), expected);
}
```

Exports: in `src/cel/index.ts` add `export { DID_CEL_PREFIX, deriveDidCel, deriveDidCelFromGenesis, isDidCel, didCelMatchesLog } from './celDid.js';` and mirror in `src/index.ts` next to the existing cel exports (~line 218).

- [ ] **Step 4: Run tests**

Run: `cd packages/sdk && bun test tests/unit/cel/celDid.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src packages/sdk/tests/unit/cel/celDid.test.ts
git commit --no-verify -m "feat(cel): did:cel derivation helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Event vocabulary — `migrate` | `transfer` | `rotateKey` in types + parsers

**Files:**
- Modify: `packages/sdk/src/cel/types.ts:37` (`EventType`)
- Modify: `packages/sdk/src/cel/serialization/json.ts:134` (type whitelist in `parseEntry`)
- Modify: `packages/sdk/src/cel/serialization/cbor.ts:85` (identical whitelist)
- Test: extend `packages/sdk/tests/unit/cel/cbor-serialization.test.ts` and the JSON serialization test file (locate: `grep -rl "parseEventLogJson" packages/sdk/tests/unit/cel | head -3`)

**Interfaces:**
- Produces: `export type EventType = 'create' | 'update' | 'deactivate' | 'migrate' | 'transfer' | 'rotateKey';` — Tasks 3–8 depend on these exact literals.

- [ ] **Step 1: Write the failing tests**

Add to the JSON serialization test file (adapt imports to that file's existing style):

```typescript
  test('round-trips migrate/transfer/rotateKey event types', () => {
    const log = {
      events: [
        { type: 'create', data: { name: 'A' }, proof: [{ type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: 'x', verificationMethod: 'did:key:z6Mk#z6Mk', proofPurpose: 'assertionMethod', proofValue: 'z1' }] },
        { type: 'migrate', data: { sourceDid: 'did:cel:uEiA', targetDid: 'did:webvh:x:example.com:a', layer: 'webvh', migratedAt: 'x' }, previousEvent: 'uEiB', proof: [{ type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: 'x', verificationMethod: 'did:key:z6Mk#z6Mk', proofPurpose: 'assertionMethod', proofValue: 'z2' }] },
        { type: 'transfer', data: { previousOwner: 'did:key:z6Mk', newOwner: 'did:key:z6Mk2', transferredAt: 'x' }, previousEvent: 'uEiC', proof: [{ type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: 'x', verificationMethod: 'did:key:z6Mk#z6Mk', proofPurpose: 'assertionMethod', proofValue: 'z3' }] },
        { type: 'rotateKey', data: { newController: 'did:key:z6Mk2', rotatedAt: 'x' }, previousEvent: 'uEiD', proof: [{ type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: 'x', verificationMethod: 'did:key:z6Mk#z6Mk', proofPurpose: 'assertionMethod', proofValue: 'z4' }] }
      ]
    };
    const parsed = parseEventLogJson(serializeEventLogJson(log as never));
    expect(parsed.events.map(e => e.type)).toEqual(['create', 'migrate', 'transfer', 'rotateKey']);
  });
```

Mirror the same case in the CBOR test file using its serialize/parse pair.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/sdk && bun test tests/unit/cel/`
Expected: the new cases FAIL — parser rejects unknown event type (and/or TS type error).

- [ ] **Step 3: Implement**

`types.ts:37`:
```typescript
export type EventType = 'create' | 'update' | 'deactivate' | 'migrate' | 'transfer' | 'rotateKey';
```

In `json.ts:134` and `cbor.ts:85`, extend the whitelist array/condition to the same six literals (match each file's existing expression style exactly — if it's `type !== 'create' && type !== 'update' && ...`, extend the chain; if it's an array `.includes`, extend the array).

- [ ] **Step 4: Run tests**

Run: `cd packages/sdk && bun test tests/unit/cel/`
Expected: PASS (all — the strict parsers previously rejecting unknown types still reject genuinely unknown strings; add a negative assertion if the file has one pattern for it: `type: 'destroy'` still throws).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/cel packages/sdk/tests
git commit --no-verify -m "feat(cel): first-class migrate/transfer/rotateKey event types in the profile

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `appendEvent` — generalize the append algorithm + typed wrappers

**Files:**
- Create: `packages/sdk/src/cel/algorithms/appendEvent.ts`
- Modify: `packages/sdk/src/cel/algorithms/updateEventLog.ts` (delegate), `deactivateEventLog.ts` (delegate; keep its own guards)
- Modify: `packages/sdk/src/cel/algorithms/index.ts` (export)
- Create: `packages/sdk/tests/unit/cel/appendEvent.test.ts`

**Interfaces:**
- Consumes: Task 2's `EventType`.
- Produces: `appendEvent(log: EventLog, type: Exclude<EventType, 'create'>, data: unknown, options: UpdateOptions): Promise<EventLog>` — signs `{ type, data, previousEvent }` (the exact payload `verifyEventLog` reconstructs), immutable append, preserves `previousLog`. Tasks 6–8 call it with `'migrate'`/`'transfer'`/`'rotateKey'`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sdk/tests/unit/cel/appendEvent.test.ts
import { describe, test, expect } from 'bun:test';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { computeDigestMultibase } from '../../../src/cel/hash';
import { canonicalizeEntryForChain } from '../../../src/cel/canonicalize';
import type { DataIntegrityProof } from '../../../src/cel/types';

const signedPayloads: unknown[] = [];
const signer = async (data: unknown): Promise<DataIntegrityProof> => {
  signedPayloads.push(data);
  return { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: 'x', verificationMethod: 'did:key:z6Mk#z6Mk', proofPurpose: 'assertionMethod', proofValue: 'zSig' };
};

describe('appendEvent', () => {
  test('appends a typed event with correct chain link and signed payload', async () => {
    const log = await createEventLog({ name: 'A' }, { signer, verificationMethod: 'did:key:z6Mk#z6Mk' });
    const out = await appendEvent(log, 'migrate', { sourceDid: 'a', targetDid: 'b', layer: 'webvh', migratedAt: 'x' }, { signer, verificationMethod: 'did:key:z6Mk#z6Mk' });
    const evt = out.events[1];
    expect(evt.type).toBe('migrate');
    expect(evt.previousEvent).toBe(computeDigestMultibase(canonicalizeEntryForChain(log.events[0])));
    // signer received exactly { type, data, previousEvent } — what verifyEventLog reconstructs
    expect(signedPayloads.at(-1)).toEqual({ type: 'migrate', data: evt.data, previousEvent: evt.previousEvent });
    expect(log.events.length).toBe(1); // input not mutated
  });

  test('rejects empty logs and create type', async () => {
    await expect(appendEvent({ events: [] }, 'update', {}, { signer, verificationMethod: 'x' })).rejects.toThrow(/empty/i);
    // @ts-expect-error create is excluded at the type level; runtime guard too
    await expect(appendEvent({ events: [{ type: 'create', data: {}, proof: [] }] }, 'create', {}, { signer, verificationMethod: 'x' })).rejects.toThrow(/create/i);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test tests/unit/cel/appendEvent.test.ts` → module not found.

- [ ] **Step 3: Implement**

```typescript
// packages/sdk/src/cel/algorithms/appendEvent.ts
/**
 * Generic append for typed CEL events. The signed payload is exactly
 * { type, data, previousEvent } — the shape verifyEventLog reconstructs —
 * and the chain link is the digest of the previous entry (proof excluded).
 */
import type { EventLog, EventType, LogEntry, UpdateOptions, DataIntegrityProof } from '../types.js';
import { computeDigestMultibase } from '../hash.js';
import { canonicalizeEntryForChain } from '../canonicalize.js';

export async function appendEvent(
  log: EventLog,
  type: Exclude<EventType, 'create'>,
  data: unknown,
  options: UpdateOptions
): Promise<EventLog> {
  const { signer } = options;
  if ((type as EventType) === 'create') {
    throw new Error('appendEvent cannot append a create event; use createEventLog');
  }
  if (!log.events || log.events.length === 0) {
    throw new Error('Cannot append to an empty event log');
  }
  const lastEvent = log.events[log.events.length - 1];
  const previousEvent = computeDigestMultibase(canonicalizeEntryForChain(lastEvent));
  const eventBase = { type, data, previousEvent };
  const proof: DataIntegrityProof = await signer(eventBase);
  if (!proof.type || !proof.cryptosuite || !proof.proofValue) {
    throw new Error('Invalid proof: missing required fields (type, cryptosuite, proofValue)');
  }
  const entry: LogEntry = { type, data, previousEvent, proof: [proof] };
  return {
    events: [...log.events, entry],
    ...(log.previousLog ? { previousLog: log.previousLog } : {}),
  };
}
```

Then make `updateEventLog` delegate — replace its body (keep signature + JSDoc) with:

```typescript
export async function updateEventLog(
  log: EventLog,
  data: unknown,
  options: UpdateOptions
): Promise<EventLog> {
  if (!log.events || log.events.length === 0) {
    throw new Error('Cannot update an empty event log');
  }
  return appendEvent(log, 'update', data, options);
}
```

`deactivateEventLog.ts`: keep ALL of its existing pre-checks (already-deactivated guard etc.) and replace only the event-construction tail (`previousEvent` computation through the return) with `return appendEvent(log, 'deactivate', data, options);` — read the file first and preserve every validation above the construction.

Export `appendEvent` from `algorithms/index.ts`.

- [ ] **Step 4: Run tests** — `bun test tests/unit/cel/` → PASS (the ~400 existing CEL tests confirm the delegation is behavior-identical; if the empty-log error message differs from the old `updateEventLog` text, keep `updateEventLog`'s own guard as shown so its message is unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/cel packages/sdk/tests
git commit --no-verify -m "refactor(cel): generic appendEvent; update/deactivate delegate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: New genesis shape — `CelAssetData` + PeerCelManager de-self-referencing

**Files:**
- Modify: `packages/sdk/src/cel/layers/PeerCelManager.ts` (the `PeerAssetData` interface ~30-43, `create()` ~110-143, `generatePeerDid` apparatus ~153-250, `update()` VM fallback ~286-292, `getCurrentState()` ~340-378)
- Modify: `packages/sdk/src/cel/index.ts` / `src/index.ts` (export `CelAssetData`; keep `PeerAssetData` exported as deprecated alias type for legacy log reading)
- Test: rewrite the creation-path cases in `packages/sdk/tests/unit/cel/PeerCelManager.test.ts`

**Interfaces:**
- Consumes: Task 1's `deriveDidCel`.
- Produces (Tasks 5–8 depend on these):
  - `interface CelAssetData { name: string; controller: string; resources: ExternalReference[]; createdAt: string; nonce: string }` — NO `did`, NO `creator`, NO `layer`.
  - `PeerCelManager.create(name, resources): Promise<{ log: EventLog; did: string }>` (was `Promise<EventLog>`) — `did` is the derived did:cel.
  - `nonce`: multibase-encoded 16 random bytes (`u` + base64url), generated per create — collision insurance so identical `{name, controller, resources, createdAt}` never yields the same DID.

- [ ] **Step 1: Write the failing test**

Rewrite the creation block of `PeerCelManager.test.ts` (keep the file's existing signer fixtures — read them first and reuse):

```typescript
  test('create() returns a derived did:cel and a de-self-referenced genesis', async () => {
    const manager = new PeerCelManager(signer, { verificationMethod: 'did:key:z6Mk...#z6Mk...' }); // reuse the file's fixture key
    const { log, did } = await manager.create('My Asset', []);
    expect(did.startsWith('did:cel:u')).toBe(true);
    expect(deriveDidCel(log)).toBe(did);
    const data = log.events[0].data as Record<string, unknown>;
    expect(data.did).toBeUndefined();          // no self-reference
    expect(data.creator).toBeUndefined();      // holder ≠ asset identity
    expect(data.layer).toBeUndefined();        // genesis layer is definitional
    expect(typeof data.controller).toBe('string');
    expect((data.controller as string).startsWith('did:key:')).toBe(true);
    expect(typeof data.nonce).toBe('string');
  });

  test('two identical creates yield different DIDs (nonce)', async () => {
    const manager = new PeerCelManager(signer, { verificationMethod: 'did:key:z6Mk...#z6Mk...' });
    const a = await manager.create('Same', []);
    const b = await manager.create('Same', []);
    expect(a.did).not.toBe(b.did);
  });
```

- [ ] **Step 2: Run to verify failure** — create() returns an EventLog today; destructure fails / assertions fail.

- [ ] **Step 3: Implement**

In `PeerCelManager.ts`:
1. Add `CelAssetData` (fields above, JSDoc noting the identity/holder separation); keep `PeerAssetData` as `/** @deprecated legacy genesis shape (pre-did:cel); still readable on the verify path */`.
2. `create()`: derive `controller` from the signer the way the current code discovers the signer's did:key (the `discoverSignerPublicKey` probe ~229-234 — repurpose it: it currently feeds `generatePeerDid`; now its result IS the controller. If `config.verificationMethod` is a `did:key:...#fragment`, `controller` = the part before `#`). Build `data: CelAssetData` with `nonce: 'u' + base64url(crypto.getRandomValues(new Uint8Array(16)))` — use the existing `multibase.encode` util from `../utils/encoding.js` if that's what `hash.ts` imports (check `hash.ts:11` and reuse the same helper: `multibase.encode(bytes, 'base64url')`). Call `createEventLog(data, ...)` then `const did = deriveDidCel(log); return { log, did };`
3. DELETE `generatePeerDid` (~153-215) and `generateRandomPublicKey` (~241-250) — grep the file for remaining references first.
4. `update()` ~286-292: the fallback verification method must no longer be `` `${createData.did}#key-0` `` (a `did:cel:...#key-0` VM is unresolvable). New fallback: `config.verificationMethod`, else `` `${controller}#${controller.slice('did:key:'.length)}` `` (the canonical did:key VM), reading `controller` from the create event data; for legacy logs (`data.did` present, no `controller`) keep the old fallback expression.
5. `getCurrentState()` ~340-378: `did` = `deriveDidCel(log)` when the genesis has `controller` (new shape) / `createData.did` when legacy; `creator` field in the returned state → keep the KEY but source it from `controller` on new logs (grep consumers of `getCurrentState().creator` first — `cli/inspect.ts` displays it); the `updateData.did`/`layer` override branches (~373-378) remain for legacy logs only (guard them on the legacy shape).

- [ ] **Step 4: Run tests** — `bun test tests/unit/cel/PeerCelManager.test.ts` then the full cel dir. Rewrite remaining PeerCelManager creation-dependent tests to the new `{ log, did }` shape; tests exercising legacy-log READING keep their fixtures.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src packages/sdk/tests
git commit --no-verify -m "feat(cel): de-self-referenced CelAssetData genesis + did:cel from PeerCelManager

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `verifyEventLog` — did:cel self-certification branch + `assetDid`/`expectedDid`

**Files:**
- Modify: `packages/sdk/src/cel/algorithms/verifyEventLog.ts` (root-of-authority block ~744-799, esp. the self-cert read at ~777)
- Modify: `packages/sdk/src/cel/types.ts` (`VerificationResult` ~99-106 gains `assetDid?: string`; `VerifyOptions` ~149-169 gains `expectedDid?: string`)
- Create: `packages/sdk/tests/unit/cel/did-cel-verification.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers, Task 4's genesis shape.
- Produces: shape-discriminated self-certification —
  - genesis `data.controller` present & `data.did` absent → **did:cel branch**: root key must be a key of `data.controller` via the existing `selfCertifyingKeyHexes` machinery, FAIL CLOSED if controller is not a resolvable did:key (no TOFU fallback on this branch); `result.assetDid = deriveDidCel(log)`.
  - genesis `data.did` present → legacy branch, byte-identical behavior; `result.assetDid = data.did`.
  - `options.expectedDid` set → compare (did:cel via `didCelMatchesLog`, legacy via string equality); mismatch = verification failure.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/sdk/tests/unit/cel/did-cel-verification.test.ts
// Build REAL signed logs: reuse the key/signer fixture pattern from
// tests/unit/cel/event-log-authorization.test.ts (read it first — it
// generates an Ed25519 keypair, builds a did:key, and a real eddsa-jcs-2022
// signer). Reuse those helpers verbatim.
import { describe, test, expect } from 'bun:test';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { deriveDidCel } from '../../../src/cel/celDid';
// + the fixture helpers copied/imported per event-log-authorization.test.ts

describe('did:cel self-certification', () => {
  test('valid did:cel log verifies and reports assetDid', async () => {
    const { signer, didKey, vm } = await makeRealSigner(); // fixture helper
    const log = await createEventLog(
      { name: 'A', controller: didKey, resources: [], createdAt: '2026-07-10T00:00:00Z', nonce: 'u1111' },
      { signer, verificationMethod: vm }
    );
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(true);
    expect(result.assetDid).toBe(deriveDidCel(log));
  });

  test('genesis signed by a key that is NOT the controller fails closed', async () => {
    const { didKey } = await makeRealSigner();          // controller A
    const other = await makeRealSigner();               // signer B
    const log = await createEventLog(
      { name: 'A', controller: didKey, resources: [], createdAt: 'x', nonce: 'u2222' },
      { signer: other.signer, verificationMethod: other.vm }
    );
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.join(' ')).toMatch(/controller/i);
  });

  test('non-did:key controller fails closed (no TOFU on the did:cel branch)', async () => {
    const { signer, vm } = await makeRealSigner();
    const log = await createEventLog(
      { name: 'A', controller: 'did:webvh:x:example.com:a', resources: [], createdAt: 'x', nonce: 'u3333' },
      { signer, verificationMethod: vm }
    );
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
  });

  test('expectedDid mismatch fails; match passes (both shapes)', async () => {
    const { signer, didKey, vm } = await makeRealSigner();
    const log = await createEventLog(
      { name: 'A', controller: didKey, resources: [], createdAt: 'x', nonce: 'u4444' },
      { signer, verificationMethod: vm }
    );
    expect((await verifyEventLog(log, { expectedDid: deriveDidCel(log) })).verified).toBe(true);
    expect((await verifyEventLog(log, { expectedDid: 'did:cel:uEiAwrong' })).verified).toBe(false);
  });

  test('legacy data.did logs verify exactly as before and report assetDid', async () => {
    // Build a legacy-shaped log the way event-log-authorization.test.ts does
    // (data: { did: didKeyOrPeer, ... }) and assert verified === true and
    // result.assetDid === that did. This pins the dual-accept contract.
  });
});
```

(The legacy test body must be filled in from the fixture file's existing legacy-log construction — it exists there; copy it.)

- [ ] **Step 2: Run to verify failure** — `assetDid` undefined / did:cel branch missing → controller-mismatch case passes verification when it must fail.

- [ ] **Step 3: Implement**

In the root-of-authority block (~761-785), replace the self-cert section with shape discrimination:

```typescript
    const genesisData = createEvent.data as { did?: unknown; controller?: unknown } | null | undefined;
    const legacyDid = typeof genesisData?.did === 'string' ? genesisData.did : undefined;
    const celController = legacyDid === undefined && typeof genesisData?.controller === 'string'
      ? genesisData.controller
      : undefined;

    if (celController !== undefined) {
      // did:cel genesis: the controller field DEFINES authority — the root key
      // must be a key of data.controller. No TOFU fallback on this branch:
      // an unbindable controller fails closed.
      const controllerKeys = selfCertifyingKeyHexes(celController);
      if (!controllerKeys || controllerKeys.size === 0 || !controllerKeys.has(rootKeyHex)) {
        /* set authorityError exactly the way the existing did-mismatch path does
           (~781-785), message: `create event proof key is not a key of the genesis
           controller ${celController}` */
      }
    } else if (legacyDid !== undefined) {
      /* existing lines 777-785 behavior, unchanged (did:key-VM pre-gate + TOFU
         fallback semantics preserved verbatim) */
    }
    // neither field: existing behavior for shapeless logs (TOFU root) — unchanged.
```

Then, where the result object is assembled (find the `return`/result construction near the end of `verifyEventLog`), add:

```typescript
    // assetDid: derived for did:cel logs, declared for legacy logs.
    let assetDid: string | undefined;
    if (celController !== undefined) assetDid = deriveDidCelFromGenesis(createEvent);
    else if (legacyDid !== undefined) assetDid = legacyDid;
```

…and `expectedDid` (early in the function or in the same authority block):

```typescript
    if (options?.expectedDid !== undefined && !optionsVerifierActive) {
      const matches = celController !== undefined
        ? didCelMatchesLog(options.expectedDid, log)
        : options.expectedDid === legacyDid;
      if (!matches) { /* push error `log does not back expected DID ${options.expectedDid}`, fail */ }
    }
```

Adapt names to the function's real locals (`rootKeyHex`, error-accumulation pattern) — mirror the existing did-mismatch path's mechanics exactly (~781-785). Imports: `deriveDidCelFromGenesis`, `didCelMatchesLog` from `../celDid.js`. Add `assetDid?: string` to `VerificationResult` and `expectedDid?: string` to `VerifyOptions` with JSDoc.

- [ ] **Step 4: Run tests** — new file + `bun test tests/unit/cel/ tests/security/` all PASS (legacy suites must be untouched-green).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/cel packages/sdk/tests
git commit --no-verify -m "feat(cel): did:cel self-certification branch in verifyEventLog + assetDid/expectedDid

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `verifyEventLog` — evolving authority + `rotateKey` semantics

**Files:**
- Modify: `packages/sdk/src/cel/algorithms/verifyEventLog.ts` (the fixed `authorizedKeyIds` set built ~744-799 / consumed ~523-540; event loop ~802-811)
- Create: `packages/sdk/tests/unit/cel/key-rotation-authority.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 5.
- Produces: authority evolution — `rotateKey` data shape `{ newController: string; rotatedAt: string; reason?: string }`; on a fully valid rotateKey event, the authorized key set is **REPLACED** by `selfCertifyingKeyHexes(newController)` (hand-off semantics — design spec §2/§5); unbindable/empty `newController` fails closed; `migrate`/`transfer`/`update`/`deactivate` cause no authority change. Task 7's managers rely on this exact data shape.

- [ ] **Step 1: Write the failing adversarial tests**

```typescript
// packages/sdk/tests/unit/cel/key-rotation-authority.test.ts
// Reuse the real-signer fixtures from event-log-authorization.test.ts.
import { describe, test, expect } from 'bun:test';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';

describe('rotateKey authority evolution', () => {
  test('post-rotation events signed by the NEW key verify; log reports verified', async () => {
    const a = await makeRealSigner(); const b = await makeRealSigner();
    let log = await createEventLog({ name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u1' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'rotateKey', { newController: b.didKey, rotatedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'update', { note: 'signed by new key' }, { signer: b.signer, verificationMethod: b.vm });
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('OLD key signing AFTER rotation fails (replace, not union)', async () => {
    const a = await makeRealSigner(); const b = await makeRealSigner();
    let log = await createEventLog({ name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u2' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'rotateKey', { newController: b.didKey, rotatedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'update', { note: 'stale key' }, { signer: a.signer, verificationMethod: a.vm });
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.events[2].proofValid === false || result.errors.length > 0).toBe(true);
  });

  test('rotation signed by an UNAUTHORIZED key fails', async () => {
    const a = await makeRealSigner(); const b = await makeRealSigner(); const mallory = await makeRealSigner();
    let log = await createEventLog({ name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u3' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'rotateKey', { newController: mallory.didKey, rotatedAt: 'x' }, { signer: mallory.signer, verificationMethod: mallory.vm });
    expect((await verifyEventLog(log)).verified).toBe(false);
  });

  test('unbindable newController fails closed', async () => {
    const a = await makeRealSigner();
    let log = await createEventLog({ name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u4' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'rotateKey', { newController: 'did:webvh:unresolvable:example.com:x', rotatedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    expect((await verifyEventLog(log)).verified).toBe(false);
  });

  test('second rotation chains authority a→b→c; a and b both dead afterwards', async () => {
    const a = await makeRealSigner(); const b = await makeRealSigner(); const c = await makeRealSigner();
    let log = await createEventLog({ name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u5' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'rotateKey', { newController: b.didKey, rotatedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'rotateKey', { newController: c.didKey, rotatedAt: 'x' }, { signer: b.signer, verificationMethod: b.vm });
    log = await appendEvent(log, 'update', { note: 'c signs' }, { signer: c.signer, verificationMethod: c.vm });
    expect((await verifyEventLog(log)).verified).toBe(true);
    const stale = await appendEvent(log, 'update', { note: 'b tries again' }, { signer: b.signer, verificationMethod: b.vm });
    expect((await verifyEventLog(stale)).verified).toBe(false);
  });

  test('deactivate still seals the log regardless of rotation', async () => {
    const a = await makeRealSigner(); const b = await makeRealSigner();
    let log = await createEventLog({ name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u6' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'rotateKey', { newController: b.didKey, rotatedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'deactivate', { deactivatedAt: 'x' }, { signer: b.signer, verificationMethod: b.vm });
    log = await appendEvent(log, 'update', { note: 'after seal' }, { signer: b.signer, verificationMethod: b.vm });
    expect((await verifyEventLog(log)).verified).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — rotation events currently authorize only against the fixed genesis key set; the first test fails (new-key event rejected).

- [ ] **Step 3: Implement**

Restructure the authority mechanics minimally:
1. Keep the root-of-authority setup building the initial set (with Task 5's branches). Rename nothing exported.
2. In the sequential event loop (~802-811), thread a mutable `authorizedKeyIds` (it already exists — the change is that it can now be reassigned between iterations). Ensure the per-event authorization check (~523-540) reads the CURRENT set for the event being verified — if that check happens inside `verifyEvent` with the set passed as a parameter, pass the current set per iteration (verify the call site; the loop is already index-ordered).
3. After an event at index i has passed ALL its checks (chain link, signature, authorized signer), if `event.type === 'rotateKey'`:

```typescript
      const rotation = event.data as { newController?: unknown } | null | undefined;
      const newController = typeof rotation?.newController === 'string' ? rotation.newController : undefined;
      const newKeys = newController ? selfCertifyingKeyHexes(newController) : null;
      if (!newKeys || newKeys.size === 0) {
        /* fail the event + the log: `rotateKey event ${i} has an unbindable newController` —
           use the same error-accumulation pattern as the authority errors */
      } else {
        authorizedKeyIds = newKeys; // REPLACE — hand-off semantics (design spec §2/§5);
                                    // keeping old keys would reopen the stale-key window.
      }
```

4. Rotation events that FAIL any check must NOT rotate the set (order: validate first, then swap).
5. `migrate`/`transfer` need no authority arm here (authorized-signer + existing gating witness checks apply to them exactly as to `update` — confirm no type-switch in the loop excludes them).
6. Update the stale comment at ~728-729 ("no in-log key-rotation mechanism") to describe the evolving model.

- [ ] **Step 4: Run tests** — new file PASS + `bun test tests/unit/cel/ tests/security/` all green (fixed-key legacy logs never contain rotateKey events, so their behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/cel packages/sdk/tests
git commit --no-verify -m "feat(cel): evolving authority — rotateKey hands off the authorized key set

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Managers emit first-class types; state derivation dual-reads

**Files:**
- Modify: `packages/sdk/src/cel/layers/WebVHCelManager.ts` (migrate() ~160-185 emits `type:'migrate'` via `appendEvent`; source DID ~141-144 derives did:cel when genesis is new-shape; `generateWebVHDid` ~214-237 gains a `did:cel:` branch using the digest suffix as the id part; state replay ~291-345)
- Modify: `packages/sdk/src/cel/layers/BtcoCelManager.ts` (migration detection ~201-217 by `type === 'migrate'` with legacy sniff kept; emit ~265 via `appendEvent(log, 'migrate', ...)`; source DID ~205 + creator ~318 dual-read; state replay ~329-427)
- Modify: `packages/sdk/src/cel/OriginalsCel.ts` (`getCurrentLayer` ~436-458 by type-first with legacy field-sniff fallback; `update()` reserved-fields guard ~243-258 applies to legacy logs only; `getCurrentState` dispatch ~414-427)
- Modify: `packages/sdk/src/cel/layers/PeerCelManager.ts` state replay arms for `migrate`/`transfer`/`rotateKey` (~359-399)
- Test: extend `packages/sdk/tests/unit/cel/WebVHCelManager.test.ts` / `BtcoCelManager.test.ts` / the OriginalsCel test file (locate by grep) with: migrate emits `type:'migrate'` carrying `{sourceDid, targetDid, layer, migratedAt, ...}`; `getCurrentLayer` reads it; a legacy fixture log (update+sourceDid sniff) still reports its layer.

**Interfaces:**
- Consumes: Tasks 1–6 (esp. `appendEvent`, `deriveDidCel`).
- Produces: migrate event data keeps the existing payload fields (`sourceDid`, `targetDid`, `layer`, `migratedAt`, + webvh's `domain` / btco's extras) — only the TYPE moves from `'update'` to `'migrate'`. Transfer event data: `{ previousOwner, newOwner, transferredAt, txid? }` (inner `type: 'transfer'` discriminator field dropped — the entry type carries it now).

- [ ] **Step 1: Write the failing tests** — in each manager test file, a case asserting `migratedLog.events.at(-1)!.type === 'migrate'` (currently `'update'`), plus an OriginalsCel `getCurrentLayer` case over a new-shape log and over an existing legacy fixture (reuse a fixture already in the tests).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** per the file list above. Rules:
  - Every detection site becomes `event.type === 'migrate' ? <new> : <legacy sniff kept verbatim>` — do not delete the sniff branches (`update` + `sourceDid`+`layer`+`migratedAt`), they serve legacy logs.
  - Source-DID reads (`createData.did`) become: `data.controller` present → `deriveDidCel(log)`; else `createData.did` (legacy).
  - `generateWebVHDid` did:cel branch: use the DID suffix (already filesystem/URL-safe base64url) truncated to the same length the did:peer branch uses — mirror its truncation exactly.
  - The `RESERVED_MIGRATION_FIELDS` guard on `update()` (~243-258): keep for updates (still prevents forging a legacy-shaped migration via update); new migrations don't hit it (they're `type:'migrate'`).

- [ ] **Step 4: Run tests** — `bun test tests/unit/cel/ tests/integration/cel-lifecycle.test.ts` green.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/cel packages/sdk/tests
git commit --no-verify -m "feat(cel): managers emit first-class migrate/transfer; dual-read state derivation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: CLI convergence

**Files:**
- Modify: `packages/sdk/src/cel/cli/migrate.ts` (`detectCurrentLayer` ~94-96, `getCurrentDid` ~123-125, emit ~438)
- Modify: `packages/sdk/src/cel/cli/transfer.ts` (`getCurrentDid` ~74-76; the transfer event build ~237-274 — emit `type: 'transfer'` with data `{ previousOwner, newOwner, transferredAt }`, dropping the inner `type` discriminator; keep the sign-over-`{type,data,previousEvent}` mechanics, or switch to `appendEvent` if the signer shape allows — prefer `appendEvent`)
- Modify: `packages/sdk/src/cel/cli/inspect.ts` (`isMigrationEvent` ~58-65 → legacy-only helper; state replay ~179-231; layer history ~254-262; per-event display switch ~443-471 gains `migrate`/`transfer`/`rotateKey` arms)
- Modify: `packages/sdk/src/cel/cli/create.ts` (emits the new `CelAssetData` genesis via PeerCelManager — verify it routes through the manager; if it builds data inline, convert to the new shape + print the derived did:cel)
- Test: `packages/sdk/tests/unit/cel/cli-inspect.test.ts`, `cel-cli-coverage.test.ts` — update constructed fixtures to new shapes; keep one legacy-fixture case per behavior.

**Interfaces:** consumes Tasks 1–7; produces no new interfaces (CLI is a consumer).

- [ ] **Step 1: Failing tests** — inspect displays a `migrate`-typed event in layer history; create prints a `did:cel:` id; transfer produces a `type:'transfer'` entry.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** per file list; every detection = type-first, legacy-sniff fallback.
- [ ] **Step 4: Run** `bun test tests/unit/cel/ tests/integration/cel-cli.integration.test.ts` (subprocess tests flaky — rerun once before judging).
- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/cel packages/sdk/tests
git commit --no-verify -m "feat(cel): CLI speaks first-class event types + did:cel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Specs — did:cel method draft + CEL profile update

**Files:**
- Create: `specs/did-cel-method.md`
- Modify: `docs/ORIGINALS_CEL_SPEC.md` (event-type vocabulary, genesis shape, rotation semantics)
- Modify: `specs/protocol/README.md` (add did-cel-method.md to the authoritative list)

**Interfaces:** none (docs).

- [ ] **Step 1: Write `specs/did-cel-method.md`** — sections, with content matching the implemented behavior exactly (cite `src/cel/celDid.ts` and `verifyEventLog`):
  1. **Abstract** — did:cel identifies an Originals asset by the multihash of its CEL genesis event; identity = the log, holders = keys the log establishes.
  2. **Method syntax** — `did:cel:<multibase-base64url-multihash>` (`u` prefix, sha2-256 multihash `0x12 0x20`), derivation expression (JCS-canonicalized `{type:'create', data}`, proof excluded).
  3. **Genesis event requirements** — MUST NOT contain `did`; MUST contain `controller` (a did:key), `name`, `resources`, `createdAt`, `nonce`; genesis proof MUST verify against a key of `controller` (fail closed).
  4. **Resolution** — short form self-certifies the genesis given any copy of the log (`didCelMatchesLog`); resolving the LATEST state requires the log's current home (local / webvh-hosted / btco-anchored) — each higher layer is a stronger resolution substrate (design doc §3).
  5. **Key rotation** — `rotateKey` event REPLACES the authorized key set; old keys are dead from that event forward; verifiers MUST reject post-rotation events signed by prior keys.
  6. **Event vocabulary** — the six types and their data payloads (as implemented).
  7. **Security considerations** — collision insurance nonce; proof-exclusion rationale (late witness proofs must not change identity); deactivation seals the log; registry note (check DIF registry for `cel` collision before publishing beyond draft).
- [ ] **Step 2: Update `docs/ORIGINALS_CEL_SPEC.md`** — event-type table gains `migrate`/`transfer`/`rotateKey` with payload schemas; genesis section documents `CelAssetData` and marks the `did`-embedded shape legacy-read-only; authority section documents the evolving model.
- [ ] **Step 3: Cross-check against code** — every MUST in the method spec corresponds to an implemented, tested behavior; list the test file next to each MUST in an appendix table.
- [ ] **Step 4: Commit**

```bash
git add specs docs/ORIGINALS_CEL_SPEC.md
git commit --no-verify -m "docs: did:cel method specification draft + CEL profile update

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Full-suite verification + final review

- [ ] **Step 1:** `cd packages/sdk && bun test` — zero non-flaky failures. `bunx tsc --noEmit` clean. Changed-files eslint zero errors. `bun run build` clean.
- [ ] **Step 2:** Final whole-branch review (fable) over `merge-base..HEAD` per subagent-driven-development, including the accumulated Minor roll-up.
- [ ] **Step 3:** Fix Critical/Important findings; re-verify; commit stragglers.
