# @originals/cel

## 2.0.0

### Major Changes

- 335abad: **BREAKING (security): legacy `data.did` genesis events now bind authority to the create-event signer.** `verifyEventLog`'s legacy compatibility path — a genesis event that embeds the asset DID directly in `data.did`, rather than deriving it from `data.controller` — trusted the create event's signer on first use whenever `data.did` named a non-self-certifying DID (`did:webvh`, `did:web`, an old-scheme `did:cel` string, ...). Because `expectedDid` matching on that path is plain string equality against the embedded `data.did`, a forger could copy any victim's `data.did` into a freshly self-signed genesis and produce a log that "backs" the victim's identifier under the attacker's own key.

  Legacy `data.did` now binds exactly like `data.controller` already does: a self-certifying `data.did` (`did:key`) requires the create event's signing key to be embedded in it; a non-self-certifying `data.did` requires the create proof's `verificationMethod` to name that exact DID, with the configured resolver vouching for the signing key. There is no trust-on-first-use fallback left on this path. A genesis that carries both a legacy `data.did` and a `data.controller` is now rejected outright as an ambiguous shape.

  **Pre-existing legacy logs whose genesis names a non-self-certifying `data.did` that the create-event key does not (and cannot, via a resolver) authenticate no longer verify.** Logs whose `data.did` is self-certifying (`did:key`), or whose create proof's `verificationMethod` genuinely names the declared `data.did` under a working resolver, are unaffected. `DIDManager.resolveDID`/`resolveDidCel` inherit the fix — they delegate to `verifyEventLog`.

- 66a9944: **`BtcoCelManager.migrate()` (the legacy pre-CEL-3 layer manager) now fails closed by default** instead of silently inscribing a did:btco document that a fresh process cannot use to recover pre-inscription history (#597).

  `BtcoCelManager.migrate()` inscribes a did:btco document whose only anchor is `service[0].serviceEndpoint.headDigestMultibase` — a head digest of the migrate event, not the asset's full CEL boundary history the CEL 3 recovery model needs. A recipient holding just the inscribed document and the bare sat cannot reconstruct pre-inscription history from this writer alone. This class predates the CEL 3 lifecycle and is retained only for the previous-format lifecycle and its regression tests (see `docs/history/previous-sdk/CLAUDE.md`) — it is not a compatibility path for CEL 3 / SDK 3.0.

  - `migrate()` now throws a `StructuredError` (`CEL_BTCO_INCOMPLETE_HISTORY`) unless `config.acknowledgeIncompleteHistory` is set to `true`, explicitly acknowledging the retained legacy path.
  - Real, fully recoverable Bitcoin publication should come from the SDK's CEL 3 path (`packages/sdk/src/v3/bitcoin.ts` / `hosted.ts`, or `@originals/cel/v3`), which is unaffected.
  - `OriginalsCel`'s `btco` config already intersects `BtcoCelConfig`, so `config.btco.acknowledgeIncompleteHistory` threads through automatically.
  - The legacy `originals-cel` CLI's internal `migrate --to btco` path (not the published `originals-cel` binary, which is `packages/sdk/src/v3/cli.ts`) now sets this flag itself and prints a warning explaining the incomplete history.

  **Breaking:** `BtcoCelManager.migrate()` now throws by default where it previously succeeded; existing callers that knowingly rely on this retained legacy path must pass `{ acknowledgeIncompleteHistory: true }`.

- 5ca171e: Name Originals with a canonical RFC 6920 `ni:///sha-256;` URI derived from the
  unchanged SHA-256 of the canonical genesis event. `asset.id` and `state.assetId`
  use this identity; newly serialized asset envelopes use version 4 and `assetId`.
  Retain strict reading of version-3 envelopes and the former application-specific
  `did:cel` alias, without changing signed history, hosted paths or inscriptions.
  The CEL wire format remains version 3. See the SDK 4 migration guide.
- d813344: Expose `resourceAvailability` on an accepted `resolveAssetFromSat`/`AssetResolution`
  result: a per-historical-resource-version `"bitcoin-inline" | "referenced"` label
  naming whether that version's bytes are recoverable from the accepted Bitcoin
  inscriptions alone, or depend on a separate off-chain host. Each Bitcoin publication selects one resource body to inline; resources with a
  matching media type and digest may share those bytes. A multi-resource asset commonly has
  both labels at once; `"referenced"` is the expected, by-design state for the rest,
  not a defect.

  The core sat result also reports current-resource availability. Both layers use the same media-type/digest matching rule and shared record shape; historical versions remain explicit at the SDK level.

  The new required fields on exported resolution results can affect callers constructing result literals.

- 82bd3a3: **BREAKING: the previous-format (pre-CEL-3) writer surface moved to `@originals/cel/legacy`.** `PeerCelManager`, `WebVHCelManager`, `BtcoCelManager`, `OriginalsCel` (which wraps all three and exposed the same `create`/`update`/`migrate` methods through one class), the event-log algorithms those managers delegate to (`createEventLog`, `appendEvent`, `updateEventLog`, `deactivateEventLog`, `verifyEventLog`, `witnessEvent`, the custody-fold helpers), the previous-format canonicalizer (`canonicalizeEvent` and its derivatives — not RFC 8785, see issue #599), and the previous-format signer helpers built on it (`celSignerFromKeyPair`, `createKeyStoreCelSigner`, `currentControllerVm`, `hexSha256ToDigestMultibase`) are no longer exported from the `@originals/cel` package root.

  Issue #597: `OriginalsCel` wraps the three layer managers and exposes the exact same previous-format write path (`create`/`update`/`migrate`) that the managers do, so removing only the three manager names left a residual bypass. The lower-level algorithms and signer helpers had the same problem — a consumer could reconstruct the same previous-format writer out of "primitive" root exports even without the named managers or classes. All of it now lives behind one explicit subpath so a new consumer importing `@originals/cel` cannot reach a previous-format writer and mistake it for the canonical one.

  Existing code that imported any of the above from `@originals/cel` must import from `@originals/cel/legacy` instead. Byte semantics are unchanged — this is an export-surface move, not a behavior change. New code should use `@originals/cel/v3` for new histories; none of this previous-format surface is the compatibility path for CEL 3 / SDK 3.0.

- 29290f7: Remove `deriveDid`, `AssetState.didCel` and the deprecated `expectedDid`
  verification option from the CEL 2 / SDK 4 asset identity surface; use
  `deriveAssetId`, `state.assetId`/`state.aliases` and `expectedAssetId` instead.
  Rename `parseAssetDid` to `parseAssetAlias`, and its result's discriminator
  from `method` to `layer` (`'cel' | 'webvh' | 'btco'`), since the `cel` layer
  is not a claim that Originals implements a DID method. Old SDK 3 envelope
  reading, signed history, hosted paths and inscriptions are unchanged.
- 75f31c2: Expose required `chainEvidence: { assurance, source? }` metadata on sat results and
  DID/publication metadata. Core JSON input and ordinary providers stay
  `provider-asserted`; failures before a snapshot is obtained report `unavailable`.

  The default SDK accepts an application-selected `chainValidator`. The exported
  `createBitcoinCoreChainValidator` checks chain tips, active block hashes, and
  ordered transactions against a separately trusted Core endpoint with explicit
  RPC credentials and bounded requests, bytes, and elapsed time. Successful checks
  earn `node-validated`; configured validation failures fail closed. Detached
  snapshots prevent asynchronous mutation from changing the view being resolved.

  These labels never establish complete Ordinals enumeration, sat trajectory,
  ownership or inscription content bindings. Issue #594 remains open. Required
  result fields are a breaking type change for callers constructing result literals.

- 6c74745: **`WebVHCelManager.migrate()` (the legacy pre-CEL-3 layer manager) now fails closed by default** instead of silently minting a did:webvh-labeled identifier that is not conformant with the did:webvh method (#603).

  `WebVHCelManager` constructs `did:webvh:{domain}:{idPart}` locally with no SCID and no genuine WebVH version history; an independent did:webvh resolver can reject or misinterpret that identifier. This class predates the did:webvh method's current specification and is retained only for the previous-format lifecycle and its regression tests (see `docs/history/previous-sdk/CLAUDE.md`) — it is not a compatibility path for CEL 3 / SDK 3.0.

  - `migrate()` now throws unless `config.acknowledgeNonConformantId` is set to `true`, explicitly acknowledging the retained legacy, non-conformant path.
  - `OriginalsCel.migrate(log, 'webvh', options)` accepts the same flag via `options.acknowledgeNonConformantId` (in addition to `config.webvh.acknowledgeNonConformantId` at construction time).
  - Real did:webvh identifiers should come from the SDK's `WebVHManager` (`sdk.did.createDIDWebVH()`), which is unaffected.
  - The legacy `originals-cel` CLI's internal `migrate --to webvh` path (not the published `originals-cel` binary, which is `@originals/sdk/v3/cli.ts`) now sets this flag itself and prints a warning explaining the non-conformant identifier.

### Minor Changes

- 42cad62: Add a portable `checkpoint`/`freshness` contract to CEL 3 `verifyHistory`, addressing #607.

  `verifyHistory`'s existing `prefix` option only authenticates continuation within
  one verifier instance (a `WeakSet`-tracked object), so it cannot detect rollback
  or a diverging continuation once history crosses a process boundary — for
  example, a private (non-Bitcoin-anchored) CEL a holder re-presents after time
  has passed. `checkpointFromHistory(history)` now extracts a portable, JSON-safe
  `{ assetId, head, entryCount }` claim a caller can persist or hand to a
  different verifier. Passing it back as `verifyHistory(log, { checkpoint })`
  independently confirms the presented history equals or extends that checkpoint
  — never trusting the checkpoint's own say-so — and fails closed
  (`CEL_CHECKPOINT_ASSET`, `CEL_CHECKPOINT_ROLLBACK`, `CEL_CHECKPOINT_FORK`) on a
  wrong asset, rollback, or fork/equivocation.

  `VerifiedHistory` gains a `freshness` field (`"unknown" | "checkpoint-consistent"
| "externally-anchored"`), reported separately from signature-chain
  authentication. It is `"unknown"` whenever no checkpoint is supplied, so a
  first-time verifier's result still never implies it has seen the latest state.
  `"externally-anchored"` is reserved for future witness/Bitcoin-anchoring
  evidence and is not produced by this change. Persisting a checkpoint, and
  deciding when its absence should block an operation, remains an
  application/recipient policy choice.

- 810ec9a: `verifyEventLog`'s result now includes `headFreshnessChecked: boolean`, true only when `options.checkHeadFreshness` was requested, the default (non-custom-verifier) path was used, and the log's authority walk actually established an on-chain anchor — i.e. exactly when `verifyHeadFreshness` genuinely ran.

  Previously a caller had no reliable way to tell "head-freshness was checked and passed" apart from "the flag was a no-op because the log was never anchored" other than re-deriving anchoring from raw proof shape, which a crafted log could spoof (a `bitcoin-ordinals-2024`-shaped proof entry can appear on a log whose authority walk never actually completed).

- 038895a: Bitcoin sat resolution can now corroborate that a confirmed inscription's reported media type, content bytes and CEL metadata tag are actually what is encoded on-chain, rather than trusting the same indexer that supplied enumeration/ownership. `resolveSat(snapshot, { independentContent? })` accepts an optional array of `{ inscriptionId, mediaType, contentDigest, metadataDigest }`. If it disagrees with an accepted publication's reported content, media type, or metadata, resolution fails closed with `inconsistent-evidence`. The accepted `SatResolution` gains `contentAssurance: 'provider-asserted' | 'cross-checked'`, `'cross-checked'` only once independent evidence covered every accepted publication and none of it disagreed.

  At the SDK layer, `OriginalsSDK.create({ contentValidator })` configures independent content derivation. The exported `createBitcoinCoreContentValidator({ endpoint, rpcAuth? })` fetches each confirmed inscription's reveal transaction from a separately trusted Bitcoin Core node and parses its taproot witness with this SDK's own Ordinals envelope interpreter — never re-fetching from the same Ordinals indexer. A configured validator that is unreachable fails resolution closed with `incomplete` rather than silently falling back to an unqualified provider claim. `did.resolveDIDWithMetadata()` exposes the same `contentAssurance` on `didDocumentMetadata`.

  This corroborates content/media binding only, a separate dimension from Bitcoin chain/index consistency, Ordinals enumeration completeness, and ownership. Progresses #594.

- dd84574: Bitcoin sat resolution can now corroborate that the primary provider did not omit an inscription. `resolveSat(snapshot, { independentEnumeration? })` accepts an optional `{ source, inscriptionIds }`: every inscription id a second, independently configured Ordinals index currently reports for the queried sat. If that source lists an id absent from the primary snapshot, resolution fails closed with `inconsistent-evidence` instead of accepting a possibly-incomplete history. The accepted `SatResolution` gains `enumerationAssurance: 'provider-asserted' | 'cross-checked'`, `'cross-checked'` only when such a source was actually consulted and did not disagree.

  At the SDK layer, `OriginalsSDK.create({ independentEnumeration: { label, provider } })` configures a second `SatProvider` for this cross-check. When configured, an unreachable independent source also fails resolution closed rather than silently degrading to `'provider-asserted'`. `did.resolveDIDWithMetadata()` exposes the same `enumerationAssurance` on `didDocumentMetadata`.

  This corroborates Ordinals enumeration completeness only, a separate dimension from Bitcoin chain/index consistency; it does not by itself establish independently validated Bitcoin consensus. Progresses #594.

- 730f295: Bitcoin sat resolution can now corroborate current sat _ownership_, not just enumeration. The same independently configured second Ordinals index used by `independentEnumeration` (see the enumeration cross-check) may also report its own current-holder observation via `resolveSat(snapshot, { independentEnumeration: { ownership? } })`: `{ owner, satpoint }`. If supplied and it disagrees with the primary snapshot's `ownership`, resolution fails closed with `inconsistent-evidence` instead of accepting an unqualified ownership claim. The accepted `SatResolution` gains `ownershipAssurance: 'provider-asserted' | 'cross-checked'`, `'cross-checked'` only when independent ownership evidence was actually supplied and agreed.

  At the SDK layer, `OriginalsSDK.create({ independentEnumeration: { label, provider } })` now also cross-checks ownership automatically, reusing the same independent snapshot already fetched for enumeration — no extra network round trip, no new SDK option. `did.resolveDIDWithMetadata()` exposes the same `ownershipAssurance` on `didDocumentMetadata` alongside `enumerationAssurance`.

  This corroborates current sat ownership only, a separate dimension from Ordinals enumeration completeness and Bitcoin chain/index consistency; it does not by itself establish independently derived sat transfer history. Progresses #594.

- 9755861: **Explicitly label the sat-trajectory trust boundary in Bitcoin resolution.** `resolveSat`'s accepted `SatResolution` (and `did.resolveDIDWithMetadata()`'s `didDocumentMetadata`) now carries `trajectoryAssurance: 'not-independently-derived'`, always. `ownership` was already documented as a single point-in-time observation, but nothing in the public shape said so where a consumer could read it programmatically. This resolver never walks the UTXO/transfer graph, so it cannot derive _how_ a sat arrived at its current holder/satpoint — that stays true even when a caller configures independent enumeration/ownership cross-checking against a second index source, since agreement between two indexes corroborates one snapshot rather than independently deriving the historical transfer path. Progresses #594; narrows the acceptance/trust model for the sat-trajectory dimension rather than building full independent derivation.

  TypeScript callers that construct accepted `SatResolution` literals must include the new required field with the value `"not-independently-derived"`.

- 1e57416: Bitcoin sat resolution distinguishes "not confirmed yet" from "nothing here." When
  every publication `resolveSat` observes for a sat is still unconfirmed — nothing
  has reached the snapshot's confirmation depth yet — it now reports a distinct
  `status: 'pending'` result (carrying the unconfirmed publication ids in `pending`)
  instead of `not-found`. `not-found` continues to mean confirmed data was inspected
  and no valid boundary was found in it; a sat with no observed publications at all,
  or with confirmed-but-invalid ones, still reports `not-found`.

  At the SDK layer, `sdk.did.resolveDIDWithMetadata()` surfaces the same
  `didResolutionMetadata.status: 'pending'` and the unconfirmed ids on
  `didDocumentMetadata.pending`, without throwing. `sdk.did.resolveDID()` treats
  `pending` like every other inconclusive status and throws
  `ASSET_RESOLUTION_INCOMPLETE`, rather than returning `null` as it previously did
  for this case — a caller of the throwing method can no longer mistake "just
  broadcast, awaiting its first confirmation" for a confirmed absence.

  Progresses the remaining "immediacy hardening" increment noted on #407: a
  provider that can already report unconfirmed publications (`confirmed: false`)
  is now resolved gracefully instead of colliding with `not-found`. Provider-side
  discovery of unconfirmed/mempool publications remains out of scope for this
  change; production providers currently only enumerate confirmed inscriptions.

### Patch Changes

- 352e5a2: **`verifyHistory` now rejects a no-prefix delta with a broken controller-authority chain as invalid**, instead of misclassifying it as merely needing its prior history (#746).

  Previously, when `verifyHistory` was called with no `prefix`, the branch handling a delta (a log that doesn't start with `create`) only verified each entry's proof and its `previousEvent` chain link, then unconditionally threw `CEL_HISTORY_REQUIRED`. A delta signed by two different controllers with no `rotateKey` between them was misclassified as merely "needs its prefix," when it is actually self-contradictory and invalid regardless of what the real prefix turns out to be.

  `verifyHistory` now tracks a provisional controller through the delta: the first entry's signer is only ever provisional (its own authorization genuinely depends on state this call wasn't given), but every later entry must be signed by whoever currently holds that provisional authority, updated only by `rotateKey`. A break throws `CelError('invalid', 'CEL_AUTHORITY', ...)`; an internally consistent delta still throws `CEL_HISTORY_REQUIRED` as before.

- 2cb1f4f: Fix a permission-less denial-of-service in `resolveSat`'s handling of the CCG
  `dataReference` shape: it no longer treats a candidate as an
  `unsupported-capability` block on the strength of its raw, unauthenticated
  `previousEvent` string alone. `eventShape`/`validateDocument` reject this
  shape before any proof is ever inspected, so anyone without the sat's
  controller key could previously force a permanent `unsupported-capability`
  result for a real Original by inscribing a single candidate whose
  `previousEvent` merely claimed to match the accepted head, with an empty,
  invalid, or wrong-controller proof — including by appending an unsigned
  `dataReference` entry after an unrelated, genuinely controller-signed one,
  since a proof only ever signs its own event, never the whole log.
  `resolveSat` now independently authenticates the entire prefix leading up to
  the offending entry (signature, chain linkage and controller authority,
  including any rotation among them) and the offending entry's own signature
  against the resulting controller, before it may block resolution; otherwise
  the candidate remains exactly as ignorable as any other invalid one, and the
  already-accepted history is reported normally. `CEL_WEBVH_IDNA` is
  unaffected: it can only be thrown after the entry's signature and controller
  authority have already been authenticated inside `apply()`.

  `CEL_PREVIOUS_LOG` is always treated as ignorable, and is deliberately not
  given the same authenticated-blocking treatment as `dataReference`: unlike
  `dataReference` (embedded inside the signed operation) or `CEL_WEBVH_IDNA`
  (reachable only after full signature authentication), the `previousLog`
  wrapper is a document-level construct that sits entirely outside any signed
  event, and its own proof has no CCG-specified target. Authenticating only
  the _wrapped_ log would not establish that the controller authorized the
  wrapping itself — anyone can wrap a copy of any log, controller-signed or
  not, in a `previousLog` envelope, which would let a permissionless observer
  flip a resolution from `accepted` to `unsupported-capability` at will.
  Originals 3 itself never produces `previousLog` documents, so this does not
  blind resolution to any real writer output.

- 2cb1f4f: `resolveSat` now reports `status: 'unsupported-capability'` for a confirmed
  publication carrying the CCG `dataReference` or `previousLog` shape, matching the
  existing `CEL_WEBVH_IDNA` handling. Previously only `CEL_WEBVH_IDNA` was
  recognized here; both `dataReference` and `previousLog` fell through to the
  generic ignorable-candidate path and were silently dropped as diagnostics,
  letting an already-accepted boundary's stale head be reported as fully
  `accepted` even though a real, uninspectable continuation sat on the same sat.
  Per `specs/originals-cel-v3-authority.md`, a recognized-but-unimplemented CCG
  shape must never be treated as invalid or ignorable.

  This does not broaden the check to every `status: 'unsupported'` error:
  `CEL_PROFILE` (disallowed/missing Originals profile) and `CEL_SUITE`
  (disallowed cryptosuite) are fully inspected, intentionally-rejected material,
  not a recognized CCG shape this implementation merely cannot verify, and
  remain on the existing ignorable-diagnostic path.

- b210e71: Fix: a mutable did:webvh document cached (or pinned) by `DIDManager` could remain authoritative for up to 24 hours — or indefinitely if pinned — after being rotated or recovered by a different process/host, since only that same `DIDManager` instance's own mutations invalidated its cache.

  `DIDManager.resolveDID(did, { mode: 'current' })` now bypasses the cache entirely for did:webvh and always re-resolves live; `Verifier.checkProofPurpose`, `DocumentLoader`, and the CEL key resolver (`createDidManagerKeyResolver`) now request this mode when deciding whether a signing key is presently authorized, so an externally rotated or recovered key can no longer be accepted from a stale or pinned cache entry. A cached/pinned document remains available as an explicit offline snapshot via the new `DIDManager.resolveDIDWithFreshness(did, { mode })` (`'cache' | 'current' | 'offline'`), which also reports `source`, `fresh`, `resolvedAt`, and `pinned` metadata. Default (no options) `resolveDID` behavior, and all other DID methods, are unchanged.

- 5153d0d: **Fix: satpoint comparisons now normalize hex casing on both sides, instead of only one.** (#733)

  `prepareBitcoinPublication`'s identity-sat alignment check (`packages/sdk/src/v3/bitcoin.ts`) lowercased only the caller-supplied funding UTXO's txid before comparing it against the configured `SatProvider`'s reported `ownership.satpoint`, which carries no casing contract of its own. A provider or caller-supplied `Utxo.txid` that used a different hex letter case than the other side happened to use caused a spurious `ASSET_SAT_ALIGNMENT` failure for a funding input that genuinely was the identity sat's current holder.

  `resolveSat`'s independent-ownership cross-check (`packages/cel/src/v3/publications.ts`) had the same one-sided gap: an independent enumeration source's `ownership.satpoint` was compared to the primary snapshot's with strict, case-sensitive equality.

  Both now compare through a new shared `normalizeSatpoint` export (`@originals/cel/v3`), which lowercases only the txid component of a well-formed `<64-hex-txid>:<vout>:<offset>` satpoint and leaves any other value unchanged, so a genuinely malformed or differing satpoint still fails comparison.

## 1.0.0

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

### Minor Changes

- e718ad4: Preserve resource bytes throughout the SDK and add the CEL 3 core and a real local regtest journey.

  **SDK migration:** runtime resource content is now `Uint8Array`; creation inputs still accept text and encode it once as UTF-8. Decode returned text explicitly with `TextDecoder`, and call `asset.serialize()` before JSON serialization. AssetEnvelope version 2 encodes inline content as canonical base64; the loader still reads version-1 UTF-8 envelopes and emits version 2 on serialization. Hashes, sizes, publication and inscription use the original bytes. The SDK also exports an explicit loopback-only `RegtestProvider` and resolves btco asset and DID reads through the verified asset path.

  **CEL core:** add `@originals/cel/v3` and the root `celV3` namespace for the selected CCG application profile, with strict JSON/CBOR encoding, Data Integrity signatures, one controller-history verifier and an on-sat snapshot fold. Existing package-root APIs remain available. The SDK mutation APIs, WebVH publisher, Bitcoin writer and live regtest journey still use the preceding CEL representation; migrating those callers is separate work.

  **Landing:** preserve uploaded bytes through hosting and inscription, and persist signed commit/reveal pairs before broadcast so retries can recover from rejected reveals, lost commit responses and early reorganizations. Retire recovery records after six confirmations; this is an operational retention policy, not a finality guarantee. Add a disposable local regtest journey covering those recovery paths.

- Production providers can now verify btco-anchored did:cel assets end to end (#473).

  `getAnchoringsForDidCel` — the capability `verifyEventLog` requires for #402 first-anchor-wins uniqueness — was implemented only by the `OrdMockProvider` test double, so every btco-anchored asset failed verification (`UNIQUENESS_UNVERIFIABLE`) against `QuickNodeProvider` or `OrdHttpProvider`.

  The contract now has two documented conformance tiers, and the verifier passes the log's own anchored sat as a scope hint (`getAnchoringsForDidCel(didCel, { satoshi })`):

  - **FULL** (a global back-link index, e.g. `OrdMockProvider`): enumerates anchorings on any sat; cross-sat legitimate-duplicate detection via authenticated competitors (#402) works.
  - **SAT-SCOPED** (now implemented by `QuickNodeProvider` and `OrdHttpProvider` via a shared helper): enumerates only the log's own anchored sat, since ord exposes no did:cel back-link index. This proves the claimed anchoring EXISTS on-chain, back-linked and height-confirmed; it does NOT check cross-sat canonicality — behaviourally identical to the already-accepted `didDocument`-omitting degraded mode, so no #402 security property is weakened: uniqueness stays fail-closed and non-opt-in, and sat-scoped providers throw (`ANCHORING_ENUMERATION_UNSCOPED`) rather than fabricate an empty enumeration when called without a scope.

  Backward compatible: existing single-argument implementations of the optional method remain valid.

- Extract the CEL core into `@originals/cel` (plan 044, item 6).

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

### Patch Changes

- 4cfbd39: Update cborg to 6.1.1.

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
