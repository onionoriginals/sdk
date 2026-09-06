# Originals CEL 3 wire and proof profile

Status: implementation contract, selected direction approved by the owner on
2026-09-05. **Not an implemented or certified processor.** This completes the
representation portion of [Pin the application/cel wire and proof profile for
Originals 3.0.0](https://github.com/onionoriginals/sdk/issues/559).

This document and its [JSON Schema](originals-cel-v3.schema.json) specify the
representation. The [inscription decision](btco-inscription-shape.md) specifies
the asset's Bitcoin shape. [Controller authority and inscription ordering](https://github.com/onionoriginals/sdk/issues/560)
still owns the authorization and on-chain fold; wire/proof acceptance alone is
not asset verification. Repository code at
`071b898420dd1052f4e4d34a27e59bea167784d0` still implements the old CEL shape.

## References and conformance

Normative references are pinned:

- [CCG CEL v0.1](https://github.com/w3c-ccg/cel-spec/blob/c12fff8dfb76d76bcb22ad2d614eafb532ff8613/index.html),
  revision `c12fff8dfb76d76bcb22ad2d614eafb532ff8613` (community draft).
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html), JCS; [RFC 8949](https://www.rfc-editor.org/rfc/rfc8949.html), CBOR.
- W3C Recommendations dated 15 May 2025: [Data Integrity](https://www.w3.org/TR/2025/REC-vc-data-integrity-20250515/),
  [ECDSA](https://www.w3.org/TR/2025/REC-vc-di-ecdsa-20250515/),
  [EdDSA](https://www.w3.org/TR/2025/REC-vc-di-eddsa-20250515/).
- [Controlled Identifiers, 15 May 2025](https://www.w3.org/TR/2025/REC-cid-1.0-20250515/)
  and [did:key revision 2cc490c38c5aacf58497a87fc0cf8794668bf716](https://github.com/w3c-ccg/did-key-spec/blob/2cc490c38c5aacf58497a87fc0cf8794668bf716/index.html).

Originals follows CCG's data model and required ECDSA suite. Its application
restrictions are identified below; they are not extra requirements imposed by
CCG on other applications. The draft has contradictory illustrative examples
and algorithm field paths. Its normative data model, the pinned cryptosuite
algorithms, and the explicit event preimage below govern this profile. Do not
use malformed draft examples as acceptance vectors. See the
[source analysis](../docs/research/2026-09-05-cel-profile-primary-sources.md).

CCG `dataReference` and `previousLog` remain valid CCG features. Originals 3
uses inline operation descriptions and does not use external log chunks.
Recognize their CCG shapes, then return an explicit unsupported-Originals-feature
result; do not relabel them malformed CCG or silently omit them. Supporting this
application profile does not claim support for every CCG application, witness
mechanism, extension, or retrieval protocol.

## Exact document structure

An Originals document is a JSON object with exactly one member, `log`, containing
1–10,000 entries. Each entry has exactly `event` and `proof`.

- `event` has `operation` and, except at creation, `previousEvent`.
- `operation` has exactly `type` and `data` for this application profile.
  `type` is `create`, `update`, `rotateKey`, `deactivate`, or `migrate`.
- `data` is an object matching the operation schema below. Every operation signs
  `profile: "originals/cel/3"`; a different or missing profile is unsupported.
- `proof` is either one proof object or an array of 1–8 proof objects. Writers
  emit an array. Array order has no authority or threshold meaning.
- A `create` event omits `previousEvent`; all other events require it. Null and
  empty-string alternatives are invalid. No other event-level members occur.

Unknown structural/application members are rejected, never stripped or promoted
into authority fields. Arbitrary application JSON belongs inside `metadata`.
Every permitted value is retained and signed, including own `__proto__`,
`constructor`, `prototype`, numeric-looking, and Unicode member names there.
The meaning of those strings is just data; they do not select a verifier.

A complete history starts with exactly one `create`; each following entry links
to its immediate predecessor. A delta document has the same structure but
starts with a non-create event and requires an already verified prior history.
With no prior history it yields `history-required`, never a verified new asset.
Reinscription deltas are not CCG `previousLog` chunks.

The media type used by the selected CCG draft and this application is
`application/cel`. This is a draft-defined media type, not a claim of a separate
IANA registration or a W3C Recommendation for CEL itself.

## Operation data

All rows require `profile`. All field lists are closed except nested `metadata`.
The Schema describes structural acceptance; state-dependent checks remain in
the fold. Times use this application's shared RFC 3339/XSD dateTimeStamp subset:
four-digit years 0001–9999, real calendar dates, uppercase T/Z, hours 00–23,
minutes/seconds 00–59, optional 1–9 fractional digits, and UTC Z only. Retain
accepted strings verbatim; writers use UTC with milliseconds. Leap seconds,
lowercase t/z and timezone offsets are outside this profile. A signed time is
the author's claim, not Bitcoin time
or independent evidence of freshness.

| Operation | Required data members besides profile | Optional members |
| --- | --- | --- |
| `create` | `controller`, `createdAt`, `nonce`, `resources` | `name`, `metadata` |
| `update` | At least one of `name`, `metadata`, `resources` | The other two update fields |
| `rotateKey` | `newController`, `rotatedAt` | None |
| `deactivate` | `deactivatedAt` | `reason` |
| `migrate` | `from`, `to`, `layer`, `migratedAt` | None |

Creation `nonce` is unpadded base64url of exactly 16 bytes, with no multibase
prefix. Writers use fresh cryptographically random bytes for each intended new
asset; fixed values are for fixtures only. This distinguishes otherwise
identical creations. Readers check encoding, not unverifiable randomness.
Creation does not contain a declared asset DID: `did:cel` is always derived.

`name` and `reason` are strings. `metadata` is a JSON object. In an update,
supplied `name`/`metadata` replace the respective value in full; omitted fields
leave it unchanged. An empty metadata object clears metadata. No JSON Merge
Patch semantics or implicit special handling of member names applies.

Creation `resources` is an ordered array of 0–1,024 descriptors. A descriptor
has required `id`, `mediaType`, `digestMultibase`, and optional `url`. An update's
`resources` is an ordered, nonempty array of descriptors, each additionally
requiring `previousDigestMultibase`. Resource ids are nonempty strings, unique
within each operation and compared exactly without Unicode normalization.
Each update replaces the descriptor for that existing id and must link to its
currently accepted byte digest. This represents the existing resource-version
journey; adding/removing logical resource identities after creation is not
introduced by this wire change. Versions are derived from accepted updates,
not trusted from a supplied counter. A change of retrieval URL can retain the
same byte digest. URLs are signed locators, never authority.

`url`, when present, is an array of 1–16 absolute URLs. Each must parse using
the WHATWG URL parser with no base, have a scheme matching
`[A-Za-z][A-Za-z0-9+.-]*:`, contain no ASCII whitespace/control characters or
backslashes, and use only valid percent escapes. HTTP(S) URLs require `//` and
a nonempty host. Keep the original string, not the parser's normalized output;
validation never fetches it. Resource retrieval policy is separate.

`mediaType` uses this application's bare lowercase media-type subset: each of
the two slash-separated names matches `[a-z0-9][a-z0-9!#$&^_.+-]{0,126}`.
Parameters and uppercase spellings are outside this profile; no parser silently
normalizes them after signing. Schema `format` labels describe these semantic
checks; because JSON Schema treats formats as annotations by default, passing
a schema validator alone is insufficient. A descriptor contains references
only, never embedded file bytes,
private key material, or a resource manifest outside the signed log. Resource
digests hash the exact raw file bytes; event digests hash JCS JSON.

`controller` and `newController` use canonical `did:key:z...` public-key
identifiers. The supported public-key codecs are Ed25519 (`0xed`), P-256
(`0x1200`), and P-384 (`0x1201`), with their standard key encodings. Decode and
validate the actual key, canonical multicodec varint and multibase; a prefix
match is insufficient. Secp256k1 Bitcoin keys do not select this ECDSA suite.

Migration `from`/`to` are the current and destination asset aliases; `layer` is
`webvh` or `btco` and must agree with `to`. Exact identifier syntax and matching
against verified aliases belong to the shared DID/fold validation, never a
string-prefix-only trust check. `did:btco` contains the network and decimal sat
number; no numeric satoshi value or separate contradictory network is signed.
The boundary entry signs the selected sat before transaction construction;
transaction id, inscription id, height and block hash are derived afterwards.
The permitted journey remains `did:cel → did:webvh → did:btco`.

## Canonical values and identity

All input paths validate the same JSON value model before hashing. Text parsing
must reject duplicate decoded member names (including escaped aliases) before
ordinary object construction loses them. Reject invalid UTF-8, lone Unicode
surrogates, nonfinite numbers, non-JSON runtime values, cycles, array holes,
accessors and class instances. Runtime input must be plain data: own enumerable
string-valued property names, JSON values and ordinary arrays. Do not execute
getters or `toJSON` while validating or hashing. Preserve a valid own
`__proto__` property with a data-safe representation.

JCS recursively sorts keys by UTF-16 code units, preserves array order and
strings without Unicode normalization, uses ECMAScript binary64 number
serialization (`-0` becomes `0`), and emits UTF-8 without whitespace. Rebuilding
an object and calling `JSON.stringify` is insufficient for numeric-looking keys.
Arbitrary precision application integers must be represented as decimal strings.

For a validated event E:

```text
B(E) = UTF8(JCS(E))
D(E) = "u" + base64url_unpadded(0x12 || 0x20 || SHA256(B(E)))
did:cel = "did:cel:" + D(genesis.event)
next.event.previousEvent = D(previous.event)
```

Digest decoding must yield exactly the two prefix bytes and 32 digest bytes and
round-trip to the same string; padding, alternate bases, alternate algorithms
and noncanonical trailing bits are rejected. Resource digests use the same
expression with raw file bytes in place of B(E). Proofs, JSON whitespace,
CBOR encodings and transport wrappers do not affect event identity. All validated
event members do. A requested `did:cel` must match the derived genesis identifier;
no `data.did` or other legacy discriminator bypasses that comparison.

## Controller proofs

Every proof is a Data Integrity proof with exactly these required fields:
`type: "DataIntegrityProof"`, `cryptosuite`, `verificationMethod`,
`proofPurpose: "assertionMethod"`, and `proofValue`. `created` is optional;
writers include it. This profile uses context-free JSON: event-level `@context`,
proof-level `@context`, custom proof vocabulary, proof chains (`previousProof`),
domain/challenge options and extra witness fields are unsupported. Application
metadata can contain these strings as ordinary data.

The unsecured Data Integrity document is **the event object E**. To use a
standard secured-document verifier with a CEL entry, construct `{...E, proof}`;
do not pass `{event: E, proof}`. Remove only `proofValue` from the current proof
to construct P. No document context exists to copy into P in this profile.
No proof field is silently dropped. Cryptosuite option validation and Data
Integrity proof-purpose/verification-method validation are mandatory.

| Suite | Key | Hash H | Signature bytes |
| --- | --- | --- | --- |
| `ecdsa-jcs-2019` | P-256 | SHA-256 | 64, fixed-width r || s |
| `ecdsa-jcs-2019` | P-384 | SHA-384 | 96, fixed-width r || s |
| `eddsa-jcs-2022` | Ed25519 | SHA-256 | 64, Pure Ed25519 |

```text
M = H(UTF8(JCS(P))) || H(B(E))
ECDSA: sign M as a message using H (equivalently, sign H(M) in a prehashed API)
Ed25519: Pure-Ed25519.sign(M), not Ed25519ph
proofValue = "z" + base58btc(signatureBytes)
```

Accept valid high-S ECDSA signatures. Do not use DER encoding, secp256k1,
Bitcoin's sighash rules, or a low-S acceptance restriction. Deterministic ECDSA
is recommended by the standard; valid randomized signatures need not match
deterministic fixture bytes. Reject wrong signature lengths, noncanonical base
encodings, invalid curve points, suite/key mismatches and invalid signatures.

Implement both required ECDSA curves for generation and verification. Also
support standard Ed25519 generation and verification for existing signer types.
Writers expose their selected algorithm explicitly; this representation contract
does not silently change an existing configured Ed25519 signer. Unsupported
signers fail before publication. Ed25519-authored entries
require readers supporting that additional suite; baseline-only CCG readers
are not guaranteed to accept them.

For these did:key controllers, the verification method is exactly
`controller + "#" + publicKeyMultibase`, with the same decoded key. This explicitly
follows the did:key examples' full fingerprint fragment, resolving the pinned
draft algorithm's contradictory `multicodecValue` fragment wording. The local
did:key document binds that key under `assertionMethod`; no remote key lookup
or caller-provided always-true callback substitutes for that relationship.
The generic Data Integrity check establishes the proof's signer. The Originals
fold must separately establish that signer was authorized at this event. It
must not use today's resolved controller as a shortcut for all historical events.

All supplied proofs must validate and satisfy the applicable controller policy;
one valid proof does not excuse another invalid or unsupported proof. Multiple
proofs do not create a multisignature or witness policy. Thresholds, retired-key
authority and rotation handoff are not inferred from proof count/order. Those
authority rules belong to the linked fold decision. Bitcoin evidence is always
derived by the reader, never a stored Data Integrity proof in the log.

## JSON and CBOR transport

JSON is UTF-8 containing one complete document, optionally with JSON whitespace.
Reject a byte-order mark and trailing non-whitespace input. Writers emit compact
JCS JSON for reproducible files; readers need not require canonical presentation.

CBOR metadata is the same document with **text map keys**, without numeric-key
abbreviations. Writers use RFC 8949 core deterministic encoding, normalize
negative zero to integer zero, encode integral values in CBOR's integer range
as shortest integers, and otherwise use the shortest float width preserving
the exact binary64 value. Readers accept
definite-length alternate map order/number widths if the decoded value is
unchanged. Reject duplicate text keys before a Map/object loses them, non-text
keys, tags, byte strings, undefined/simple values other than false/true/null,
nonfinite floats, invalid UTF-8, indefinite lengths, and trailing CBOR items.
An integer must convert exactly to a finite binary64 value (otherwise reject;
never round a CBOR integer silently). Floats are finite binary64 JSON values.
Always apply JCS to the decoded event, never hash CBOR bytes for its identity.

This is an application CBOR subset, not a claim that rejected constructs are
invalid in general CBOR. File bytes are outside this subset: they remain raw
inscription content, or explicit base64 in the separately versioned AssetEnvelope.

Enforce these limits consistently before signing and while reading; they are
application limits, not substitutes for Bitcoin transaction/fee limits:

| Limit | Maximum |
| --- | --- |
| Encoded document AND canonical decoded document | 10,000,000 bytes each |
| Entries per document | 10,000 |
| Proofs per entry | 8 |
| Nested containers, counting the root as depth 1 | 64 |
| JSON values including containers, excluding member names | 100,000 |
| UTF-8 bytes of any string or member name | 262,144 |
| Resources per operation | 1,024 |
| URLs per resource | 16 |

Measure both encoded and decoded/canonical sizes; compressed CBOR cannot bypass
decoded limits. Limit errors are explicit and cannot mean verified. The existing
regtest HTTP provider has a separate 5 MiB response cap; implementations must
reconcile transport limits or report the smaller supported transport limit
before writing. A full boundary document too large for an inscription must fail
before funding/signing Bitcoin transactions; this profile promises no chunking
escape hatch or automatic fee acceptance.

## Public verification boundaries and results

These are behavioral boundaries, not frozen export names:

1. **Decode/encode:** JSON/CBOR/raw runtime data → validated, losslessly retained
   values; explicit parse/profile/limit errors. Parsing supplies no authority.
2. **Event identity and proof verification:** validated event/proofs → canonical
   bytes, digest and authenticated signer(s), with exact failure reasons.
3. **History verification/fold:** complete log or verified-prefix plus delta →
   chain and authorized asset state, or missing/invalid history. The current
   `verifyEventLog` and asset `verify`/`loadAsset` must converge on this boundary.
4. **Resolution:** requested DID plus provider observations → the same verified
   state, separately qualified Bitcoin evidence and live ownership. Resource
   bytes must match the accepted descriptor before being reported verified.
5. **Write:** `createAsset`/append/publish/inscribe validate, sign, and verify the
   resulting entry before committing state or publishing bytes. A signer failure
   cannot become an unsigned successful operation.

At minimum distinguish `invalid` (malformed or failed validation),
`unsupported` (recognized CCG feature/version/suite outside this application),
`history-required` (valid delta needing its verified prefix), and successful
checks with their scope. No parse-only, signature-only, offline-btco, partial
provider or unchecked custom-verifier result may be presented as a fully verified
Original. The fold/resolver decides how invalid unrelated sat publications are
skipped without claiming unavailable history is complete.

Legacy `{events:...}`, `{celLog:...}`, `{didDocument,celLog}`, entry-level
`type`/`data`, custom `OriginalsCelProof`, old suite labels, `transfer`, holder
`author`, `witnessedAt` and stored Bitcoin proof fields do not verify under this
profile. This is the previously selected clean cut, not an automatic migration.

## Evidence and remaining implementation work

The [reference corpus](../docs/research/cel-profile-vectors/README.md) supplies
complete signed creation/continuation documents, canonical bytes, event/resource
digests, did:cel values, JSON/CBOR equivalence, negative documents and published
W3C cryptographic known answers. Expected values come from literal published
vectors and independent reference tools; no Originals production code generates
the expectations. Corpus success is not new-SDK or regtest success.

The implementation gate must run the corpus through the public boundaries above,
then run the actual creator/recovery journey with the new representation.
Authority, publication ordering, reorganization and completeness examples still
need the separate fold decision. This wire contract does not close those tickets,
deploy anything, or authorize public-chain transactions.
