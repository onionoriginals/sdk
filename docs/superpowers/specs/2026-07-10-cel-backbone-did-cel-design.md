# Design: CEL as the provenance backbone + `did:cel` genesis layer

**Date:** 2026-07-10
**Status:** Draft — pending owner review
**Resolves:** #365, #367, #370, #375, #376, #377; establishes the model for #366, #378
**Decided with:** Brian (session 2026-07-09/10)

---

## 0. Decision record

Decisions already made in discussion; the rest of this doc elaborates them.

1. **An Original asset *is* a CEL.** One signed, hash-chained Cryptographic Event Log is the asset's identity and complete history. The `OriginalsAsset` object becomes a materialized view of the log; credentials become derived artifacts. This resolves #370 by elimination (one canonical model).
2. **`did:cel` replaces `did:peer` as the genesis layer.** The genesis DID is derived from the log itself (hash of the create event), not from a creator key blob.
3. **The DID changes per layer** — `did:cel → did:webvh → did:btco` — because each layer is a genuinely different *resolution substrate* (offline / HTTPS / Bitcoin). Migration = the asset earning a stronger place to be resolved from.
4. **Old DIDs remain resolvable and resolve forward to the latest.** Backward links via `alsoKnownAs`; forward links via signed `migrate` events in the CEL.
5. **Identity, holders/issuers, and ownership are distinct axes** and must not be conflated:
   - *Identity* = the CEL (addressed by the layer DIDs)
   - *Holder/issuer* = parties' own key DIDs, established and rotated **by log events**
   - *Ownership* = the Bitcoin sat/UTXO (btco layer)
6. **`specs/protocol/originals-protocol-rfc.md` is discarded as authoritative.** It (and the rest of `specs/protocol/` from commit `210a8a4 "Up (#148)"`) is unrevised agent output: it mis-expands CEL as "Canonical Event Log" and specifies a 5-event schema matching neither `src/cel` nor the W3C CCG CEL spec it cites. Authoritative sources: `originals-whitepaper.md` (vision), `docs/ORIGINALS_CEL_SPEC.md` + `src/cel/` (CEL mechanics), `ORIGINALS_PROTOCOL_SPECIFICATION.md` (corroborating).
7. **(Phase 4) Ownership *is* the sat; the CEL is authorship only.** A transfer is a pure Bitcoin sat move that writes **nothing** to the CEL — ownership is read live from sat control (`LifecycleManager.getCurrentOwner`), never reconstructed from a log event. The `transfer` event type is now **legacy/read-only**: verifiers MUST still accept it in pre-Phase-4 logs (dual-accept), but the SDK no longer emits it. `claimOwnership` is renamed **`authorizeSigner`** and reframed as *optional author-enablement* — a sat holder establishing a signing key so they can author new provenance; it does not grant or claim ownership (the sat is ownership). This **reverses** Phase 2, which built `transfer` as a first-class CEL event (#366).

### Trigger

Seven open `severity: high` issues share one root: the production lifecycle (`LifecycleManager`/`OriginalsAsset`) never wires up the machinery that makes provenance real. Four independent code reviews established:

- The VC path verifies credentials individually — no ordering, no chain linkage, no per-hop authority. Forgeable at the btco boundary (#365, #367). No serialization (#377).
- The CEL core (`verifyEventLog`, ~400 tests) already does whole-chain, controller-key-bound, Bitcoin-anchor-gated verification with JSON+CBOR offline-verifiable serialization — but its layer edges are stubs: fake webvh strings, attestation-only inscriptions, mock BitcoinManager in the CLI.
- The layer-edge fixes (#375, #376, #366, #378) are required under *any* backbone. Only #367/#377 are decided by the backbone choice — and CEL gets them nearly free.

---

## 1. Core model: an Original is a CEL

```
┌──────────────────────── the asset ────────────────────────┐
│  CEL: [create] ─▶ [update]* ─▶ [migrate] ─▶ ... ─▶ head   │
│        │hash-chained (previousEvent digests), each signed  │
└───────┬───────────────────────────────────────────────────┘
        │ addressed by (per layer)          references
        ▼                                       ▼
  did:cel:<genesis-digest>            resources (digestMultibase → bytes)
  did:webvh:<scid>:<domain>:...       holder/issuer DIDs (create/rotate events)
  did:btco:<sat>                      ownership (the sat, btco layer only)
```

- The log is the source of truth. `OriginalsAsset`'s `provenance`, `currentLayer`, `bindings`, and credential list are **derived views** (fold over events).
- Resource bytes are *referenced* (multihash `ExternalReference`), not contained. Content availability is a separate axis (#378, §7).
- Verification of an asset = `verifyEventLog` + layer-specific anchor checks. One verifier, every layer — the whitepaper's "uniform proofs" promise, made literal.

### Event vocabulary

`migrate` and `transfer` become first-class event types alongside the existing `create | update | deactivate` (today they're folded into `update`). Rationale: if the asset *is* its log, the log should read as a biography. Conformance note: `src/cel` is an *application profile* of W3C CCG CEL v0.1 (itself a draft); the profile owns its event vocabulary, and `verifyEventLog` is the consuming verifier. `docs/ORIGINALS_CEL_SPEC.md` is updated to define both types (payload schemas in the implementation plan). **Phase-4 correction:** `transfer` was subsequently demoted to legacy/read-only — verifiers still accept it in old logs, the SDK no longer writes it, and ownership moves are pure sat moves (see §0.7, §5). `migrate` remains first-class.

---

## 2. The `did:cel` method (genesis layer)

### Syntax and generation

```
did:cel:<digestMultibase(canonicalizeEvent(genesisEvent))>
e.g. did:cel:uEiDm9F3k...
```

- Reuses the existing chain-digest function verbatim (`computeDigestMultibase` over `canonicalizeEvent` — JCS-style canonical JSON, sha2-256 multihash, base64url multibase). **No new cryptography.**
- Invariant: the log's second event's `previousEvent` field equals the DID suffix.

### The genesis event must not contain the asset DID

Today `PeerAssetData` embeds `did` (and `creator` = same DID — the identity/holder conflation made concrete). Under hash-derived DIDs this is impossible and undesirable. New create-event data:

```jsonc
{
  "type": "create",
  "data": {
    "name": "My Asset",
    "controller": "did:key:z6Mk...",   // the HOLDER's key DID — distinct from asset identity
    "resources": [ { "digestMultibase": "u...", "mediaType": "image/png" } ],
    "createdAt": "2026-07-10T...Z"
  },
  "proof": [ /* signed by controller */ ]
}
```

The asset DID is *computed from* this event after signing is decided (hash covers `{type, data}` consistent with existing chain-link hashing; exact coverage pinned in the impl plan against `witnessEvent`'s committed fields).

### Self-certification (inverted from did:peer)

did:peer: the DID embeds the key; the document is frozen in the identifier.
did:cel: the DID is the hash of the event that *establishes* the key. Given a log, anyone recomputes the genesis digest, compares to the DID, and checks the genesis proof against `data.controller`. Same trustlessness, plus:

- **Key rotation with stable identity** — a signed `update` event (`data.operation: 'rotateKey'` or dedicated payload) hands authority to a new key. `verifyEventLog`'s authority chain extends from "genesis key forever" to "genesis key, then whatever the chain of rotation events authorizes." This removes the fixed-key limitation and is the enabler for #366's optional author-enablement (`authorizeSigner`; ownership itself is the sat).
- **Forward resolution** — did:peer structurally cannot answer "what happened next" (its document is inside the string). did:cel can: the log has a head.

### Resolution

- **Short form** `did:cel:u...` — self-certifies the *genesis* given any copy of the log; resolving the *latest* requires fetching the log from wherever it currently lives (local, web, chain pointer). This is by design: each higher layer is precisely "a stronger place to resolve the latest from."
- **Long form** (optional, later): embed the genesis event in the identifier for fully offline genesis resolution, analogous to did:peer:4's long form. Not required for v1.
- Method spec to be written under `specs/` (replacing the slop directory's role); check the DIF/W3C method registry for `cel` name collision before publishing.

---

## 3. Layer model and bidirectional resolution

| Layer | DID | Resolution substrate | What migration adds |
|---|---|---|---|
| Genesis | `did:cel:<digest>` | the log itself (offline/local) | — |
| Web | `did:webvh:<scid>:<domain>:...` | HTTPS + signed version history | discoverability, hosted log |
| Bitcoin | `did:btco:<sat>` | Bitcoin alone (inscription) | permanence, transferable ownership |

**Backward (latest → genesis):** each newly minted layer DID document carries `alsoKnownAs: [previousDID, ...]`. Machinery exists: `DIDManager.migrateToDIDWebVH` already writes it; `migrateToDIDBTCO`/`createBtcoDidDocument` gain the same.

**Forward (old → latest):** the CEL's signed `migrate` events are the forward pointers — `{ sourceDid, targetDid, layer, migratedAt }`, signed by the then-current controller, hash-chained. Resolving an old DID = obtain the current log, verify it, walk migrate events to the head. Trustworthy because a forward pointer is a *signed event in a chain the genesis DID commits to*, not a redirect.

**Where does the log live per layer?**
- cel: with the holder (exported bundle, local store).
- webvh: hosted alongside the DID log via the StorageAdapter (`.../cel.json` next to `did.jsonl`; exact path in impl plan).
- btco: the inscription anchors the log (§5); the full log remains web-hosted, with the on-chain digest making any copy verifiable and any tampering evident. (Inlining the log on-chain is a #378-adjacent option, not required.)

---

## 4. Production wiring (the facade stays)

`sdk.lifecycle` keeps its shape — `createAsset`, `publishToWeb`, `inscribeOnBitcoin`, `transferOwnership`, `OriginalsAsset` — because it's the documented contract (LLM-agent audience). Internals change:

- **`createAsset`** → build genesis event via CEL, derive `did:cel`, return `OriginalsAsset` whose `id` = the did:cel (stable genesis identity, as today's readonly `id` semantics — Fork B from the review, now with a log-native genesis).
- **`publishToWeb`** → mint a *real* did:webvh for the asset via existing `DIDManager.migrateToDIDWebVH`/`WebVHManager` (SCID, signed genesis log entry, `alsoKnownAs`), host `did.jsonl` + the CEL through the StorageAdapter (new storage-backed variant of fs-only `saveDIDLog`), append a signed `migrate` event. Publisher identity is a *holder* attribute, no longer the asset's stand-in DID (#376).
- **`inscribeOnBitcoin`** → inscribe the **btco DID document** (`application/did+json`, resolvable by `BtcoDidResolver` — #375) with `alsoKnownAs` back-links and a commitment to the CEL head digest (upgrades the old manifest's unsigned `assetId` into an on-chain commitment to the entire signed history — closes #365's forgery hole). Requires the two-phase / `buildContent(satoshi)` `OrdinalsProvider` API change (sat is only known between commit and reveal). Resource manifest folds into the document (service entry), not a replacement for it.
- **`transferOwnership`** → per the ownership model below; a thin Bitcoin sat move that writes **nothing** to the CEL (Phase-4 reversal of Phase 2 — see §0.7, §5).
- **`verify()`** → delegates to `verifyEventLog` + layer anchor checks; returns a structured per-event report (the plan-013 `UnifiedVerifier` front door dispatches to it). #367 done.
- **Serialization (#377)** → CEL JSON/CBOR serialization already exists and is offline-verifiable. `OriginalsAsset.serialize()` exports a small envelope: `{ format: "originals/asset", version, eventLog, didDocuments, resources (refs ± inline bytes), credentials? }`. `LifecycleManager.loadAsset()` verifies on load by default. The envelope's provenance section *is* the log — no bespoke history encoding.
- **Signer adapter** — bridge `KeyManager`/keyStore to `CelSigner` (a function returning a `DataIntegrityProof`); holder DIDs are `did:key` (or external-signer VMs).
- **Credentials** — the three-credential model survives as *derived artifacts* issued from log events for W3C VC interop, not as the provenance backbone. `verifyCredentialChain` is deleted or reimplemented over the log.
- **`src/migration/`** — remains experimental/unused; not promoted (its btco half has the same #375 bug). Un-export `MigrationManager` from `index.ts` or fix the CLAUDE.md claim — currently they contradict.

---

## 5. Ownership model (#366) — decided direction

**Identity ≠ ownership.** Post-inscription:

- *Identity* = the inscribed DID document + the CEL it commits to. Stable.
- *Ownership/control* = whoever holds the sat's UTXO. The resolver reports it as **resolution metadata** (`didDocumentMetadata.ownership = { address, outpoint }` via a new optional `OrdinalsProvider.getSatOwnership`), never by rewriting the inscribed document (the resolver stays content-authoritative).
- **Transfer does not re-inscribe and writes nothing to the CEL** (matches whitepaper "ownership moves only on Bitcoin" and the SPECIFICATION's transfer rule). `transferOwnership` moves the sat, full stop; ownership is then read live from sat control via `getCurrentOwner`. The `transfer` CEL event type is **legacy/read-only** — verifiers MUST accept it in pre-Phase-4 logs (dual-accept), but the SDK no longer emits it (Phase-4 reversal of Phase 2).
- **Authoring new provenance** is the sat holder's *optional* move: to append signed events they establish a signing key in the log via **`authorizeSigner`** — a `rotateKey` reinscription on the sat they now control that self-announces their key (`LifecycleManager.rotateBtcoKeys` is the cooperative primitive). This enables authorship; it is **not** ownership, which is already theirs by holding the sat.
- Verifiers of ownership-sensitive claims check *sat control at time of issuance* (helper: `getCurrentOwner(asset)`).
- **Post-transfer append authority — rotation-first rule (decided; Phase-4 rescoped):** ownership passes with the sat alone, so this rule is only about *authoring*, never owning. A sat holder who wants to append provenance must first act — a rotation reinscription on the sat via `authorizeSigner`, which simultaneously proves sat control (only the UTXO holder can reinscribe) and announces their signing key. The corresponding CEL rotation event is signed by that key; the verifier accepts it *because* the on-chain reinscription attests it. Until they enable authorship this way, old-key events timestamped after the transfer tx's block are rejected by verifiers (stale-key window closed verifier-side), and the holder simply cannot author new log events — yet they still own and can transfer the sat freely. Author-enablement is entirely optional: a holder who never authors is still the owner. Tx-backed atomic hand-off may be added later as a cooperative-flow optimization.

---

## 6. Issue disposition

| Issue | How this design resolves it |
|---|---|
| #365 identity continuity | CEL migrate events (signed, chained, genesis-committed) + `alsoKnownAs` back-links + on-chain commitment to log head |
| #366 btco ownership | §5: sat = ownership (read live via `getCurrentOwner`); transfer is a pure sat move writing nothing to the CEL; authoring new provenance is optional, recipient-initiated via `authorizeSigner` |
| #367 whole-chain verify | `verify()` → `verifyEventLog` + anchor gating; structured report; per-hop authority native to the log |
| #370 two models | Resolved by convergence: CEL is the backbone, VCs are derived views |
| #375 manifest vs DID doc | Inscribe real `application/did+json` btco document; round-trip test via `BtcoDidResolver` |
| #376 fake webvh | Real did:webvh minted per asset; DID log + CEL hosted via StorageAdapter |
| #377 serialization | CEL JSON/CBOR + thin asset envelope; `serialize()`/`loadAsset()` with verify-on-load |
| #378 content permanence | Model: log = permanent provenance; bytes = referenced. Ship inline-below-threshold inscription (config `inlineContentMaxBytes`, default ~100KB, explicit `inscribed`/`referenced` marking, hard-cap error) + honest scoping in whitepaper/docs. CID/linked-resources = later. Final threshold default + whitepaper errata = owner sign-off |

---

## 7. Phasing

Each phase lands green (`bun test`) and reviewable on its own.

- **Phase 0 — truth in the substrate.** Two-phase `OrdinalsProvider` inscription API; inscribe real btco DID docs (#375); mint real did:webvh + storage-hosted logs (#376); `getSatOwnership` + ownership metadata + `rotateBtcoKeys` (#366 primitives); honest-scoping doc edits (#378 words). Delete/mark the slop RFC; reconcile `MigrationManager` export vs CLAUDE.md. *Independent of the backbone — pure conformance.*
- **Phase 1 — did:cel.** De-self-reference the create event; DID derivation; resolver branch in `verifyEventLog` self-certification; method spec draft; `migrate`/`transfer` event types + key-rotation event in the CEL profile.
- **Phase 2 — convergence. DELIVERED** (`tests/integration/CelConvergence.e2e.test.ts`: create → publish → inscribe → transfer → rotate as one log that verifies against the chain). LifecycleManager writes CEL events at every operation (signer adapter); `OriginalsAsset` views derived from the log; `verify()` → `verifyEventLog`; migrate events wired to the Phase-0 real layer minting. **Superseded in Phase 4:** the `transfer` step no longer writes a CEL event — transfers are pure sat moves and the log is untouched (ownership-is-sat; see §0.7, §5).
- **Phase 3 — interchange + hand-off. DELIVERED** (`tests/integration/CreatorBuyerHandoff.e2e.test.ts`: SDK A create → publish → inscribe → `serialize()`; a FRESH SDK B — fresh keyStore, fresh storage, sharing the one OrdMock chain — `loadAsset` → verified with NO keys → fold parity → resolve historical DIDs forward to head → A `transferOwnership` (a pure sat move — Phase-4 reversal, no CEL write) → B `authorizeSigner` with B's own key (optional author-enablement; was `claimOwnership` pre-Phase-4) → a third independent verifier verifies the whole log incl. the non-cooperative rotation → B's appends now succeed; plus the `STALE_LOG` truncation guard). Also delivered: `serialize()`/`loadAsset()` envelope with verify-on-load (`ASSET_LOAD_VERIFICATION_FAILED`, version/format fail-closed); persistence-backed `did:cel` resolution (hosted CEL log in storage; `resolveDidCel(log)` needs only the envelope); non-cooperative rotation acceptance (`claimOwnership` write side + verifier rule); controller-signed witness acknowledgment; SDK-side provider-threading (`verifyAsset`/resolution default to `config.ordinalsProvider`); `checkHeadFreshness` truncation defense (#366).
  - **Residual 1 (Task 5) — cross-sat fork canonical anchor.** The whole-log clone-with-replaced-witness residual (task-5-report.md §Residual notes) is AMPLIFIED by the non-cooperative rotation arm: a cloner who re-anchors to their OWN sat can extend that fork with their own reinscription-attested rotations. Needs the spec-level rule **asset identity = did:cel + anchored sat** so a fork on a different sat is a distinct (non-canonical) object, not the same asset.
  - **Residual 2 (Task 7) — witness-stripping looks never-anchored.** Stripping the bitcoin witness proofs from a btco log makes the fold see no anchor, so `checkHeadFreshness`/anchoring gates never engage and the log reads as a merely-genesis (never-anchored) asset that verifies. The SAME **asset identity = did:cel + anchored sat** rule is what closes this: an asset KNOWN to be anchored cannot be downgraded to unanchored by omission. Until that rule lands, a verifier that independently knows the asset is btco-anchored must supply the sat/provider.
- **Phase 4 — #378 mechanics + credential derivation.** VC derivation from log events; inline-content inscription with config (#378); **resource-update events on-log** — today `addResourceVersion` appends NO CEL event, so post-genesis resource versions ride the envelope's `unverified.resourceUpdates` (advisory, UNverifiable) and the genesis-binding subset check permits them; Phase 4 puts updates on the log so they verify; layer-label rename (the `currentLayer` label stays `'did:peer'` for a did:cel genesis — misleading); did:peer deprecations (did:peer path, `verifyCredentialChain`).

Test spine (every phase adds to it): the Phase-3 round-trip is the protocol's promise as a single test; plus adversarial log-tamper, forged-migration, stale-key-after-transfer, and resolver round-trip cases.

## 8. Out of scope / deferred

- did:cel long form; linked-resources (`did:btco:<sat>/<index>`) content model; IPFS/CID adapter; cooperative rotate-then-transfer (incl. tx-backed atomic hand-off); CEL chunking (`previousLog`) for long histories; whitepaper v1.2 errata text (owner).
- Backward compatibility for existing did:peer assets: a `migrate`-style adoption event importing a did:peer genesis into a CEL is sketched but not designed here.
