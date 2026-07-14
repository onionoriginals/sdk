# Plan: did:peer deprecation — full purge (did:cel Phase 4 · 5/5)

Spec: `docs/superpowers/specs/2026-07-14-didpeer-deprecation-design.md`. Mostly
deletion + fixture conversion, so lead with "compile + suite green" over new
failing tests (one guard test excepted).

## Tasks (TDD-ish)

1. **API removal (DIDManager).** Delete `createDIDPeer` (3 overloads + impl); its
   `@aviarytech/did-peer` create import is a dynamic import inside the method, so
   it goes with it. Remove the dead, unused `getLayerFromDID` (did:peer-typed).
   KEEP `resolveDID`'s `did:peer:` branch + verifyEventLog's did:peer:4 handling
   (legacy-log *verification* the spec preserves; `@aviarytech/did-peer` stays a
   dep for those).

2. **Type + layer.** `LayerType` → `'did:cel' | 'did:webvh' | 'did:btco'`
   (drop `'did:peer'`). Remove the `did:peer` branch in
   `OriginalsAsset.determineCurrentLayer` (fail loudly on a did:peer id) and the
   `'did:peer'` key from both `validTransitions` maps (OriginalsAsset +
   LifecycleManager). Forced consequence: `LifecycleManager` `fromLayer:
   'did:peer' as const` → `'did:cel'` (LayerType no longer admits 'did:peer';
   this reconciles the label with the did:cel genesis — not #405 derivation work).

3. **Migration branch (DIDManager.migrateToDIDWebVH).** Remove the
   `method === 'did:peer' ? parts.slice(2)… :` slug branch + its comment; keep
   the `else` (`parts[parts.length-1]`) that did:cel uses. Sweep did:peer layer
   branches in `replayProvenance` / `LifecycleManager` (fold default already
   did:cel per #406).

4. **Other refs.** documentLoader (drop did:peer from self-certifying check +
   comments), WebVHManager / kinds/validators/base / EventEmitter (comments),
   repl (`did-peer` command + createDIDPeer call), CredentialManager JSDoc
   examples (did:peer→did:cel; leave verifyCredentialChain logic — #405).

5. **Examples.** `basic-usage`, `create-module-original`,
   `create-document-original`, `full-lifecycle-flow`: `createDIDPeer` →
   `sdk.lifecycle.createAsset` (did:cel genesis).

6. **Fixtures.** DID-behavior tests: convert did:cel-intent ones to `createAsset`,
   delete ones asserting removed did:peer behavior. MigrationManager tests (#279 —
   logic untouched) are built on `sdk.did.createDIDPeer`; provide a test-only
   `createDIDPeerFixture` (replicates old behavior via `@aviarytech/did-peer`) and
   swap the call sites — fixture plumbing only, no #279 logic/assertion changes.

7. **Guard test.** Assert `createDIDPeer` is gone from DIDManager AND a did:cel
   asset still `createAsset`→`publishToWeb`→inscribe end-to-end.

8. **Changeset** `.changeset/didpeer-deprecation.md` — major/breaking.

## Out of scope (leave; note if touched)
- `CredentialManager.verifyCredentialChain` (#405)
- `MigrationManager` / `src/migration/*` source (#279)
- CEL-layer legacy-verification did:peer refs (PeerCelManager name, verifyEventLog
  did:peer:4, WebVHCelManager peer key-extraction) — implement the legacy-log
  verification the spec preserves; not the creation/layer being purged.

## Verify
`bun run build` → `bun test` (0 fail) → `bunx tsc --noEmit` clean; no dangling
`'did:peer'` outside the out-of-scope files above.
