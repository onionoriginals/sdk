# @originals/host

## 0.4.1

### Patch Changes

- b56a9ef: TSP 1.0 direct mode for Multikey did:webvh handoff: new `@originals/tsp`, optional `tsp` transport on WebVH create/update, and opt-in host inbox POST routes. Published documents stay Multikey-only (no JsonWebKey2020 emission).
- Updated dependencies [d93e225]
- Updated dependencies [6524009]
- Updated dependencies [b56a9ef]
  - @originals/vh@0.6.0
  - @originals/sdk@6.3.0
  - @originals/tsp@0.2.0

## 0.4.0

### Minor Changes

- 431defb: did:og hosting: the shared-host save of P6.7 (atomic per Original, durable
  before acknowledging, byte-identical retries, stale-parent refusals and the
  P7.20 rule for unendorsed parents), the did:webvh alias check in both
  directions (P3.6), and the hosted layout and P9.7 headers (P14.11). In
  `@originals/host`, `createOgRoutes` and `ogFileStore` serve saves and the
  accepted log and resources over HTTP. Reproduces the hosted vector's
  exchanges and served files (T14-079, T14-063).
- b5a95d0: Stop stranding anchored Originals' stores across deploys.

  - `createOriginalsAnchoring` gains `close()`: it waits for each Original's
    queued work, then closes every store the process opened, removing their
    `.lock` files. Later calls answer 503 `shutting_down`. Previously the stores
    stayed open until `process.exit`, and the next container on the same volume
    (another hostname) could never break their locks: every open of that
    Original then failed with `STORE_LOCKED`.
  - A store that cannot be opened is now a 503 refusal (`status_unavailable` or
    `submit_unavailable`, with the code, no server path) from `status`,
    `submit` and `recorded`, instead of a thrown error the app served as a 500.
    In `sweep` it counts as one failure and the pass goes on to the next
    Original, instead of ending the pass.
  - `releaseOnExit(lock, { close, timeoutMs })` runs `close` (bounded, default
    5s) before releasing the instance lock. Without options it behaves as before.
  - New `breakForeignStoreLocks(lock, dataDir)`: with the instance lock held,
    removes FileStore locks recorded by another host, for locks a SIGKILL or a
    crash still leaves behind.

- 8295681: Make the per-user quotas of `createOriginalsStore` explicit.

  - `ORIGINALS_STORE_DEFAULTS` exports the defaults. They are unchanged: 100
    recorded Originals and 25 MiB of hosted bytes per user.
  - The store reports `limits` and `usage(subject)`.
  - A refused write throws `StoreFullError`, whose message is still
    `STORE_FULL`. Its `details` name the quota (`maxOriginals` or
    `maxTotalBytes`), the limit, what is used and, for bytes, what was
    requested.
  - The 507 `store_full` answers from the Originals routes and shared-host
    saves now carry those details. Before, they were a bare
    `{ error: "store_full" }`.
  - A quota that is not a whole number of 0 or more is refused when the store
    is made.
  - The README documents all of this.

- 1eb52a9: Shared-host saves carry a child Original's parent evidence (P5.24–P5.27,
  P7.1, P14.10; originals-spec #66). Before this a host refused every entry of
  a child Original as incomplete, because the submission carried no parent log.

  - `@originals/sdk`: `Submission.parents` (`[{ did, log }]`, nearest first)
    holds each parent's log through the highest pin, as a package carries it,
    and `identities` adds the parents' signers' DID histories. `submit` fills
    both from the store; `encodeSubmission` sends `parents` only for a child.
    `retrieveHosted` and `loadPublished` read a hosted child's
    `parents/<sha256(did)>/did.jsonl` files and the parents' signers.
  - `@originals/host`: the submit route parses `parents` (at most 8, the
    nesting limit, 8 MiB each; PROVISIONAL) and verifies the entry with the
    parent log it holds or a submitted one that extends it, which it then
    stores. A diverging parent log is refused (`parent_evidence_conflict`), a
    parent the child does not name too (`parent_not_named`). Without the
    parent's log through the pin the entry is refused as incomplete
    (`PARENT_EVIDENCE_MISSING`, `PARENT_VERSION_MISSING`), never accepted; an
    entry relying on an inherited grant the held parent log has revoked is
    refused as historically authorized only (P5.26). An editor named by a
    grant in a hosted parent log may call. The hosted layout gains
    `parents/<64 hex>/did.jsonl`, which an owner's upload may only extend
    (`parent_log_not_extending`). The identity bound rises to 128 to cover
    signer sets and parents' signers.

### Patch Changes

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

- Updated dependencies [fd15702]
- Updated dependencies [874555b]
- Updated dependencies [874555b]
- Updated dependencies [0d1a2b3]
- Updated dependencies [939a0d9]
- Updated dependencies [2e8c053]
- Updated dependencies [37e7ee5]
- Updated dependencies [431defb]
- Updated dependencies [4248e63]
- Updated dependencies [1fdd945]
- Updated dependencies [3edd470]
- Updated dependencies [11b25a8]
- Updated dependencies [2a41ca4]
- Updated dependencies [f5de8cd]
- Updated dependencies [b021bd3]
- Updated dependencies [b6f626e]
- Updated dependencies [037d167]
- Updated dependencies [4619848]
- Updated dependencies [1aad0f3]
- Updated dependencies [900ed2a]
- Updated dependencies [1eb52a9]
- Updated dependencies [ebc6308]
- Updated dependencies [296a969]
- Updated dependencies [e5a3e3d]
- Updated dependencies [0f4790b]
- Updated dependencies [a0153f0]
  - @originals/vh@0.5.0
  - @originals/sdk@6.2.0

## 0.3.0

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

### Patch Changes

- Updated dependencies [bfda41c]
- Updated dependencies [7aeaf54]
  - @originals/sdk@6.0.0
  - @originals/vh@0.4.0

## 0.2.0

### Minor Changes

- d7b1f1a: New package `@originals/host`: the protocol-side server of the landing (did:webvh hosted layout and durable per-user Originals routes, shared-host saves, the `/context` document, the inscriptions store, reconciliation, block-driven completion and server-side anchoring), moved out of `apps/landing/server` without behavior changes. It runs on Bun and does not depend on `@originals/auth` or Turnkey: `createOriginalsRoutes` takes an injected `authenticate(req)` that names the session subject, and `buildFetch`/`servedWebvhHosts` take the extra did:webvh hosts an instance serves. The landing now consumes it, wiring its JWT check and legacy did:webvh domain through those seams.

### Patch Changes

- Updated dependencies [194f7ab]
- Updated dependencies [989665c]
- Updated dependencies [65d3a8a]
- Updated dependencies [0dc1980]
- Updated dependencies [ae19f3c]
- Updated dependencies [fdb4ea4]
- Updated dependencies [1ff1939]
- Updated dependencies [230855f]
  - @originals/vh@0.3.0
  - @originals/sdk@5.1.0
