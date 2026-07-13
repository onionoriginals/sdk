# The did:cel DID Method

**Version:** 0.1
**Status:** Draft
**Date:** 2026-07-10

> Draft method specification. The normative source of truth is the implementation
> in `packages/sdk/src/cel/` (notably `celDid.ts` and `algorithms/verifyEventLog.ts`)
> and its test suite; every **MUST** below is pinned to a test in
> [Appendix A](#appendix-a-normative-must--pinning-test). Before publishing beyond
> draft, check the [DIF](https://identity.foundation/) / W3C DID method registry for
> a `cel` name collision.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHOULD**, **MAY**
are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 1. Abstract

`did:cel` identifies an Originals asset by the multihash of its Cryptographic Event
Log (CEL) genesis event. The identifier is **derived from** the log, not assigned to
it: given any copy of the log, anyone recomputes the genesis digest and compares it
to the DID.

The three axes the Originals model keeps distinct map onto the log as follows:

- **Identity** is the CEL, addressed by `did:cel:<genesis-digest>`.
- **Holders / issuers** are parties' own key DIDs, established by the genesis
  `controller` and handed off by signed `rotateKey` events.
- **Ownership** is the Bitcoin sat/UTXO, and exists only at the `did:btco` layer.

A `did:cel` is the genesis layer of an asset that may later earn stronger resolution
substrates (`did:webvh`, `did:btco`). It is the log-native replacement for the
`did:peer` genesis previously used by the SDK.

---

## 2. Method syntax

```
did-cel        = "did:cel:" genesis-digest
genesis-digest = multibase-base64url-multihash
```

- The method name is `cel`.
- The method-specific identifier is a Multibase-encoded Multihash: the `'u'`
  Multibase prefix (base64url, no padding) followed by a sha2-256 Multihash
  (multicodec `0x12`, length `0x20`) of the canonicalized genesis event. It
  therefore always begins with `u` (e.g. `did:cel:uEiD...`).
- Implementations **MUST** derive the identifier as:

  ```
  did:cel: + computeDigestMultibase( canonicalizeEntryForChain(genesisEvent) )
  ```

  where `canonicalizeEntryForChain` emits the JCS-canonicalized committed fields of
  the genesis event — `{ type: "create", data }`, with `previousEvent` absent for a
  first event — as UTF-8 bytes, and `computeDigestMultibase` prepends the sha2-256
  Multihash header and Multibase-encodes.
- The genesis event's `proof` array **MUST NOT** contribute to the identifier.
  Excluding the proof is a security requirement: witness proofs may be appended to
  the genesis after the fact, and a late proof **MUST NOT** change the asset's
  identity (see §7).
- This is exactly the digest function the CEL hash chain uses for `previousEvent`
  links. Consequently the following invariant holds and **MUST** be preserved by
  writers: **the log's second event's `previousEvent` field equals the DID suffix**
  (the `did:cel:` prefix removed).

No new cryptography is introduced; `did:cel` reuses the existing chain-digest
primitive verbatim.

---

## 3. Genesis event requirements

The genesis event is the first entry of the log. It **MUST** be a `create` event and
**MUST NOT** carry a `previousEvent` field.

Its `data` (the `CelAssetData` shape) **MUST**:

- **NOT** contain a `did` field. The asset DID is derived from the event, so
  embedding it would be self-referential (the DID depends on the bytes that would
  contain it) and conflates identity with the holder key. A genesis whose `data`
  carries `controller` and no `did` is a `did:cel` genesis; a genesis whose `data`
  carries `did` is a *legacy* log (see §8).
- contain `controller` — the **holder's key DID** (a `did:key`, or another resolvable
  DID; see below), distinct from the derived asset DID.
- contain `name` (string), `resources` (array of external references, MAY be empty),
  and `createdAt` (ISO 8601 string).
- contain `nonce` — Multibase base64url of 16 random bytes. The nonce is **REQUIRED**
  as collision insurance: two genesis events with identical
  `{name, controller, resources, createdAt}` **MUST** still derive distinct DIDs.

### 3.1 Genesis authority binding (fail-closed)

The genesis proof establishes who controls the log. Verification **MUST** bind the
genesis signing key to `data.controller`, and **MUST** fail closed on any doubt —
there is **no trust-on-first-use** on the `did:cel` path. The create event **MUST**
carry exactly one controller proof (its proof array is unsigned, so additional
controller proofs cannot be disambiguated from an injected co-signer and **MUST**
fail the log).

Two binding modes apply, selected by the controller DID:

1. **Self-certifying controller** — `did:key`, or long-form `did:peer:4` (which
   embeds its DID document). Its key material is enumerable offline, so the genesis
   proof's key **MUST** be one of the embedded Ed25519 keys. Checked with no
   resolver; fail closed if it is not among them.
2. **Resolver-backed controller** — `did:webvh` and other methods whose keys are not
   embedded in the identifier. The genesis proof's verification-method DID (the part
   before `#`) **MUST** byte-equal `data.controller`, **and** the caller's resolver
   **MUST** vouch a key that cryptographically verifies the signature. VM-DID
   equality alone is insufficient: an attacker who stamps the victim's exact
   verification method but signs with their own key **MUST** fail against an honest
   resolver.

Without a resolver, a resolver-backed controller cannot be bound and **MUST** fail
closed.

---

## 4. Resolution

`did:cel` resolution has two questions with two different answers:

- **Genesis (self-certifying) resolution.** The short form self-certifies the
  *genesis* given any copy of the log: recompute `canonicalizeEntryForChain` over
  event 0, compare to the DID suffix (`didCelMatchesLog`), and verify the genesis
  authority binding (§3.1). This requires no network and no registry — the DID *is*
  the commitment to the genesis. A resolver **MUST** reject a log whose recomputed
  genesis digest does not match the DID suffix.
- **Latest-state resolution.** Resolving the *current* head of the asset requires
  fetching the log from wherever it currently lives. This is by design: each higher
  layer is precisely "a stronger place to resolve the latest from."

  | Where the log lives | Resolution substrate |
  |---|---|
  | local / exported bundle | the log itself (offline) |
  | `did:webvh` hosted | HTTPS + signed version history |
  | `did:btco` anchored | Bitcoin (inscription commits to the log head) |

A long form (embedding the genesis event in the identifier for fully offline genesis
resolution, analogous to `did:peer:4`) is out of scope for v0.1.

---

## 5. Key rotation

Authority over the log is not fixed for its lifetime. A `rotateKey` event hands
control from the current key set to a new controller.

- A `rotateKey` event **REPLACES** the authorized key set with the new controller's
  keys. This is replace, not union: old keys are dead from that event forward.
- Verifiers **MUST** reject any post-rotation event signed by a key that a prior
  rotation retired (or by the original genesis key after it has been rotated out).
- A `rotateKey` event **MUST** itself pass every check — chain link, signature, and
  authorization against the key set *as it stood when the event was appended* —
  **before** the set is swapped. A rotation that fails any check **MUST NOT** rotate;
  the retired key set stays in force so a failed hijack cannot strand the log.
- The `rotateKey` `newController` **MUST** be a self-certifying DID (`did:key` or
  long-form `did:peer:4`) carrying an Ed25519 key. A resolver-backed `newController`
  (e.g. `did:webvh`) **MUST** fail closed: nothing is signed by the new key at
  rotation time, so there is no proof of possession to bind it (a design for this is
  deferred). A missing, non-string, or unbindable `newController` **MUST** fail the
  event and therefore the log.
- Rotations chain: `a → b → c` leaves only `c` authorized; both `a` and `b` are dead.

---

## 6. Event vocabulary

The Originals CEL profile defines six event types. `create`, `update`, and
`deactivate` are inherited from the base CEL profile; `migrate` and `rotateKey` are
first-class Originals additions (previously folded into `update`). `transfer` is
**legacy/read-only** — verifiers **MUST** still accept it in pre-1.2.0 logs
(dual-accept), but writers **MUST NOT** emit it: ownership **is** the sat, so a
transfer is a pure sat move that writes nothing to the CEL (see the design doc §5).
The genesis event is always `create`; every subsequent event carries a
`previousEvent` chain link and at least one controller proof.

| Type | Purpose | Notable `data` fields |
|---|---|---|
| `create` | Genesis; establishes identity + controller | `name`, `controller`, `resources`, `createdAt`, `nonce` (§3) |
| `update` | Mutate metadata / resources | `name?`, `resources?`, `updatedAt`, arbitrary metadata |
| `migrate` | Layer transition (new resolution substrate) | `sourceDid`, `targetDid`, `layer`, `migratedAt`, `domain?` |
| `transfer` | **LEGACY/read-only** — ownership hand-off in pre-1.2.0 logs (identity unchanged); no longer written | `previousOwner?`, `newOwner?`, `txid?`, `transferredAt` |
| `rotateKey` | Authority hand-off (§5) | `newController`, `rotatedAt` |
| `deactivate` | Seals the log permanently | `reason?`, `deactivatedAt` |

Authority semantics differ by type and **MUST** be honored:

- `rotateKey` **REPLACES** the authorized key set (§5).
- `migrate` **MUST NOT** change the authorized key set. A legacy `transfer` (§6)
  likewise never changed it — a transfer is not a key rotation, so a recipient's key
  does not become a log signer. Ownership moves with the sat and writes nothing to the
  log; a new sat holder gains *append* authority only via a subsequent `rotateKey`
  (post-transfer append authority is rotation-gated, optional author-enablement; see
  the design doc §5).
- `deactivate` seals the log: any event after a `deactivate` **MUST** cause the whole
  log to fail verification, even if each individual signature and chain link is
  valid.

---

## 7. Security considerations

- **Collision insurance (nonce).** The derived DID is a hash of the genesis `data`;
  without entropy, two assets with identical metadata created at the same instant
  would collide. The **REQUIRED** `nonce` guarantees distinct identifiers.
- **Proof exclusion.** The identifier and the hash chain cover only the committed
  fields `{ type, data, previousEvent? }`, never the `proof` array. Witness proofs
  may be appended to any event after the fact; if identity or the chain depended on
  proofs, a late witness proof would retroactively change the DID or break every
  later link. Identity **MUST** depend only on what the controller signed.
- **No trust-on-first-use on the `did:cel` path.** An attacker who copies a victim's
  genesis `data` verbatim, re-signs event 0 with their own key, and publishes it
  would otherwise mint a "valid" log for the victim's derived DID under the
  attacker's key. The fail-closed binding of §3.1 (both modes) blocks this.
- **Single genesis authority.** The create event **MUST** carry exactly one
  controller proof; the unsigned proof array cannot otherwise disambiguate the real
  root of authority from an injected co-signer.
- **Deactivation seals the log.** A sealed log **MUST NOT** be extended; verifiers
  fail closed on any post-`deactivate` event.
- **Registry.** `cel` is not yet a registered DID method name. Check the DIF/W3C DID
  method registry for a collision before publishing beyond draft.

---

## 8. Legacy compatibility

Logs written by pre-`did:cel` SDK releases embed the asset DID in `data.did` (the
`PeerAssetData` shape, typically a `did:peer:4`). These remain verifiable on a
dual-accept read path:

- Readers **MUST** accept a legacy `data.did` genesis and keep its exact prior
  verification behavior (self-certifying binding when `data.did` is a `did:key` or
  long-form `did:peer:4`; trust-on-first-use otherwise). For such logs the reported
  asset DID is the declared `data.did`, and `expectedDid` matching is string
  equality (versus suffix derivation for `did:cel`).
- Writers **MUST** emit only the new `CelAssetData` shape (no `data.did`).
- **Documented behavioral delta:** a genesis whose `data.did` is a *malformed*
  long-form `did:peer:4` (its embedded document fails to parse) now **fails closed**
  (only when the genesis proof's `verificationMethod` is itself a `did:key`),
  where earlier releases fell back to trust-on-first-use.

---

## Appendix A: normative MUST → pinning test

Every test path is relative to `packages/sdk/tests/unit/cel/`.

| # | Normative requirement | Pinning test |
|---|---|---|
| 1 | Identifier is `did:cel:` + Multibase base64url sha2-256 Multihash (suffix starts `u`) | `celDid.test.ts` — "derives a stable did:cel with multihash-multibase suffix" |
| 2 | DID derived from `canonicalizeEntryForChain(genesis)`; proof excluded | `celDid.test.ts` — "proof does not affect the DID (proof excluded from digest)" |
| 3 | Invariant: second event's `previousEvent` equals the DID suffix | `celDid.test.ts` — "INVARIANT: second event previousEvent equals the DID suffix" |
| 4 | Genesis MUST be a `create` event; empty/non-create rejected | `celDid.test.ts` — "rejects empty logs and non-create genesis" |
| 5 | Genesis `data` carries `controller` + `nonce` (no `did`); nonce is a Multibase base64url string | `PeerCelManager.test.ts` — "asset data includes a nonce (multibase base64url, 16 bytes)" |
| 6 | Nonce guarantees distinct DIDs for identical metadata | `PeerCelManager.test.ts` — "two identical creates yield different DIDs (nonce)" / "derives a distinct did:cel for each asset (nonce insurance)" |
| 7 | Valid `did:cel` log verifies and reports the derived `assetDid` | `did-cel-verification.test.ts` — "valid did:cel log verifies and reports assetDid" |
| 8 | Self-certifying controller: genesis key not in the controller fails closed | `did-cel-verification.test.ts` — "genesis signed by a key that is NOT the controller fails closed" |
| 9 | Resolver-backed controller: VM-equality alone insufficient; resolved key must verify | `did-cel-verification.test.ts` — "resolver-backed genesis forgery backstop..." |
| 10 | Resolver-backed controller with no resolver fails closed (no TOFU) | `did-cel-verification.test.ts` — "non-did:key controller fails closed (no TOFU on the did:cel branch)" |
| 11 | `expectedDid` mismatch fails; suffix match passes | `did-cel-verification.test.ts` — "expectedDid mismatch fails; match passes (did:cel)" |
| 12 | Create event MUST carry exactly one controller proof | `event-log-authorization.test.ts`; `verifyEventLog.test.ts` |
| 13 | `rotateKey` REPLACES the key set; post-rotation events by prior keys rejected | `key-rotation-authority.test.ts` — "OLD key signing AFTER rotation fails (replace, not union)" |
| 14 | Post-rotation events by the new key verify | `key-rotation-authority.test.ts` — "post-rotation events signed by the NEW key verify" |
| 15 | A failed rotation MUST NOT rotate the set | `key-rotation-authority.test.ts` — "rotation signed by an UNAUTHORIZED key fails — and does NOT rotate" |
| 16 | `newController` MUST be self-certifying; unbindable/missing fails the event + log | `key-rotation-authority.test.ts` — "unbindable newController fails closed"; "missing/non-string newController fails closed" |
| 17 | Rotations chain (a→b→c); retired keys dead | `key-rotation-authority.test.ts` — "second rotation chains authority a→b→c" |
| 18 | `migrate`/`transfer` MUST NOT change authority | `key-rotation-authority.test.ts` — "migrate/transfer cause no authority change (old key keeps working)" |
| 19 | `deactivate` seals the log; post-deactivate events fail | `key-rotation-authority.test.ts` — "deactivate still seals the log regardless of rotation"; `deactivateEventLog.test.ts` |
| 20 | Chain link: `previousEvent` equals digest of prior committed fields | `appendEvent.test.ts` — "appends a typed event with correct chain link and signed payload"; `hash-chain-tamper.test.ts` |
| 21 | Legacy `data.did` logs verify as before; report declared DID | `did-cel-verification.test.ts` — "legacy data.did logs verify exactly as before and report assetDid" |
