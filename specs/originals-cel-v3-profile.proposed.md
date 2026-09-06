# Originals 3.0 CEL profile: follow CCG

**Historical layout proposal. Superseded by the [wire and proof contract](originals-cel-v3-profile.md)
and [JSON Schema](originals-cel-v3.schema.json). Not implemented.**

The text below records the intermediate proposal, including its then-pending
details. The linked contract and reference corpus govern subsequent work.

For [Pin the application/cel wire and proof profile for Originals 3.0.0](https://github.com/onionoriginals/sdk/issues/559).
The owner chose CCG conformance after reviewing the explicit-extension alternative.
That alternative is no longer the recommendation or implementation target.

## What changes

The outer document is CCG CEL: `{ "log": [{ "event": ..., "proof": [...] }] }`.
The signed Original description lives inside `event.operation.data`. It includes
controller information, descriptive fields and the `resources` array. We do not
combine `operation.data` with `operation.dataReference`, or redefine the latter
as an array. This revises the resource-field placement in the earlier sketch.

`dataReference` retains its CCG meaning: one external-reference object used
instead of inline operation data. Using it to externalize a whole Original
operation would add a data-availability dependency. The initial Originals writer
therefore keeps its small operation description inline and references the media
files from the description's `resources` array.

A simplified creation entry, **illustrative and unsigned**, is:

```js
{
  log: [{
    event: {
      operation: {
        type: "create",
        data: {
          controller: "did:key:<creator-public-key>",
          name: "art.png",
          resources: [{
            id: "art.png",
            mediaType: "image/png",
            digestMultibase: "<fingerprint-of-the-PNG-bytes>"
          }]
        }
      }
    },
    proof: [/* a standards-compliant controller proof */]
  }]
}
```

This is the signed application data, not an additional unsigned document beside
the log. Multiple resources are still supported. The PNG remains raw inscription
content, and the CEL document remains CBOR metadata for a media-bearing inscription.

## Pinned references and conformance target

- CCG CEL v0.1: `c12fff8dfb76d76bcb22ad2d614eafb532ff8613`.
- JCS: RFC 8785; SHA2-256 multihash, canonical base64url-unpadded multibase for
  event/resource digests and `did:cel` derivation.
- W3C Data Integrity, ECDSA and EdDSA Recommendations dated 2025-05-15.

The [primary-source research](../docs/research/2026-09-05-cel-profile-primary-sources.md)
links immutable sources, published vectors and draft inconsistencies. Normative
rules govern; malformed/contradictory illustrative examples are not copied as
acceptance fixtures. Originals remains an application profile: CCG defines the
log structure and proof mechanisms; Originals defines its asset state and Bitcoin
rules, as CCG explicitly permits. Generic CEL parsing/proof verification does
not itself establish Originals-specific ownership or lifecycle validity.

## Document, operations and resources

A document has a nonempty `log` array. Each entry contains `event` and one or more
`proof` values. A complete Originals history starts with `create`; later entries
carry `previousEvent`. Genesis omits that field rather than using null or an empty
string. A partial on-sat publication is verified only with the already verified
prior head; it cannot be treated as a standalone complete history.

The initial Originals writer uses `operation.data` for every operation. It holds
application fields such as controller, creation nonce/time, title, resource
changes and migration aliases. `resources` is an application-defined array inside
that data object. Resource entries carry a logical id, media type and SHA2-256
multihash, plus retrieval URLs when applicable. Inline media bytes do not appear
inside a resource reference.

The parser preserves accepted JSON values exactly. It rejects duplicate names,
invalid Unicode, nonfinite numbers and non-JSON runtime values before hashing;
unknown application fields must be handled by an explicit application schema,
not silently stripped during canonicalization. Ordinary JSON property names,
including numeric-looking keys and `__proto__`, retain their values wherever
application JSON is permitted. The application schema and fold must agree on
which descriptive/resource updates are meaningful.

The operation names remain `create`, `update`, `rotateKey`, `deactivate`, and
`migrate`. CCG permits application-defined operation names in addition to its
baseline create/update/deactivate. The detailed authorization and state rules
remain owned by [Define controller authority and inscription ordering in the new CEL fold](https://github.com/onionoriginals/sdk/issues/560).

## Identity and proof preimages

Canonical event bytes are `UTF8(JCS(event))`, covering the entire validated event,
including operation data, with no field-projection shortcut. The event digest is:

```text
u + base64url_no_padding(0x12 || 0x20 || SHA256(canonicalEventBytes))
```

`did:cel` prefixes the genesis event digest with `did:cel:`. The next event's
`previousEvent` uses the same digest expression. Proofs and transport wrappers
are excluded. This is the already-decided identity change from the old format;
CCG alignment adds no new migration promise for old logs.

The stored proof type is `DataIntegrityProof` only once the standard behavior is
implemented. The old custom `OriginalsCelProof` must not simply be relabeled.
CCG requires processor support for `ecdsa-jcs-2019`; optional standardized
`eddsa-jcs-2022` support can preserve Ed25519 authoring. Mandatory ECDSA support
and its test vectors are part of this work, not deferred behind an Ed25519-only
claim of conformance.

For an entry, the unsecured Data Integrity document is the `event` object.
A generic proof adapter reconstructs `{ ...event, proof }` for standard verification;
passing `{ event, proof }` would sign a different document. All options, context
handling, proof purpose and verification-method authorization must follow the
selected standard suite. A successful signature check alone is not authorization.

Published expected canonical documents, proof configurations, hash concatenations
and signatures are retained as [independent evidence](../docs/research/cel-profile-vectors/published-w3c/README.md).
Reference comparisons pass for P-256, P-384 and Ed25519. Production acceptance must
check those same vectors. ECDSA uses the specified curve hash on the concatenated
hashes, fixed-width r || s encoding, and accepts valid high-S signatures; it must
not inherit Bitcoin transaction-signature conventions accidentally.

## Inscription and resolution

The accepted Bitcoin design continues:

- A media-bearing boundary inscription has raw head-media content and the full
  signed CEL document in CBOR metadata. Without inline media, content is the CEL
  document, with `application/cel` as its media type.
- Later publications carry the new entries since the verified on-sat head.
- No DID document or Bitcoin attestation is inscribed alongside the CEL.
- The reader derives Bitcoin evidence and the DID document from verified history.
- Sale/creator-lineage policy remains governed by the existing decision and the
  pending authority/ordering clarification; choosing CCG does not add holder writes.

JSON and CBOR must decode to the same event data before identity/proof checks.
CBOR conversion rules, document/entry limits and support for optional previousLog
chunking still need explicit profile text and rejection fixtures. They are not
settled by this layout decision alone.

## Evidence and status

[Canonicalization evidence](../docs/research/cel-profile-vectors/README.md) includes
seven independent literal output/digest cases, four rejection cases and a comparison
with the current implementation. These establish canonical-byte expectations,
not a passing new-format implementation.

The owner choice resolves the CCG-versus-extension branch. A [signed reference
creation example](../docs/research/cel-profile-vectors/ccg-create.example.json)
and independent evidence accompany the published standard-proof vectors. This
example uses a public test key and draft application fields; it has not been
accepted by the SDK or inscribed. Accepted/rejected full documents and the
remaining profile details are still required before the wire/proof ticket closes.
Implementation, tracker release gates and the new-format regtest rerun remain
outstanding.
