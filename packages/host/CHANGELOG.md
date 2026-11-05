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
