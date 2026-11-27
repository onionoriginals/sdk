# @originals/vh

## 0.6.0

### Minor Changes

- d93e225: did:og: check a did:webvh alias for an existing Original from logs signed elsewhere (P3.6, P14.29).

  `@originals/vh/og` adds `checkAliasUpdate`, `aliasCheckpoint` and `prepareAliasEntry`, and exports `gatherEvidence`. The check confirms four things: the signed entry extends the exact checkpoint, the existing author key signed it, it changes nothing but the alias list, and the alias's did:webvh log points back through `alsoKnownAs`. Anchored Originals are refused (P9.10). `@originals/sdk/og` adds `bundleEvidence`, `aliasSigningRequest`, `inspectBundle` and `checkBundleAlias`, plus `originals-og alias <inspect|unsigned|verify>`. None of these takes a key or signs anything, and a verified result is not a hosted alias.

## 0.5.0

### Minor Changes

- fd15702: Signed Bitcoin previews, built to originals-spec PR 64 (`940c6d4`, open;
  owner decision, 18 November 2026; P9.17, P9.18, P9.30, P14.5, P14.10,
  P14.12, P14.13). By default an inscription's body is a preview of the
  version its last entry names, at most 8,192 bytes, which that entry signs in
  its asset state's `preview` member (`{mediaType, size, digest}`, PROVISIONAL
  name and shape).

  - `@originals/vh`: the `preview` member and its rules (only from the
    anchoring entry on; 1 to 8,192 bytes; `image/webp` for an `image/` version;
    a new version names a new preview or none, the same version keeps its
    parent's or none; editors per P5.16). The Bitcoin verifier checks the body
    against the named preview, or with none against the version or no body
    (`SatInscription.noBody`); an empty body is a body. New ignored reasons
    `body-not-the-preview`, `content-type-without-body` and `names-a-delegate`
    (delegates rejected, PROVISIONAL); `Placed.body` says what each accepted
    inscription carries. A preview never counts as the version's bytes, is not
    in the derived DID document, and a carried file is never made from one
    (`CARRIER_PREVIEW`).
  - `@originals/sdk`: `anchor`, `edit` and `deactivate` take `body: "preview" |
"full"` and, for a non-image version, the author's `preview`; for an image
    version the SDK generates a deterministic WebP preview with one scalar WASM
    libwebp in browsers and Node (`generateImagePreview`; PNG, JPEG, WebP, AVIF,
    GIF and SVG; codecs loaded only when a preview is made;
    `configurePreviewCodecs` for SVG in a browser). The commit reports the
    preview or why none (`CommitResult.preview`). `prepareEntryInscription`
    inscribes the preview, or with none no body (no ord body push), or the full
    version with `body: "full"`, which an entry committed with `body: "full"`
    keeps (`chosenBody`, the store's optional `putBodyChoice`;
    `BODY_CHOICE_CONFLICT`); its notice says which, what the pair costs and what
    Bitcoin will not hold (`notice.body`, `notice.cost`, `pair.cost`). `waitForFeeRate` is an
    optional, caller-driven wait for a lower fee rate. The sat reader reports an
    inscription with no body (`noBody`). Packages never carry a preview.
  - Behaviour change: an entry naming no preview is inscribed with no body
    unless `body: "full"` is passed; an entry after the anchor is no longer
    refused for a large version unless the full version is chosen.
  - `@originals/host`: the account library reads a hosted copy of an anchored
    Original against its sat with the host's sat reader, since such a copy read
    without Bitcoin evidence yields only the entries before its anchoring entry
    (P7.14, C12-297); without a reader, or when the read fails, the row shows
    the Original as it was before anchoring and says its later versions are not
    checked, instead of listing it as needing recovery.

- 874555b: Carried logs and the P14.13 entry limit, built to originals-spec PR 64
  (`940c6d4`, open), which keeps both after the owner withdrew EVM anchoring
  on 18 November 2026. Bitcoin is the only anchor.

  - Carried logs (P7.11–P7.16, P14.14–P14.17; PROVISIONAL): `readCarriedFile`,
    `writeCarriedFile`, `carriedDisclosure`, `locateCarrier` and
    `removeCarrier` in `@originals/vh/originals`, and `carry`,
    `carriedDisclosure`, `readCarried` and `importCarried` on the SDK. A file
    carries its Original's log in a trailer, a text block in a comment or a
    JSON member. A reader resolves signer DIDs only on an explicit
    `resolveSigners` opt-in, which applies to that single read: there is no
    standing opt-in, and importing never counts as one (P7.13). A carried log
    with no anchoring entry is a historical checkpoint; an anchored Original's
    state comes from its sat, never from the carried copy (P7.14). The
    text-block writer places a block only where the version's own parser reads
    it as a comment, and refuses a syntax it has no parser for (`no-parser`,
    P14.16).
  - Breaking: the 65,536-byte entry limit is measured over the entry's JCS form
    in UTF-8 in every format (P14.13), not over the stored line. `verifyLog` no
    longer takes `lineBytes`, and `parseLog` no longer records line sizes. A
    stored line within 65,536 bytes whose JCS form is over it is now rejected.
  - `@originals/sdk`: the SDK refuses to sign an entry over the limit (P14.13).
    One over it even with the shortest proof fails with `ENTRY_TOO_LARGE`
    (`limit-exceeded`) before the signer is asked; before, it was signed and
    then refused (`COMMIT_VERIFICATION_FAILED`), which still happens only when
    the actual proof takes it over.
  - `@originals/sdk`: a package is a copy not read from the anchor (P7.1,
    P7.14). `load` of an anchored Original's package without `bitcoin`
    evidence reports `bitcoin-evidence-missing` and verifies at most the
    entries before the first anchoring entry; before, it verified the whole
    log. `LoadedEvidence.notCheckedAgainstAnchor` lists the anchoring entry and
    later ones. `import`, and the Bitcoin writer's own check of its committed
    log, still verify the copy whole, never current without the anchor (P7.5,
    P9.18).

- 0d1a2b3: `@originals/sdk/og` and the `originals-og` command: anchor a new did:og
  Original on Bitcoin. It creates a did:webvh author (default
  `did:webvh:<SCID>:originals.build:authors:<name>`), prints its `did.jsonl` and
  the URL to serve it at and waits until it resolves; builds and signs the
  genesis and anchoring entries with the P9.30 body mode; shows a taproot
  funding address and exact amount; after the funding output confirms, finds
  the sat, signs the anchoring entry for it and checks the local copy (P9.18);
  broadcasts the commit and reveals through mempool.space or Bitcoin Core with
  no pointer; and reads everything back from an ord explorer to compute the
  report from exactly the P9.18 evidence set, writing `last-run.json`.
  `@originals/vh/og` gains `verifyLocalCopy` (P9.18).
- 939a0d9: did:og on Bitcoin: Originals inscriptions (metaprotocol `og`, CBOR metadata
  `{entries, signers?, part?}`, ord 0.29.1 envelopes; P14.12), publications in
  parts (P9.32), the P9.15 table for every inscribed entry, inscribed signer
  histories (P9.33), did:btco signers from their own sat (P5.13), one Original
  per sat (P9.34), the first valid anchor in chain order (P9.16), holders,
  unverifiable and waiting inscriptions, and the publication writer that splits
  a log into parts only when it must. Reproduces the bitcoin vector's report
  from exactly the P9.18 evidence set and reports the prior-format mainnet
  Original `unsupported` (T14-075, T14-085, T9-030).
- 2e8c053: did:og reports follow originals-spec 0c859c0 (P14.25): `missing` and
  `dependencies` are replaced by `diagnostics`, typed items from the closed
  list of eleven codes in report order, and `changes`, head and holder change
  records against a prior result with their cause. `offline` is derived from
  the diagnostics, so a complete loose evidence set is `self-contained`
  (P7.21). Evidence inputs may state their digest; bytes that do not match
  make the input unusable (P7.17). Prior results can be supplied as a
  `prior-result` input.
- 37e7ee5: did:og entry state and transitions (P14.4–P14.7, P4, P5.15–P5.17, P6.5,
  P9.10, P9.30, P9.34) and the evidence package, written exactly as P14.10
  fixes it and read under P7.5's bounds. Reproduces the local vector's asset
  log, manifest and `evidence.zip` byte for byte (T14-076).
- 431defb: did:og hosting: the shared-host save of P6.7 (atomic per Original, durable
  before acknowledging, byte-identical retries, stale-parent refusals and the
  P7.20 rule for unendorsed parents), the did:webvh alias check in both
  directions (P3.6), and the hosted layout and P9.7 headers (P14.11). In
  `@originals/host`, `createOgRoutes` and `ogFileStore` serve saves and the
  accepted log and resources over HTTP. Reproduces the hosted vector's
  exchanges and served files (T14-079, T14-063).
- 4248e63: Add `@originals/vh/og`, the did:og 1.0 core (method value `og:1.0-draft.1`,
  originals-spec PR 69 at 6e0e3f9), starting with its log format: the
  `did.jsonl` line format (P14.2), strict JSON with the 2^53 − 1 number bound
  (P14.3), the entry shape (P14.27), SCID and entry hash (P14.28, P14.29), the
  parameters an entry may carry with `updateKeys` always `[]` (P14.1), the
  one-proof shape (P14.8) and the writer that prepares and signs genesis and
  later entries. Reproduces the spec's genesis vector byte for byte (T14-091).
- 1fdd945: did:og inscriptions carry no signer DID histories (originals-spec D22).
  Inscription metadata is `{entries, part?}`; a legacy `signers` member is
  ignored and never used as evidence only in a mainnet inscription at or below
  block 977,150, and anywhere else makes the metadata invalid. did:vh and did:webvh signers of inscribed
  entries come from a resolved log in the evidence set and are checked at the
  version each entry names: every supplied log that verifies in full is evidence and
  one that fails anywhere is none; a missing log gives `signer-history-missing`,
  and logs that do not hold the named version (short, or a fork)
  `signer-version-missing`, leaving the anchor `undetermined` or the
  inscription `unverifiable`, never accepted. `originals-og anchor verify`
  fetches the author's `did.jsonl` (no redirects) and supplies it, warns beside
  the report when the newest version removes the key or deactivates the DID,
  and waits for the required depth at the ord explorer's own tip.
- 3edd470: did:og: `presentationWarnings(report)` returns the warnings to show beside a
  report, never part of it (originals-spec P9.16, T9-153): an earlier
  anchoring publication of the Original on another sat that could not be
  checked, with its inscription and what evidence is missing.
  `originals-og anchor verify` lists them under `warnings`, and keeps the
  author log from a run in which it verified and held the named versions,
  supplying it beside the served log on later runs (P7.8, T7-079).
- 11b25a8: The did:og verification report (P7.17–P7.23, P14.25) as a pure function of a
  declared evidence set: signer binding for did:webvh and the DIF did:vh,
  authority labels and endorsement, forks and `supersedes`, availability,
  offline and dependencies, and `unsupported` for a prior format. Reproduces
  the genesis and local vectors' expected reports (T14-075, T14-091).
- f5de8cd: Hash resource versions with the platform's native SHA-256.

  - `@originals/vh` adds `sha256Async`, `sha256MultihashAsync`,
    `resourceDigestAsync`, `bytesView` (a fresh view over exactly a
    Uint8Array's memory, from any realm, built from its internal slots: no
    own property such as `length`, `byteLength`, `buffer` or `slice` is
    consulted, and nothing is copied) and `snapshotBytes` (a private copy of
    that view). Supplied bytes are size-checked before any copy is made. They use WebCrypto (`crypto.subtle.digest`) for
    inputs of 16 KiB and up, and noble otherwise or where WebCrypto is missing
    or refuses the input. The digest is SHA-256 either way, so every value is
    byte-identical to `resourceDigest`. The bytes are read when it is called:
    an input WebCrypto hashes is copied first, so changing it afterwards does
    not change the digest.
  - `verifyOriginal` checks supplied resource bytes with it (P4.3). Every
    version's bytes are looked up and read before any digest is awaited, and
    everything the report reads from its options alongside them is read before
    it too; the digests are awaited where the aliases already were. Reports are
    unchanged: the same `verified`, `missing` and `mismatch` per version and the
    same reasons. Native hashing adds at most 64 MiB of memory per
    verification, counting each version twice (the private copy and
    WebCrypto's own); past that, versions are hashed with noble from a view,
    without a copy, as before.
  - `@originals/sdk` hashes packaged bytes, imported bytes, pending and
    refused drafts' bytes and `resourceBytes` with it. Each takes a private copy
    of the bytes a store or host hands over when it reads them, at every size,
    hashes that copy and returns, archives or keeps exactly it: a store that
    reuses its buffer afterwards changes neither the answer nor the bytes.
    `prepareCreate` and `prepareEdit` hash the caller's new resource
    synchronously, as before, so they read their input exactly as they did; both
    keep a private copy of the caller's bytes (a real copy, also of a Node
    `Buffer`). `@originals/host` checks shared-save resources with it.

  Contract (owner decision, 10 November 2026): a caller must not change the
  options, inputs or stored buffers it hands to `verifyOriginal` or an SDK
  call until that call settles. A change made while hashing runs may or may
  not be seen. Bytes the SDK archives, keeps or returns are always exactly the
  bytes it hashed.

  With 25 versions of a 680 KB resource, an edit drops from 281 ms to 119 ms
  and `get` from 135 ms to 59 ms (Bun, `packages/sdk/scripts/bench-originals.ts`).

- b021bd3: Parent Originals: authority from a parent, pinned (originals-spec #66,
  `a2b5013`: P5.24–P5.27). The member names stay PROVISIONAL (P14.5, D4).

  - `@originals/vh`: an optional `asset.parent`, `{did, versionId}`, set at
    genesis. Every entry's pin is checked against the parent's log and never
    goes backwards or to another branch. An editor entry may rely on a grant in
    the parent's `editors` at its pin; one grant, direct or inherited, allows
    the whole change. `verifyOriginal` takes `parents` evidence. Without it a
    child is incomplete. The report adds `grants` (direct or inherited, with
    the parent version) and `parentAuthority`, and labels entries
    historically authorized only once the parent's latest state no longer
    grants them (P5.26). Inscribed child entries pin no older than the
    anchored parent's accepted head (P5.27). Builders take `parent`, `pin`
    and, for an editor, the `inherited` grant. `ORIGINALS_LIMITS.parents` is 8.
    The VH-Log engine's editor `lists` hook now receives the entry context.
  - `@originals/sdk`: `create({ parent })` and `edit({ pin })`, which by
    default advances to the newest parent version held, with an editor's
    inherited grant found in the held parent log. Packages carry
    `parents/<sha256(did)>/did.jsonl` through the highest pin, with its
    signers, or list a `{ kind: "parent", did, versionId }` missing item.
    `load` and `import` verify against them.

- 1aad0f3: Scoped grants (originals-spec #66, `a2b5013`: P5.28, P5.29, P14.23). The
  member names stay PROVISIONAL (P14.5, D4).

  - `@originals/vh`: an editor grant's optional `scope`, never with
    `resource: false`. A scope-type registry with `paths` (P14.23 patterns:
    `checkPathPattern`, `matchPathPattern`) and `items` (`add`, `edit`,
    `remove`), checked over a media type's path or item view
    (`MediaTypeView`, `ScopeViews`, `checkScopeChange`). A view may read
    objects the version references and report missing ones. The defaults are
    the code tree's path view (`application/vnd.originals.code-tree+json`,
    reading only changed subtrees, digests over mode and content) and a
    reference item view (`application/vnd.originals.items+json`). An unknown
    type, a missing view or missing bytes is `SCOPE_UNCHECKED`, incomplete and
    unverifiable after the anchor; a change outside is `SCOPE_OUTSIDE`. The
    report adds `grants[].scope` and `scopeObjects`.
  - `@originals/sdk`: verification reads the objects scope checks need from
    the store. Packages carry them, or list `{ kind: "object", digest }`
    missing items.
  - `@originals/code`: path grants reuse the vh pattern matcher and code tree
    constants instead of a copy.

- ebc6308: Cache signature checks by their exact inputs.

  Verifying a log again (every `get`, `prepareEdit`, `sign`, `load` and
  `import` in `@originals/sdk`) re-checked every entry's Ed25519 or BIP340
  signature. `verifyProof` now remembers the result of each check, keyed by the
  key type, public key, signed bytes and signature. A signature check is a pure
  function of those, so the cache returns the result checking again would give,
  and verification results are unchanged. The cache holds at most
  `SIGNATURE_CACHE_ENTRIES` (8192) results, dropping the oldest first, and only
  checks over at most `SIGNATURE_CACHE_MAX_DATA` (128) signed bytes with
  signatures up to 64 bytes and keys up to 33 bytes, so a caller cannot make it
  hold large messages (every proof's hash data fits). At most a few MiB is
  held. `clearSignatureCache()` empties it.

  `checkSignature(key, data, signature)` is exported: the raw check
  `verifyProof` makes, with the cache. It trusts `key` to come from
  `decodeMultikey`, which validates it; `verifyProof` refuses invalid keys
  (`MULTIKEY_INVALID`) before it gets that far.

  With 100 versions of a 680 KB resource, an edit drops from 1710 ms to 728 ms
  and `get` from 720 ms to 373 ms (Bun, `packages/sdk/scripts/bench-originals.ts`).

- 296a969: Signer sets (originals-spec #66, `a2b5013`: P5.19–P5.23, P5.30, D8; owner
  decision of 19 November 2026, reversing S8). An Original can be governed by a
  set of DIDs with a threshold instead of one author. Single-author Originals
  are unchanged, byte for byte. The member names stay PROVISIONAL (P14.5, D4).
  The conformance registry is re-pinned to `a2b5013`, with its 40 new rows
  registered as C12-382 to C12-421.

  - `@originals/vh`: the asset's optional `authors: {threshold, dids}`
    (`checkAuthors`, `ORIGINALS_LIMITS.authors` = 32). An entry's `author` is an
    array of signer references exactly when its asset has `authors`, with one
    proof per signer in the same order. Genesis is signed by every member; an
    author entry by the parent's threshold of the parent's members plus every
    added member; a single-author Original converts when the author and every
    new member sign. A member is never the Original's own did:vh, an alias or
    its anchoring sat. P5.8 holds per identity; P7.9 currency holds by
    threshold, and every signer of an inscribed set entry must pass P9.15 at
    its inscription (P5.23). The derived DID document's `controller` is
    the member array. Builders take `authors` and `sign: EntrySigner[]`;
    `cosignEntry` and `finalizeEntry` collect proofs in any order. The report
    adds `signedBy` and `identityEvidence.authors`; for a set Original the
    single-author `identityEvidence` fields are null.
    `EntryState.author` is now `AuthorRef | AuthorRef[]`: use `authorRefsOf`
    or `signersOf` to read it.
  - `@originals/sdk`: `create({ authors: { threshold, members }, signers })`,
    and `edit`, `deactivate`, `publish`, `anchor` and `reconcile` take a set
    Original's signer references and `signers`. A draft flow for signers who
    are not all present: `prepare*`, `cosign(draft, signer)`, then
    `commitDraft(draft)` (or `finalizeDraft` for a shared host). Each signer is
    shown the entry as itself, with `summary.signers` and `summary.authors`.
    Evidence packages carry every signing member's DID history.
  - `@originals/host`: shared-host saves check every signer of a set entry, and
    a member's account may save.
  - `@originals/code`: code Originals stay single-author until the code profile
    moves onto signer sets (plan 050 §5, step 3): a set Original as a repo or
    branch is refused (`SIGNER_SET_UNSUPPORTED`), never read as one author.

- e5a3e3d: Stop re-hashing resource bytes the store already checked when it stored them.

  - `verifyOriginal` takes `checked(digest) → size | undefined`: held resource
    versions whose bytes were checked against their digest when stored (P4.3)
    and have not changed since. Each such version is reported `verified` when
    that size matches its descriptor and `mismatch` otherwise, exactly as if
    its bytes had been supplied. Supplied bytes and bytes from an anchoring sat
    take precedence and are still hashed.
  - `OriginalsStore.checkedResource?(digest)` is optional. A store may
    implement it only if its bytes cannot change outside it.
    - `MemoryStore` hashes bytes when they are put and reports only those that
      matched. It keeps real copies (also of a Node `Buffer`, whose `slice`
      would share the caller's memory) in private fields and hands out only
      copies, so they never change. A subclass or patch that replaces its
      `getResource` gets no answers unless it implements `checkedResource`
      itself; an answer must cover exactly the bytes `getResource` serves, so a
      wrapper serving other bytes must not forward the wrapped store's.
    - `FileStore` does not implement it: a file can change with no change to
      its size, times or inode (a shared writable mapping), so no cheap check
      proves it unchanged. Its bytes are read and hashed on every verification,
      with native SHA-256.
    - The SDK passes checked sizes to verification instead of reading and
      hashing every stored version on every `get`, `prepareEdit` and `sign`.

  Owner decision, 9 November 2026: bytes checked when stored count as checked.
  Reports are the same as from a store without the capability. Together with
  the native SHA-256 and signature-cache changes, an edit at 100 versions of a
  680 KB resource drops from 1710 ms to 31 ms in Bun, and from 682 ms to 24 ms
  in headless Chromium.

### Patch Changes

- 874555b: Fixes found while closing section 12 rows:

  - `@originals/vh`: an asset state whose `aliases` list the same DID twice is
    rejected (`STATE_ALIASES`, P14.5; C12-299).
  - `@originals/sdk`: `keySigner` refuses input that is not a well-formed
    Originals entry (P5.11; C12-302): an entry with members other than
    `versionId`, `versionTime`, `parameters` and `state`, or one that already
    carries a proof; a `versionTime` that is not P14.2's; parameters other than
    P14.1 allows, or a null parameter value; and a state with undefined
    members, a malformed author or editor reference, asset or resource
    descriptor, an alias of another DID method, or transitions that do not name
    the resource's version (P14.4–P14.6). Before, it signed such entries.
  - `@originals/sdk`: a did:btco signer's history is read from Bitcoin and is
    never packaged, so a package no longer lists it as a missing item and can
    be complete (P7.1, P14.10; C12-298).

- 900ed2a: Add `@originals/sdk/did`, a browser entry for DIDs that needs no bundler shims.

  - It exports `createDIDOriginal`, `updateDIDOriginal`,
    `prepareDIDDataForSigning` and `verifyDIDSignature`, plus the identity
    shape originals.build mints:
    - `createWebvhIdentity` / `ensureWebvhIdentity`: `#key-0` is the identity
      and update key, `#key-1` the authorship key. It refuses an authorship key
      that is the update key (P5.11).
    - `identityFromLog`: keeps the genesis DID after a move (P5.14).
    - `createWebvhAlias`, `aliasFromLog`.
    - `localWebvhSigner`, `userPathSegment`, `aliasPathSegment`.
  - A Vite app that imports only this entry, `@originals/sdk/originals` and
    `@originals/vh/*` builds with no shims and runs in Chromium. CI checks this
    with `verify:browser-bundle`. The root `@originals/sdk` still reaches
    `fs`, `path` and `fs/promises`.
  - The did:webvh input rules (domain, paths, update keys) moved to
    `did/webvh-rules`. The modules they came from re-export them, so nothing
    changes for callers.
  - `didwebvh-ts` is imported once, statically.
  - `@originals/vh/fetch` loads `node:https` and `node:dns/promises` by a name
    bundlers do not follow. A browser bundle no longer warns that they were
    externalized; they still load only when `safeFetch`'s Node defaults run.

## 0.4.0

### Minor Changes

- 7aeaf54: Follow originals-spec #53 (`a9ecdbb`; owner decision, 1 November 2026): an
  Original is exactly one resource, which can have many versions (P4.1).

  - Asset state: `asset.resource` is a single descriptor
    `{mediaType, size, digest}` with no id; `resources`, resource ids, adding,
    removing and the 256-resource limit are gone (P4.1, P14.5, P14.6, P14.13).
    `transitions` is `[{from: null, to}]` at genesis, `[{from, to}]` when the
    digest changes and `[]` otherwise (P14.4). Editor grants are exactly
    `{did, name, metadata, resource}`, all but `did` booleans (P5.15). The
    `#files` service endpoint is the descriptor (P14.9), and the evidence
    manifest's missing resource item drops `resource` (P14.10).
  - SDK: `create` takes `resource: { mediaType, bytes }`; `edit` takes
    `resource: { bytes, mediaType?, expectedDigest? }` for the next version, and
    `remove` is gone. `ResourceVersion` has no `resource` and gains `onBitcoin`.
  - Bitcoin (P9.17, P14.12): an inscription's metadata is the CBOR of a JSON
    array of the entries it carries; its body is the exact bytes of the resource
    version its last entry names, under that version's media type, with no
    content encoding; metadata and body together are at most 350,000 bytes.
    `ORIGINALS_INSCRIPTION_TYPE` is removed. An anchored Original read from
    Bitcoin alone gets its inscribed versions from the sat. `prepareEntryInscription`
    returns a `notice` to show the author before inscribing: what becomes
    public and permanent, and a warning for active content (P9.18).
  - The landing creates an Original from one file and edits it by giving the
    file's next version; title, style and file name are asset metadata.

  Originals written under the earlier encoding, including the mainnet
  acceptance Original of 1 November 2026, are not converted and no longer
  verify (D1, D7).

  Non-integer numbers in asset metadata, such as `4.5`, are inscribed as the
  narrowest exact CBOR float, as ord writes them; readers accept any width and
  reject NaN, infinities, negative zero and magnitudes above 2^53 − 1
  (originals-spec #54, P14.12).

## 0.3.0

### Minor Changes

- 194f7ab: Chain order decides after an unverifiable inscription (P9.15, P9.13; originals-spec #51, merged at master `19d3e82a0`). While an inscription extending the accepted head is unverifiable, a later publication extending that head, or any waiting publication, directly or through others, is ignored as `waiting-for-earlier-unverifiable` with `waitingOn`; each candidate is judged in full first, so one that would be rejected on its own is rejected, and one unverifiable itself is listed in `unverifiable` as well. Once the earlier one verifies it is accepted, or rejected and the next considered. BREAKING: `anchoring.headChange` is `{ previous, current, verified, resolved, unverified, vanished }` and reports any move of the head caused by an inscription's verifiability or a reorganization; the result stays current and carries the notice `head-changed` (a reorganization that drops the retained head is still `authoritative-source-changed`). `RetainedAnchor` keeps `unverifiable` and `accepted` inscription ids. An inscription whose signer version is unverifiable but which fails any check not depending on it is rejected (`VerifyOptions.unauthorized` lets a profile run those checks); a did:vh or did:webvh versionId that is malformed, numbered below 1, past the 1,000-version limit or after a deactivated version is `AUTHOR_VERSION_IMPOSSIBLE`, with or without the signer's history and in the anchoring inscription too, where a version held under another versionId is `AUTHOR_VERSION_NOT_IN_HISTORY`. A did:btco read gap is missing evidence only for entries that depend on it (P5.13). `report.notices` (`head-changed`, `unverifiable-inscriptions`, `publications-waiting`) accompanies a current result (section 7): the CLI's verdict line (`verdictLine`, `noticeLines`) and the landing's anchoring status and panel name each listed inscription, and the writer's `wait-for-evidence` carries `waitingOn` for its own waiting pair.
- 989665c: Signer DID freshness follows the owner decision of 23 Oct 2026 (P7.8, P5.14; originals-spec #51, merged at master `19d3e82a0`): a log establishes freshness only when the DID's own witnesses approve its latest version, and a did:webvh log fetched from a location only if that version's `id` also names the location (a did:vh log or one from an evidence package is judged by its witnesses alone). A log whose latest version names another location is still used, and the SDK also asks there (P5.14). `Freshness` is now `"established" | "not-established" | "stale"` (`"retrieved"` is gone: retrieval alone establishes nothing). `identityEvidence.obtained` and each editor's `obtained` state `{ location, obtainedAt, source, latestVersionId, witnessed }`, `validAsOf.signers[]` carry `location`, and `AuthorVersion.witnessed` is set from the DID log's witness proofs. `describeFreshness(did, evidence)` states in plain words where and when the history was obtained and, unless freshness is established, that the DID may have a newer version (for example one that removes a key) that the verifier has not seen; the `originals verify` text output and the landing's example show it.
- 65d3a8a: After the anchor, an inscription signed by a did:btco whose sat was read in full through it, naming a versionId that is not one of that DID's versions, is `invalid-entry` (`AUTHOR_VERSION_NOT_IN_HISTORY`, P5.13), not `later-inscription-unverifiable`; unverifiable stays for histories that are unavailable or not read through the inscription (P9.15; owner decision, 23 Oct 2026; originals-spec #51, merged at master `19d3e82a0`). The retained anchor lists the inscriptions reported unverifiable (`RetainedAnchor.unverifiable`, kept by both stores); when the head later moves because one of them is resolved, `anchoring.headChange` reports it (see the chain-order changeset for its final shape) with the notice `head-changed`, once, instead of changing the head silently.
- ae19f3c: Originals asset entries are held to section 14's exact members (P14.1, P14.4, P14.8; P14.8's explicit wording is originals-spec #51, merged at master `19d3e82a0`): parameters are exactly `method` and `scid` at genesis, `{"deactivated": true}` for a deactivation and `{}` otherwise (`PARAMETER_MEMBERS`; `ttl`, `watchers`, `witness: {}`, `deactivated: false` and a repeated `method` were accepted before), and an entry proof has exactly `type`, `cryptosuite`, `verificationMethod`, `proofPurpose` and `proofValue` (`PROOF_MEMBERS`; `created`, `expires`, `id`, `domain`, `challenge`, `nonce`, `previousProof` and `@context` are rejected). did:webvh and did:vh signer logs are unaffected.
- fdb4ea4: Originals asset logs and inscription bodies follow section 14's form (P14.2, P14.3; the reader rules as worded in originals-spec #51, merged at master `19d3e82a0`): `versionTime` must end in `Z` (no `+00:00`) with at most three fractional digits; each line is compact JSON ending in a single LF, so a missing final LF, CRLF or whitespace between tokens is rejected (`LOG_LINE_FORMAT`; an inscription body is `undecodable`); and a number whose exact decimal value as written has magnitude greater than 2^53 − 1 is rejected (`JSON_UNSAFE_NUMBER`; `9007199254740991.4` included, judged on the text), as is any negative zero. did:vh and did:webvh signer and alias logs, and plain VH-Log, are unaffected. `verifyLogText` takes `compactLines`, `compactLineError` is exported, and a specialisation's `versionTime` takes `utc: "Z"`.
- 1ff1939: Review of the originals-spec #51 work. While an earlier inscription blocks, each later candidate is judged in full: one that would be rejected on its own is rejected, one unverifiable itself is listed in `unverifiable` as well as waiting. A malformed did:vh or did:webvh versionId, or one numbered below 1, is `AUTHOR_VERSION_IMPOSSIBLE`, and the limit and after-deactivation rules apply in the anchoring inscription too. A did:btco gap counts only for a DID that signed an entry depending on it. A head change from an inscription's verifiability keeps the result current and adds the notice `head-changed`; `headChange.vanished` reports blockers a reorganization removed, and the retained anchor keeps accepted inscription ids (`RetainedAnchor.accepted`). `IdentityObtained.movedTo` and `movedLog` report a log whose latest version names another location (than where it was fetched, or for a copy from a package or host, than the identity DID), and the SDK asks there; a host's snapshot is a copy like a package, so the P7.8 location rule does not apply to it and a witnessed one establishes freshness. The evidence reader rejects a non-UTF-8 local-header name as `ARCHIVE_PATH` and an entry with no Unix mode. The CLI verdict line names its notices (`verdictLine`, `noticeLines`), and the landing's anchoring panel lists each unverifiable and waiting inscription.

### Patch Changes

- 230855f: The SDK follows originals-spec #51 (merged at master `19d3e82a0`; owner decisions of 23 October 2026), and the repository pins that master: the earliest-entry location asked first for a moved identity, and where a verified log's latest version points (P5.14), `submitted-unobserved` beside `pending-bitcoin-acceptance` (P9.18), a delegated or encoded did:btco inscription judged by its own metadata (P5.13, P14.12), a grant in the author entry that adds the resource (P5.15), and a name counted in UTF-16 code units (P14.5). The conformance registry is re-pinned to the 189-row table, C12-180 to C12-189 added.

## 0.2.0

### Minor Changes

- a861a1c: Anchored editor entries (Originals spec P5.17, P5.18, P9.12, P9.15). An editor entry inscribed on the anchoring sat is checked against the editor DID's state at its inscription time, as an author entry is against the author DID's (versionTime with the named-later-version exception for did:vh and did:webvh, chain order for did:btco), and is ignored with `author-deactivated-at-inscription-time` once the author DID's state at its inscription time is deactivated. Editor entries inscribed by the sat's holder are accepted; only author entries anchor; chain order on the sat decides between an editor entry and the revocation of its grant. A disputed inscription that no index reports as an Originals inscription no longer holds back later inscriptions on the anchoring sat (`readSat`'s `couldCount`; a disputed Originals inscription still does, P9.10), and an unverified anchoring reports the copy's head before its anchoring entry when Bitcoin evidence was supplied. A did:btco history stops, with missing evidence, at an inscription whose metadata the reader did not read, never skipping it; a delegated or encoded inscription's own metadata is read (`satEvidence` passes it on; absent means not read) and is a version candidate (P5.13, PROVISIONAL).
- 596562c: Anchored Originals, verifier side (plan 011 PR 9a; plan 012). Asset states may list one did:btco alias: the anchoring entry, after which the sat never changes. `verifyOriginal` takes Bitcoin evidence (`SatEvidence`) and assembles the log from the anchoring sat: the anchoring inscription carries the whole log through the anchoring entry and every later one a single entry (P9.17), so `log` is optional with `bitcoin` and a copy is only compared; placement comes from each index's report, compared across indexes (P9.10, P9.11); the anchor, conflicting anchors and changes of anchor (P9.16), accepted, ignored and disputed inscriptions, author checks at inscription time (P9.15), and a provisional ownership report naming the indexes used. After anchoring no did:webvh alias may be added, replaced or re-added. The SDK adds `anchor`, a reorg-aware `InscriptionClock` (batched header reads, a `ClockStore` for restarts with `fileClockStore` in `@originals/sdk/originals/fs`, request budgets and cancellation), `satEvidence` (one read per named `index`), stores that retain the reported anchor, and Bitcoin evidence for `get` and `load`; the sat reader records block timestamps. The sat reader no longer fails on an inscription the sat's holder can add: a delegated or encoded one is reported observed but unsupported, a body past the byte budget observed but unread (`SatInscription.unsupported`; the verifier ignores or rejects it with a reason, P9.12, P9.14), and its request budget scales with the inscriptions listed (`SatSnapshotBudget.maxListedInscriptions`, `maxContentBytes`; past `maxInscriptions` bodies, later inscriptions are observed but unread); its errors carry a section 6 category. `InscriptionClock` refuses a block it holds once the chain has orphaned it, re-reads the parent of a block given without `prev`, and requires `prev` from a batched source (`BLOCK_PARENT_REQUIRED`).
- c008e66: did:btco author DIDs (plan 011 PR 9b; P5.13, did:btco method v0.2.0; spec a432). `AuthorDidEvidence` may carry Bitcoin reads of the DID's sat (one per index) instead of a log; versions are inscriptions the index places on the DID's sat number and network whose strict CBOR metadata is the DID document, in chain order, with terminal deactivation; a disputed placement stops the history with `AUTHOR_PLACEMENT_DISPUTED`. For an anchored Original, the did:btco version an entry names must precede the inscription carrying it (or the anchoring inscription, for an entry before the anchor), else `author-version-not-yet-in-effect`; the state is the latest version before the inscription, and the key must hold at both. An Original cannot anchor to its author's own sat, and entries may not name an older author version. Adds `encodeCbor`/`decodeCbor`, `ChainPosition`, `checkBeforeAnchor`; `SatInscription`, `SatEvidence`, `chainOrder` and `readSat` move to the did:btco module (still exported). Packages list a did:btco author as missing identity evidence.
- 6317ece: Editors (Originals spec P5.15–P5.18, a432aa6). The author grants editors in the asset state (`editors: [{ did, name, metadata, resources }]`, PROVISIONAL names) and grants, narrows or revokes them with author entries; an editor signs its own entries with its own DID through `sdk.edit(did, { parent, editor, signer, ... })`, checked against the grant in the parent's state, with the parent's author reference, empty parameters and only the content the grant allows. Only author entries change grants, aliases, lifecycle or parameters, or create, anchor or deactivate. Reports list each editor's identity evidence and freshness in `identityEvidence.editors`; P7.9 and per-signer version order apply to editor keys. Evidence packages carry every signer's DID history (`missing` identity items gain `role`). New error category `outside-grant`. Signing requests name the signer (`summary.signer`) and carry `display` text from the new `describeEntry`; `keySigner` gains `confirm` and refuses summaries that misstate the entry. `EditInput.author` is optional for editor edits. `ORIGINALS_LIMITS.editors` caps grants.
- c68fac7: Author DID rotation, freshness and forks (plan 011, PR 6). `verifyOriginal` accepts other copies of the asset log and the retained versionIds for the Original and its author DIDs, and reports `assetFreshness`, a stale author DID history, an unresolved `fork` and the versionIds to `retain` (P7.6, P7.8, P6.6). The SDK store retains the highest verified versionIds and keeps diverging branches, so older prefixes are stale and forks stay visible and non-current until anchoring (owner decision Q5). Import no longer replaces stored author evidence with an older history. `OriginalsStore` gains `getRetained`, `putRetained`, `putBranch` and `getBranches`.
- 11bb93f: Hosted publication (plan 011, PR 7b). Asset states may list one did:webvh alias, confirmed only in both directions (P3.6); `verifyOriginal` reports `aliases`, and `verifyOriginalByAlias` resolves through one. New `@originals/vh/fetch` retrieves files SSRF-safely (HTTPS only, no redirects, public addresses only, size and time caps). The SDK adds `publish`, `hostedFiles`, the public reader `loadPublished` (exact-snapshot verification, P9.1) and `servingHeaders` (P9.7).
- 08913a8: Content availability and signer identity continuity (Originals spec a432aa6). Missing resource bytes, current or historical, no longer fail verification: they are reported as unavailable content in `resources` and `current` excludes them; supplied bytes that fail their digest still fail (P7.3, P7.4, P9.18). `loadPublished().verified` and the `originals verify` command follow. A did:webvh author that moves under did:webvh portability keeps its genesis DID as its identity (P5.14): author binding checks the verification method against the DID document `id` at the named version, histories must verify from the identity DID's genesis with the same SCID, and `alsoKnownAs`, another SCID, redirects or a method change never count. The SDK's new `identityFetch` option retrieves a moved identity's log from the location in the latest entry's verification method (no redirects); identity freshness gains the PROVISIONAL value `retrieved`, and `AuthorDidEvidence` gains `retrievedFrom`.
- 3f9a365: An Original may have up to 256 resources at any one time, up from 64 (`ORIGINALS_LIMITS.resources`; P14.13, owner decision of 21 October 2026 in spec PR #50 (open)). The other limits are unchanged and, like it, no longer provisional.
- 47752a0: Anchored Originals check each did:vh or did:webvh signer against the newest version of its DID the verifier knows of (originals-spec #47, merged at master 1039c471c; P7.8, P9.15). An entry inscribed after that version is checked against it, not reported as incomplete identity evidence; an entry before or at the anchor naming a version with no verified copy is incomplete identity evidence; after the anchor it is reported in `anchoring.unverifiable` (`later-inscription-unverifiable`) and never downgrades the accepted head (P9.12), or is `invalid-entry` (`AUTHOR_VERSION_NOT_IN_HISTORY`) when it names a verified version number under another id. `assetFreshness.status` is `anchored` for a log Bitcoin decided, and `validAsOf.signers` states each version relied on with `obtainedAt` and `source`. The SDK uses the newest of a package's or host's, configured and stored signer evidence, compared by verified versionIds; evidence that diverges is an identity fork. Anchoring does not require did:btco signers.
- a4a7283: Originals asset logs do not use witnesses (owner decision Q14). An entry that sets the VH witness parameter to anything but `{}` is rejected with `WITNESS_NOT_PERMITTED` (invalid-evidence), replacing the interim `WITNESS_NOT_SUPPORTED_YET`. Unanchored ordering is claimed only; Bitcoin anchoring gives proven ordering.
- e900d43: The author can add and remove resources (originals-spec #49, master 1039c471c; P4.1, P4.4, P5.15, P5.16, P14.4, P14.5). `edit` adds a resource for a new id (with its `mediaType`), appended after the existing ones at version 1, and removes resources with `remove: [id]` while one remains; `prepareUpdateOriginal` takes the same `resources` and `remove`, and `usedResourceIds`. An editor entry never adds or removes a resource (`outside-grant`, `EDITOR_AUTHOR_ONLY`). A resourceID is never used again in an Original, even after removal (`invalid-evidence`, `STATE_RESOURCE_REUSED`); a removed resource must leave every grant (`STATE_EDITORS`). Transitions give `from: null` for an added resource and `to: null` for a removed one, the resulting resources first and then the removed ones in their previous order. A removed resource's earlier versions stay in reports, packages and hosted snapshots. The signer display names additions and removals. `STATE_RESOURCE_SET` now means only a reordering, an empty resource set or a removal of an unknown id. BREAKING (types): `Transition.to` is `string | null`; `EntryContext` (the VH-Log engine's specialisation context) carries `history`.
- dcee1fc: Signer DID evidence is chosen by verified versionIds, never by bytes: of a package's or host's, the configured and the stored evidence, the one with the newest verified version is used, and its versionId is compared against as retained; evidence that diverges is an identity fork (AUTHOR_DID_FORK, incomplete identity evidence) (P7.8, P7.9; originals-spec #47). Entry size is the UTF-8 byte length of the stored line on every path: `verifyLog` takes the stored sizes (`lineBytes`) and entries parsed with `parseLog` carry theirs; an entry with no stored line is measured as its JCS line (P14.13; PROVISIONAL, section 14). `publish`, `hostedFiles` and a shared-host `submit` refuse a resource larger than the 64 MiB fetch cap with `limit-exceeded` `RESOURCE_OVER_FETCH_LIMIT` naming it; `assertHostable` is exported (P8.5, P14.13).
- cef01ce: Add `@originals/sdk/originals`, the Originals Protocol local workflow (plan 011, PR 4). It provides create (or an unsigned draft), edit with an explicit parent, deactivate, commit with identical-retry detection, ZIP evidence packages with load and import, a durable `FileStore` (`@originals/sdk/originals/fs`), the `keySigner` contract, and an `originals` CLI that verifies packages offline. `@originals/vh` gains unsigned `prepare*` builders. `@originals/vh` becomes a public package (owner decision Q11).
- 1832877: Unanchored Originals are never current (Originals spec master 051049d8b, originals-spec #46; P7.9, P7.10, P6.5). BREAKING: `verifyOriginal` no longer takes `freshness`, `Freshness` loses `asserted`, and `current` is always false for an Original that is not anchored, with `not-anchored` first in `reasons`. Reports gain `validAsOf` (`{ checkpoint, signers: [{ did, role, versionId, obtainedAt, source }] }`, null when the checkpoint does not verify or the Original is forked) and `historicallyAuthorizedOnly` (each entry whose key the signer's latest DID state no longer lists, by a deactivated editor DID, or after the author DID's deactivation; reason `historically-authorized-only`), which replace the `head-key-not-in-latest-*`, `editor-did-deactivated` and `*-freshness-not-established` reasons. `AuthorDidEvidence` gains `obtainedAt` and `source`, which the SDK stamps for evidence it obtains. The SDK drops its `freshness` option, `OriginalView` gains `validAsOf`, and `originals verify` drops `--freshness` and prints what the result is valid as of. A grant naming the Original's own did:vh or one of its aliases is rejected (P5.15). The landing's shared-host submit route refuses an entry that is historically authorized only (`422 entry_historically_authorized_only`) instead of one that would not be current.
- 7001d2a: Editors move into the generic VH-Log engine as VH-Log PR 11's "Editors from a Controller" (swcurran/VH-Log#11 at 2fe380dbf, [S25]). A controller-keyed specialisation may set `keys.editors` (`ControllerEditors`): where the current editors are recorded (`recordOf`), how an entry names its editor (`editorOf`, `lists`), each editor's key rules (`authorize`) and any further limit on its change (`limit`). The engine enforces that an editor entry is not the first entry, is checked against the editors in the entry before it, has empty `parameters` (`outside-grant`, `EDITOR_PARAMETERS`), leaves the record of editors unchanged (`EDITOR_AUTHOR_ONLY`), and carries exactly one proof, by an authorized key of that editor (`PROOF_COUNT`). Forks are unchanged. The Originals profile implements the hook with its grants (P5.15–P5.18); valid logs verify as before. An editor entry that deactivates is now refused at its `deactivated` parameter (`EDITOR_PARAMETERS`) rather than as `EDITOR_AUTHOR_ONLY`; both are `outside-grant`.
- f8e0e29: Add `@originals/vh` (private, unpublished): strict JSON and JCS, Multikey, `eddsa-jcs-2022` and `bip340-jcs-2025`, a VH-Log engine with specialisation hooks, and did:vh resolution with extensions (plan 011, PR 2).
- 944bb5a: Add `@originals/vh/webvh` (did:webvh 1.0 on VH-Log, verification only) and `@originals/vh/originals` (the provisional `originals:1.0` extension: asset state rules, author binding, derived DID document, builders and `verifyOriginal`) (plan 011, PR 3).
- d018a77: Wire format per section 14 of the Originals spec (originals-spec #48, merged at master 1039c471c; PROVISIONAL). BREAKING: evidence packages and hosted snapshots keep signer DID histories under `signers/<hex sha256 of the DID>/` (`signerPath`, replacing `authorPath`) and carry no `asset/did-witness.json`, since asset logs have no witnesses (P9.8); the old `authors/` directory and an asset witness file are rejected (`EVIDENCE_LAYOUT`), with no legacy reading. `verifyOriginal` drops `witnessFile`, `EvidenceContents` drops `witness` and `StoredOriginal`/`CommitUpdate` drop `witness`. An entry's size is the UTF-8 byte length of its stored line without the line feed, at most 65,536 (P7.7, P14.13), in the log engine, the hosted retrieval plan and SDK commits, which fail with `limit-exceeded`. Hosted retrieval caps one resource at 64 MiB (`FETCH_LIMITS.maxResourceBytes`, `RetrievalLimits.maxResourceBytes`, P8.5), separately from the 16 MiB log-file cap. The landing's hosted layout follows, and the First Light example package is regenerated.

### Patch Changes

- 135154b: The Bitcoin values are decided (owner decisions of 21 October 2026; spec PR #50 (open); P9.5, P9.10, P9.17, P14.12): an inscription counts at one confirmation on every network, mainnet included, with its depth reported; the media type `application/vnd.originals.vh+jsonl`, the 350,000-byte inscription body limit and the did:btco network prefixes `sig:`, `test:` and `reg:` are no longer provisional. The did:btco method does not yet define the prefixes; they are proposed upstream as decentralized-identity/labs-ordinals-plus#4. No behaviour changes.
- 216d6d0: There is no `migrate` operation (P9.10; P14.4, PROVISIONAL, section 14): anchoring is an update that adds the sat's did:btco alias, so an entry whose operation is `migrate` (or `publish`) is now `invalid-evidence` `STATE_OPERATION`, not `unsupported-profile` `STATE_OPERATION_UNSUPPORTED`.
- b6f785d: Accept an entry proof whose `verificationMethod` is a bare `did:key:<multikey>`, as VH-Log's "Authorized Keys" allows and didwebvh-ts signers produce. Witness proofs still need `did:key:<multikey>#<multikey>`. This fixes signed-in landing authors, whose did:webvh logs failed verification as identity evidence.
