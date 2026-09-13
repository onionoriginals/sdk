# Originals protocol specs — versioned profile manifest

This is the normative index for the Originals asset protocol. It answers a
single question: for a given SDK/CEL major version, which documents together
form the supported profile, and which documents are historical context only.

## Current supported profile — SDK 3.0.0, retained by SDK 4 / CEL 2

These four documents, taken together, are the complete normative contract.
None of them alone is sufficient; each defines a different layer.

| Layer | Document | Defines |
| --- | --- | --- |
| Asset identity | [`originals-asset-identity.md`](originals-asset-identity.md) | The canonical RFC 6920 `ni:///sha-256;…` asset identifier derived from the genesis event, and its relationship to did:webvh/did:btco. |
| CEL wire/proof | [`originals-cel-v3-profile.md`](originals-cel-v3-profile.md) + [`originals-cel-v3.schema.json`](originals-cel-v3.schema.json) | The `originals/cel/3` representation: canonicalization (RFC 8785 JCS), proof configuration/algorithms, and the JSON Schema for accepted documents. |
| Controller authority / publication fold | [`originals-cel-v3-authority.md`](originals-cel-v3-authority.md) | When signed values change the accepted asset state: controller authority, key rotation retirement, and inscription/publication ordering. |
| Bitcoin inscription shape | [`btco-inscription-shape.md`](btco-inscription-shape.md) | What is inscribed on Bitcoin, the boundary-history vs. delta-publication split, and reader-derived chain evidence. |

Each document's own **Status** header is the source of truth for exactly what
it covers and which prior decisions it supersedes; this manifest only records
which documents currently apply together.

## Conformance evidence

Independent, non-Originals-authored reference vectors back the wire/proof
profile above:

- [`docs/research/cel-profile-vectors/`](../docs/research/cel-profile-vectors/README.md) —
  canonicalization, full-document/proof, and transport (JSON/CBOR) corpora,
  plus published W3C known-answer vectors.
- Production tests consume these saved vectors at the public CEL verification
  boundaries — see `packages/cel/tests/v3/profile.test.ts`,
  `identity.test.ts`, `signing.test.ts`, `history.test.ts`, `values.test.ts`,
  and `known-answers.test.ts`. Changing the implementation must not regenerate
  the reference files; a passing implementation matches saved, independently
  produced expectations.
- [`docs/research/cel-core-vectors/`](../docs/research/cel-core-vectors) and
  [`docs/research/cel-authority-vectors/`](../docs/research/cel-authority-vectors)
  cover fold/history behavior with the same independent-evidence approach.

These corpora are strong independent byte/crypto/schema evidence for the
profile above. They are not a second full CEL processor or fold
implementation; if "cross-implementation" conformance requires a genuinely
separate implementation, that remains a distinct, explicitly tracked piece of
work rather than something this evidence already establishes.

## Historical / non-normative

These documents describe prior drafts or superseded decisions. None of them
states an additional requirement for the current supported profile above;
where they conflict with it, the current profile governs.

- [`../ORIGINALS_PROTOCOL_SPECIFICATION.md`](../ORIGINALS_PROTOCOL_SPECIFICATION.md) —
  the original v1.0 draft, marked historical/superseded at its own header.
- [`originals-cel-v3-profile.proposed.md`](originals-cel-v3-profile.proposed.md) —
  the intermediate CCG layout proposal, superseded by the current wire/proof
  contract and schema.
- [`did-cel-method.md`](did-cel-method.md) — the retired Originals-specific
  `did:cel` spelling, superseded by `originals-asset-identity.md`.
- [`gap-analysis.md`](gap-analysis.md) — a point-in-time comparison against an
  external DIF draft from `@originals/sdk` v1.9.0; not a current contract.

[`specs/auth/`](auth/) documents the separate `@originals/auth` package API
surface. It is not part of the asset/CEL protocol contract indexed here.
