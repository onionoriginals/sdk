# @originals/cel

## 1.0.0-next.2

### Major Changes

- a8fe507: **CEL proofs no longer claim to be W3C Data Integrity.**

  Every CEL proof carried `type: "DataIntegrityProof"`, asserting that a conforming Data Integrity implementation could verify it. None can. The cryptosuite is ours and unregistered, so a conforming verifier reads past the type, fails to recognise the suite, and rejects — naming the envelope after the spec only moved that discovery one field later. Plan 042 already fixed this for the `cryptosuite` field; this does the same for `type`, which is the field a reader looks at first.

  ```
  CEL_PROOF_TYPE        = 'OriginalsCelProof'   — written from now on
  CEL_PROOF_TYPE_LEGACY = 'DataIntegrityProof'  — accepted on READ, permanently
  ```

  Carried by every proof in a CEL log: the controller's event signatures and the `bitcoin-ordinals-2024` witness attestations alike. Both are Originals constructions; neither is Data Integrity. Genuine W3C credential proofs (`eddsa-rdfc-2022`, `bbs-2023`) are untouched and keep the W3C type — those really are conformant.

  This renames a claim. It does not change which bytes are signed, and no cryptography moves.

  **Logs sealed before this change keep verifying.** They cannot be re-signed, so `DataIntegrityProof` remains accepted on read, forever. External artifacts written by other implementations — a competing anchoring's did:btco document — may carry it too.

  **Accepting both labels opens no door.** The type is not a dispatch key: the cryptosuite selects the preimage, and since 042 the proof configuration — `type` included — is inside the signature. So relabelling a current-suite proof to the legacy type breaks it, and relabelling a legacy proof to the new one breaks it as well. Both directions fail closed, which is what made this shippable rather than a downgrade vector.

  `CEL_PROOF_TYPE`, `CEL_PROOF_TYPE_LEGACY`, `CEL_PROOF_TYPES` and `isCelProofType` are root exports of both packages, alongside the existing suite constants.

  **Breaking:**

  - New CEL proofs carry `type: 'OriginalsCelProof'`. Anything matching on the literal `'DataIntegrityProof'` must accept both — use `isCelProofType`.
  - This applies to witness proofs as well as event proofs.

  Reading is strictly widened, so nothing already minted breaks.

- 6e6bc3d: **BREAKING: did:peer support is removed entirely.** No creation, no resolution, and — unlike earlier releases — no verifier read path. `@aviarytech/did-peer` is no longer a dependency of either package.

  - **Verifier (`@originals/cel`)**: a did:peer DID is refused wherever a self-certifying DID is checked — genesis controllers, legacy `data.did` bindings, rotateKey targets, and committed `data.author` values all fail closed (empty key set, never a resolver fallback). Pre-existing logs whose genesis or rotation chain names a did:peer DID **no longer verify**. `validateDID` no longer accepts `did:peer:…` — and now accepts `did:key:…`, the protocol's only self-certifying method.
  - **SDK (`@originals/sdk`)**: `DIDManager.resolveDID` returns null for did:peer (unsupported method, no fabricated stub); the credential documentLoader no longer treats did:peer as self-certifying, so legacy did:peer credentials no longer verify (registry fallback is did:key-only); `loadAsset` / `resolveAssetFromSat` refuse any log whose current controller is not a did:key with a clear error, and a post-anchor append under a non-did:key signing VM throws `CEL_APPEND_FAILED` before anything is appended or inscribed.

- 6e6bc3d: **BREAKING: the non-cooperative rotation path (#366) is removed.** Holding the anchoring sat grants no control of an asset's key set: a `rotateKey` whose controller proof is not authorized by the current key lineage now always fails verification, even when it carries a fully verified reinscription witness on the anchored sat. The sat proves ownership and gates the right to append (see the sat-gated-appends entry in this same release) — it never buys the identity slot.

  Removed APIs:

  - `sdk.lifecycle.authorizeSigner(...)` (`@originals/sdk`) — the write side of the deleted path (a self-signed rotation plus reinscription witness). There is no replacement call: the cooperative `rotateBtcoKeys` (signed by the outgoing controller) is the only rotation. The capability the removal takes away — a buyer establishing their own authoring key without the seller's signature — ships in this same release as sat-gated appends (`asset.appendStatement`): a sat holder appends with their own key directly, with no rotation and no key-set change.
  - `EventVerification.nonCooperativeRotation` (`@originals/cel`) — rotations are only ever cooperative now, so the field is meaningless.

  Documented consequence: **the controller key lineage is frozen once an asset is inscribed.** A creator who loses the post-migrate controller key can no longer rotate it away; pre-anchor rotation is unaffected.

- 6e6bc3d: **BREAKING: sat-gated appends and the creator-vs-holder entry split.** Authority over a CEL splits at the btco anchor: before the migrate, the key decides (unchanged); after the migrate, the sat decides. A post-anchor event is authorized iff it commits its author's key in `data.author` (inside the chain digest), its single controller proof is that author's key, and it carries a fully verified `bitcoin-ordinals-2024` witness proof on the anchoring sat whose inscription strictly postdates the current anchor. The signer does NOT have to be in the authorized key set, and appending never modifies it.

  Verifier (`@originals/cel`):

  - Post-anchor `rotateKey`, `deactivate`, and `migrate` are rejected outright, and `transfer` events are rejected ANYWHERE, in any shape — there is no transfer event in the model (ownership is the sat, moved by a Bitcoin transaction) and no legacy transfer-bearing log to read. Off-chain post-anchor appends — including the witness-acknowledgment updates earlier SDK versions wrote — no longer verify.
  - Entries are classified: creator entries (signed by the genesis controller or a pre-anchor rotation — the authenticity claim) vs holder entries (post-anchor writes by the sat holder — chain of custody). Holder entries carry an ALLOWLISTED data shape (`author`/`statement`/`occurredAt`/`links`/`ext`); anything else fails the log. New public surface: `EventVerification.authorKey`/`authorClass`, `VerificationResult.creatorKeys`/`holders`, `AssetState.custody`/`holders`, and the pure display fold `classifyLogEntries`.
  - `options.verifier` is documented as UNSAFE for btco logs: none of the on-chain authority machinery runs on that path.
  - **Fail-closed on a bad holder entry is deliberate**: a post-anchor holder append that breaks the data allowlist or fails the sat gate fails the WHOLE log, permanently — not just that entry. The sat holder owns the sat, so inscribing junk destroys their own asset's provenance; the genesis authenticity claim remains readable in the on-chain prefix before the junk entry. There is no partial-verification mode.

  SDK (`@originals/sdk`):

  - `rotateBtcoKeys` always throws `KEY_ROTATION_NOT_PERMITTED`: a did:btco asset is definitionally past the anchor, so its output could never verify again. The controller key lineage is frozen at inscription time.
  - Post-inscription witness-acknowledgment appends are no longer written (they would invalidate every new log). Serialized envelopes or hosted logs from earlier versions that carry a post-migrate acknowledgment update no longer verify — re-serialize from the chain (`resolveAssetFromSat`) to obtain the clean on-chain log.
  - New `asset.appendStatement({ statement?, occurredAt?, links?, ext? }, { signer? })`: the sat holder's write. The append path signs with the caller's configured signer even when its key is not in the log, commits `data.author`, and refuses holder authenticity claims locally (`CEL_HOLDER_FIELD_NOT_PERMITTED`) before anything is inscribed or paid.
  - `resolveAssetFromSat` now also returns `owner` — the sat's current holder, read live from the provider's owner index at call time, never cached; unset when no owner index exists.
  - `ProvenanceChain.custody` + `ProvenanceQuery.custody()` expose the holder chain; `replayProvenance` folds holder entries into `custody`, never into `resourceUpdates`.

- 6e6bc3d: **BREAKING: legacy compatibility paths are removed — the protocol starts fresh.** There is no legacy data to support, so the transitional read/write paths are gone rather than maintained:

  - **`transfer` events are rejected anywhere, in any shape** (`@originals/cel`). The v0/v1 distinction and the pre-anchor v0 read path are deleted: ownership is the sat, moved by a Bitcoin transaction, never a log event, and no v0 log exists to read. Any log carrying a `transfer` entry fails verification.
  - **Genesis lineage is `data.controller` only.** The classification and custody folds (`classifyLogEntries`, `beginCustodyFold`, the landing's custody view) no longer fall back to legacy `data.creator`/`data.did` or the create proof's VM; a genesis without `controller` has no lineage, so nothing can make a post-anchor authenticity claim on such a log. The `genesisLineageDids` helper (added in this same release cycle) is removed.
  - **Resource URLs are multibase-multihash only** (`@originals/sdk`). The raw-sha256 legacy segment ("ud…") is never written: the dual-write and the `legacyResourceUrlCompat` config flag are removed, publish/update write exactly one key per resource version, and `parseResourcePathSegment` is deleted (nothing reads segments back — the canonical segment IS the key). The landing host serves exact keys with no alternate-form fallback.
  - **`classifyLogEntries` agrees with the verifier on rejected entries**: a post-anchor non-`update` entry is classed `unattributed` regardless of lineage — the display fold never labels an entry "creator" that the verifier rejects.

## 0.2.0-next.1

### Minor Changes

- 5f0788f: Production providers can now verify btco-anchored did:cel assets end to end (#473).

  `getAnchoringsForDidCel` — the capability `verifyEventLog` requires for #402 first-anchor-wins uniqueness — was implemented only by the `OrdMockProvider` test double, so every btco-anchored asset failed verification (`UNIQUENESS_UNVERIFIABLE`) against `QuickNodeProvider` or `OrdHttpProvider`.

  The contract now has two documented conformance tiers, and the verifier passes the log's own anchored sat as a scope hint (`getAnchoringsForDidCel(didCel, { satoshi })`):

  - **FULL** (a global back-link index, e.g. `OrdMockProvider`): enumerates anchorings on any sat; cross-sat legitimate-duplicate detection via authenticated competitors (#402) works.
  - **SAT-SCOPED** (now implemented by `QuickNodeProvider` and `OrdHttpProvider` via a shared helper): enumerates only the log's own anchored sat, since ord exposes no did:cel back-link index. This proves the claimed anchoring EXISTS on-chain, back-linked and height-confirmed; it does NOT check cross-sat canonicality — behaviourally identical to the already-accepted `didDocument`-omitting degraded mode, so no #402 security property is weakened: uniqueness stays fail-closed and non-opt-in, and sat-scoped providers throw (`ANCHORING_ENUMERATION_UNSCOPED`) rather than fabricate an empty enumeration when called without a scope.

  Backward compatible: existing single-argument implementations of the optional method remain valid.

## 0.2.0-next.0

### Minor Changes

- 5e89cba: Extract the CEL core into `@originals/cel` (plan 044, item 6).

  `@originals/cel` is the browser-safe half of the protocol: create, append, and
  verify Cryptographic Event Logs offline. It carries only `@noble/*`,
  `@scure/base`, `cborg`, and a lazily-loaded `@aviarytech/did-peer` (legacy
  did:peer:4 read path) — no Bitcoin stack, no `jsonld`, no `didwebvh-ts`, no
  Node builtins. Subpath exports: `.` (CEL core + shared primitives: `multikey`,
  `StructuredError`, satoshi validation, DID/proof types), `./encoding`,
  `./cbor`, and `./testing` (`OrdMockProvider`).

  `@originals/sdk` now depends on `@originals/cel` and re-exports everything it
  exported before — the root entry, `@originals/sdk/cel`, and
  `@originals/sdk/testing` surfaces are unchanged, so no consumer imports break.
  The `originals-cel` CLI still ships from the SDK (it drives the full
  OriginalsSDK lifecycle and needs `fs`/`path`). Type-only couplings were cut
  structurally: `BtcoCelManager`/`BitcoinWitness`/`OriginalsCel` now accept a
  `CelBitcoinManager` structural slice (satisfied by `BitcoinManager` as-is) and
  `createDidManagerKeyResolver` a `CelDidResolver` (satisfied by `DIDManager`).
