# @originals/host

## 0.4.0

### Minor Changes

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

### Patch Changes

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

- Updated dependencies [f5de8cd]
- Updated dependencies [b6f626e]
- Updated dependencies [900ed2a]
- Updated dependencies [ebc6308]
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
