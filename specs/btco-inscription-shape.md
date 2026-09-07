# did:btco inscription shape — decision record

**Status:** Decided 2026-09-04. On 2026-09-05 the owner committed it to **3.0.0** (recorded on #521 and the release map #519). Implemented and verified on local Core/ord in the SDK 3.0.0 candidate; production acceptance remains a separate release gate.
**Supersedes:** the `{ didDocument, celLog | events }` CBOR metadata shape, the `#cel`
`OriginalsCelAnchor` service, the `WitnessAttestation` content shape, holder appends,
`data.author`, and the post-anchor `rotateKey`/`deactivate` freeze.

## Wire shape

- The log is the CCG Cryptographic Event Log data model, media type `application/cel`:
  `{ log: [{ event: { previousEvent, operation: { type, data } }, proof }] }`.
- `did:cel` = multihash of the canonicalized genesis `event` object. Every existing
  did:cel changes. Clean cut, no migration: the one mainnet Original (did:btco:321959825736830, 2026-08-21) already fails to verify under current code, so nothing that works today breaks.
- **CCG conformance clarification, 2026-09-05 (owner selected):** the Original
  description, including controller information and its `resources` array, lives
  under `operation.data`. Do not combine it with `operation.dataReference`; that
  field retains CCG's meaning of one external reference used instead of inline data.
  This supersedes the earlier resource-placement sketch. Operation types: create,
  update, rotateKey, deactivate, migrate. The [wire/proof contract](originals-cel-v3-profile.md)
  and [JSON Schema](originals-cel-v3.schema.json) record the precise representation.

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

- Append = current-controller signature AND inscription on the anchoring sat strictly
  after the current accepted publication by block height. The owner clarified that
  rotation A → B retires A's authority for future entries; old signatures remain
  valid for their historical entries. Reacquiring the sat does not reactivate A.
  The holder cannot independently author changes, but can publish bytes already
  authorized by the current controller. The [authority and ordering contract](originals-cel-v3-authority.md)
  defines this distinction and applies the height gate once per whole publication.
- No holder writes. Author classes, the holder allowlist, and `holders` in the verify
  result are removed.
- update, rotateKey, deactivate allowed post-anchor; migrate is not (btco is terminal).

## Reading (did:btco resolution)

- Enumerate the sat oldest → newest. An inscription is part of the log iff it parses as
  `application/cel` entries, chains by previousEvent from the current verified head, and
  is signed by the controller authorized at each entry. Inspected invalid bytes
  are invisible; unavailable or incomplete evidence is not treated as junk.
  Earliest valid whole publication wins on a fork, ordered by creation block,
  transaction position, then numeric inscription index.
- The DID document is emitted from the fold: id, verificationMethod = fold controller,
  alsoKnownAs = did:cel + did:webvh, live sat ownership in didDocumentMetadata.
- Entries may be read from provider metadata (they are signed and chained), so the
  resolver's "DID doc only from content" rule is dropped.

## Affected, out of scope

- The hosted webvh-layer log should become the same `application/cel` document.
