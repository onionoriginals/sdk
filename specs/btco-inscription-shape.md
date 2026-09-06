# did:btco inscription shape — decision record

**Status:** Decided 2026-09-04 (design only; not implemented)
**Supersedes:** the `{ didDocument, celLog | events }` CBOR metadata shape, the `#cel`
`OriginalsCelAnchor` service, the `WitnessAttestation` content shape, holder appends,
`data.author`, and the post-anchor `rotateKey`/`deactivate` freeze.

## Wire shape

- The log is the CCG Cryptographic Event Log data model, media type `application/cel`:
  `{ log: [{ event: { previousEvent, operation: { type, data, dataReference } }, proof }] }`.
- `did:cel` = multihash of the canonicalized genesis `event` object. Every existing
  did:cel changes. Clean cut, no migration: the one mainnet Original (did:btco:321959825736830, 2026-08-21) already fails to verify under current code, so nothing that works today breaks.
- Resources live under `operation.dataReference`. Operation types: create, update,
  rotateKey, deactivate, migrate.

## What gets inscribed

- **Layer boundary (webvh → btco):** content = head media bytes; CBOR metadata = full log
  to date incl. the migrate entry. No inline media → content = the log document, no metadata.
- **Reinscription:** exactly the entries appended since the newest entry on the sat. Never a
  snapshot. New bytes → content = bytes, entries in metadata; otherwise content = entries
  document, no metadata. The writer finds the boundary by reading the sat and refuses to
  inscribe if it cannot (no in-memory boundary map).
- **No DID document on chain, ever.** No anchor service, no attestation shape, no manifest.

## Proofs

- Entries carry controller proofs only. The bitcoin witness is a derived fact ("entry E is
  in inscription X on sat S at height H"), attached by the reader, never inscribed.
  Off-chain copies may cache it; the verifier always re-derives it.
- `data.author` is removed.

## Authority post-anchor

- Append = creator-lineage signature AND inscription on the anchoring sat strictly after
  the current anchor by block height. Only the holder can inscribe, so the log freezes at
  sale and thaws if a lineage keyholder re-acquires the sat.
- No holder writes. Author classes, the holder allowlist, and `holders` in the verify
  result are removed.
- update, rotateKey, deactivate allowed post-anchor; migrate is not (btco is terminal).

## Reading (did:btco resolution)

- Enumerate the sat oldest → newest. An inscription is part of the log iff it parses as
  `application/cel` entries, chains by previousEvent from the current verified head, and
  is signed by a lineage key. Everything else on the sat is invisible (never poison).
  Earliest valid inscription wins on a fork.
- The DID document is emitted from the fold: id, verificationMethod = fold controller,
  alsoKnownAs = did:cel + did:webvh, live sat ownership in didDocumentMetadata.
- Entries may be read from provider metadata (they are signed and chained), so the
  resolver's "DID doc only from content" rule is dropped.

## Affected, out of scope

- The hosted webvh-layer log should become the same `application/cel` document.
