---
"@originals/vh": minor
"@originals/sdk": major
"@originals/host": minor
"@originals/landing": minor
---

Follow originals-spec #53 (`a9ecdbb`; owner decision, 1 November 2026): an
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
