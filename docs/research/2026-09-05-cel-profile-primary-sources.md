# CEL wire and proof profile: primary-source research

Research for #559, checked 2026-09-05. **This note records evidence and recommendations, not an accepted Originals profile.** Repository instructions and the [decided inscription shape](../../specs/btco-inscription-shape.md) were read first. Implementation and tracker state were not changed.

**Owner-choice update:** Brian subsequently selected strict CCG alignment. The initial alternatives below are retained as research history; the final section records the updated direction and mandatory-suite evidence. The extension route is no longer pending.

## Pinned CEL draft and its limits

`w3c-ccg/cel-spec` HEAD was **`c12fff8dfb76d76bcb22ad2d614eafb532ff8613`**, committed 2024-12-19. It identifies itself as a community draft. Use this immutable revision rather than the moving rendered page. [Source](https://github.com/w3c-ccg/cel-spec/blob/c12fff8dfb76d76bcb22ad2d614eafb532ff8613/index.html#L16-L24)

The normative model requires:

- A nonempty `log`; each entry has `event` and one or more Data Integrity proofs.
- `operation.type`; baseline operations `create`, `update`, `deactivate`, with application-defined additions permitted.
- **Exactly one** of `operation.data` and `operation.dataReference`.
- A **single reference object**, containing required `digestMultibase`, optional `mediaType`, and optional nonempty `url` array. Digests use base64url-unpadded multibase plus SHA2-256 multihash.
- `previousEvent` for non-create operations, referring to the immediately preceding event.
- Optional `previousLog`: external reference plus proof; default log limit 10 MB, application-overridable.

Processors must support **`ecdsa-jcs-2019`**. Applications define control, state folding, and witness validation; alternative proof/serialization mechanisms are permitted. [Normative model](https://github.com/w3c-ccg/cel-spec/blob/c12fff8dfb76d76bcb22ad2d614eafb532ff8613/index.html#L391-L622), [application requirements](https://github.com/w3c-ccg/cel-spec/blob/c12fff8dfb76d76bcb22ad2d614eafb532ff8613/index.html#L1206-L1241)

The draft is internally inconsistent: examples place proofs inside data or omit required proofs; compact examples replace reference/proof objects with strings. Algorithms address `event.type` instead of `event.operation.type`, leave event-hash canonicalization unspecified, and alternate between signing events and witness digests. These are not reliable implementation vectors. [Examples](https://github.com/w3c-ccg/cel-spec/blob/c12fff8dfb76d76bcb22ad2d614eafb532ff8613/index.html#L625-L826), [algorithms](https://github.com/w3c-ccg/cel-spec/blob/c12fff8dfb76d76bcb22ad2d614eafb532ff8613/index.html#L970-L1200)

## Comparison with Originals' settled decisions

The [decision record](../../specs/btco-inscription-shape.md) already settles media bytes as inscription content, log entries in CBOR metadata, no on-chain DID document, controller-only proofs, reader-derived Bitcoin evidence, creator-lineage authority, and ordered incremental reinscriptions. None needs reopening for this research.

The remaining layout choice is precise: retaining inline controller/application data **and** multiple resource references requires an explicit Originals extension; strict upstream structure needs a different placement. An array in `dataReference`, or simultaneous `data`/`dataReference`, cannot be described as unchanged upstream syntax. Brian's choice is pending. Likewise, an Ed25519-only processor must qualify its upstream conformance claim; alternative application proofs do not erase the separate mandatory ECDSA statement above.

## A standards-based Ed25519 option

Pin the W3C Recommendation **15 May 2025**, not the editor's draft. Its `eddsa-jcs-2022` construction is:

```text
P = proof options, excluding proofValue
M = SHA256(UTF8(JCS(P))) || SHA256(UTF8(JCS(unsecuredDocument)))
signature = Pure-Ed25519.sign(M)
proofValue = base58btc-multibase(signature)
```

It requires `type: DataIntegrityProof`, `cryptosuite: eddsa-jcs-2022`, exact option/context handling, and Ed25519 Multikey encoding. Validate both identifiers even though transformation's condition uses “and”; proof configuration uses “or.” [Algorithms and key format](https://www.w3.org/TR/2025/REC-vc-di-eddsa-20250515/#eddsa-jcs-2022)

**Recommendation if this suite is chosen:** define `unsecuredDocument = event`. A generic verification adapter must reconstruct `{ ...event, proof }`; passing `{ event, proof }` instead secures a different wrapper. Signing a digest would require a specified JSON digest document and its canonicalization; signing raw digest bytes alone is not this suite. Keep this adapter choice explicit in vectors.

Published independent suite vectors are in **Appendix B.3, examples 29–39**: keys, document, canonical forms, both hashes, concatenation, signature, encoded proof. Match every intermediate value, not only final verification. [W3C vectors](https://www.w3.org/TR/2025/REC-vc-di-eddsa-20250515/#representation-eddsa-jcs-2022)

Data Integrity additionally requires purpose/verification-method semantics; signature validity alone does not establish authorization. Context-free JSON is permitted when JSON-LD processing is not intended, but Data Integrity/cryptosuite extensions then must not be introduced. **Recommendation:** fixed recognized proof fields, `assertionMethod`, an explicitly validated controller relationship at that event, and a documented context policy. Arbitrary application data is separate from extending proof vocabulary. [Proofs and purposes](https://www.w3.org/TR/2025/REC-vc-data-integrity-20250515/#proofs), [context injection](https://www.w3.org/TR/2025/REC-vc-data-integrity-20250515/#context-injection), [verification relationships](https://www.w3.org/TR/2025/REC-vc-data-integrity-20250515/#verification-relationship-validation)

The current implementation writes `OriginalsCelProof` / `originals-cel-ed25519-jcs-v1` and retains a historical read path. Its two-hash construction resembles the standard, but this does **not** establish standards conformance. Preserve the honest custom labels unless the complete standards behavior above is intentionally implemented and independently validated. [Current labels and dispatch](../../packages/cel/src/proofVerification.ts), [current signing preimage](../../packages/cel/src/canonicalize.ts), [current signer](../../packages/cel/src/signerAdapter.ts)

## Canonicalization and independent vectors

RFC 8785 requires JSON compatible with I-JSON: no duplicate object names; Unicode strings without lone surrogates; finite IEEE-754 binary64 numbers; preservation of strings without Unicode normalization. JCS recursively sorts raw property names by UTF-16 code units, including objects within arrays, while preserving array order. It uses ECMAScript primitive serialization, emits no inter-token whitespace, and outputs UTF-8. `-0` serializes as `0`. JSON serialization alone is insufficient. [RFC 8785 §§3.1–3.2](https://www.rfc-editor.org/rfc/rfc8785.html#section-3)

Recommended independent acceptance fixtures:

- RFC 8785 §3.2.2–3.2.4: canonical text, unusual Unicode property ordering, exact UTF-8 hex output.
- RFC 8785 Appendix B: binary64 bit patterns and expected numeric strings, including negative zero, exponent boundaries, subnormal values, and rejection of NaN/infinity. [Published RFC vectors](https://www.rfc-editor.org/rfc/rfc8785.html#appendix-B)
- RFC author's `cyberphone/json-canonicalization`, pinned **`19d51d7fe467d4706a3ff08adf8a748f29fc21e0`**: corresponding `testdata/input`, `output`, and `outhex`; independently supplied expected bytes. [Pinned corpus](https://github.com/cyberphone/json-canonicalization/tree/19d51d7fe467d4706a3ff08adf8a748f29fc21e0/testdata)
- RFC 8032 §7.1: primitive Ed25519 known-answer tests, including the empty-message vector. These verify the primitive, not the CEL message/profile. [Ed25519 vectors](https://www.rfc-editor.org/rfc/rfc8032.html#section-7.1)

**Boundary recommendations:** detect duplicate names before ordinary `JSON.parse` loses them; reject non-JSON runtime objects before signing; use decimal strings for application integers outside the exact interoperable range. Pin CBOR to the chosen JSON data model: non-text map keys, byte strings, tags, and duplicate keys need explicit rejection or explicit mapping. Canonicalize the decoded JSON event for identity/signatures; do not silently make alternative CBOR encodings different event identities. [I-JSON constraints](https://www.rfc-editor.org/rfc/rfc7493.html#section-2), [CBOR-to-JSON conversion choices](https://www.rfc-editor.org/rfc/rfc8949.html#section-6.1)

## Decisions still needed before implementation

1. Exact operation/reference extension versus strict upstream layout, including multiple resources.
2. Retain the explicit custom proof profile or implement the complete standards suite; exact signed object and allowed proof fields either way.
3. Closed versus explicitly namespaced extensible fields; genesis `previousEvent` prohibition; one/multiple controller proof policy; parser size/depth/count limits and unsupported chunk handling.

These should be resolved in the concrete #559 profile and fixed vectors. This note does not claim general CCG interoperability, a passing implementation, or acceptance of any proposal.

## Owner choice updated: strict CCG and the ECDSA baseline

Brian selected strict CCG alignment. The implementation proposal will place the signed Original descriptor, controller and resource-reference array inside `operation.data`, with `operation.dataReference` absent. This resolves the XOR/cardinality conflict. Raw media content and log metadata remain the intended inscription transport. This records the selected direction, not implementation completion.

Pin **Data Integrity ECDSA Cryptosuites v1.0, 15 May 2025**. `ecdsa-jcs-2019` uses P-256/SHA-256 or P-384/SHA-384; Bitcoin's secp256k1 is different. The proof has `type: DataIntegrityProof`, `cryptosuite: ecdsa-jcs-2019`, Data Integrity proof options, and base58btc-multibase `proofValue`. Copy document context into proof options when present. [Recommendation §§2–3.3](https://www.w3.org/TR/2025/REC-vc-di-ecdsa-20250515/#ecdsa-jcs-2019)

```text
H = SHA256 for P-256; SHA384 for P-384
P = proof options excluding proofValue, with the prescribed context handling
M = H(UTF8(JCS(P))) || H(UTF8(JCS(unsecuredDocument)))
signature = ECDSA.sign(message=M, messageHash=H)
```

ECDSA hashes `M` again as its message; a prehashed-input API therefore receives `H(M)`. Signature bytes are fixed-width `r || s`, 64 bytes for P-256 or 96 for P-384, before multibase encoding; they are not DER. [Signature algorithm](https://www.w3.org/TR/2025/REC-vc-di-ecdsa-20250515/#proof-serialization-ecdsa-jcs-2019), [RFC 4754 §7](https://www.rfc-editor.org/rfc/rfc4754.html#section-7)

Deterministic ECDSA is recommended, not mandatory. Published vectors use it: **A.5 examples 49–59** and **A.6 examples 60–70** supply keys through signatures. Randomized signatures can differ while verifying. [W3C vectors](https://www.w3.org/TR/2025/REC-vc-di-ecdsa-20250515/#test-vectors), [RFC 6979](https://www.rfc-editor.org/rfc/rfc6979.html#section-3.2)

The [saved literal examples and runnable comparison](cel-profile-vectors/published-w3c/README.md) reproduce both ECDSA sets and the Ed25519 set. With Noble 2.2.0, both ECDSA vectors verify and produce matching deterministic signatures using `prehash: true, lowS: false`; both fail without message hashing. The published P-384 signature fails with `lowS: true`: imposing Bitcoin-style low-S validation would reject that standard vector. Independent `json-canonicalize` 2.0.0 and Node crypto match the published canonical strings and all intermediate hashes. These observations cover fixture cryptography only, not complete processor conformance.

**Conformance interpretation:** a fully implemented standard `eddsa-jcs-2022` writer can coexist with mandatory `ecdsa-jcs-2019` support. The pinned CEL draft requires at least the ECDSA suite, not an ECDSA signature on every entry, and permits application proof alternatives. Implement actual ECDSA generation/verification for its applicable curves and standard Data Integrity processing before claiming that support. An EdDSA document still needs a reader supporting that optional suite; baseline-only CCG readers are not guaranteed to accept it. This is an evidence-backed conformance strategy, not a new owner choice or a completed implementation claim. [Pinned CEL proof requirements](https://github.com/w3c-ccg/cel-spec/blob/c12fff8dfb76d76bcb22ad2d614eafb532ff8613/index.html#L417-L445), [application mechanisms](https://github.com/w3c-ccg/cel-spec/blob/c12fff8dfb76d76bcb22ad2d614eafb532ff8613/index.html#L1216-L1241)

## ADDENDUM: application boundaries, controller authorization and CBOR identity

Checked 2026-09-05 against the same CEL pin and fixed Recommendations. Strict CCG alignment is the owner-approved direction; the restrictions below are recommendations for its Originals application profile, not claims of implemented behavior.

### General CEL requirements versus application capability

**Normative source facts:** `previousLog` is optional, but when present requires an external-reference object **and its proof**. `operation.dataReference` is an alternative to inline `data`, with one reference object; its `digestMultibase` is required, while `mediaType` and a nonempty URL list are optional. Retrieval without URLs is application-specific. The draft supplies no universal retrieval protocol or complete previous-log proof-target procedure. [Log model](https://github.com/w3c-ccg/cel-spec/blob/c12fff8dfb76d76bcb22ad2d614eafb532ff8613/index.html#L391-L445), [reference and operation models](https://github.com/w3c-ccg/cel-spec/blob/c12fff8dfb76d76bcb22ad2d614eafb532ff8613/index.html#L496-L622)

CCG requires one or more proofs. Its referenced Data Integrity model permits **a single proof object or an unordered set of proof objects**; `created` is optional. Exactly one proof, array-only input, mandatory `created`, and a closed structural-property allowlist are application restrictions, not universal CEL syntax. The draft verifier attempts every proof and raises on any failure; silently ignoring an unsupported proof does not establish whole-log verification under that algorithm. [Data Integrity proofs](https://www.w3.org/TR/2025/REC-vc-data-integrity-20250515/#proofs), [CEL verifier](https://github.com/w3c-ccg/cel-spec/blob/c12fff8dfb76d76bcb22ad2d614eafb532ff8613/index.html#L1164-L1200)

**Recommendation:** distinguish malformed CEL, unsupported Originals capability, unavailable referenced data, and failed verification. Inline-only data, unchunked logs, and a restricted controller/proof policy can define the application's accepted subset; report otherwise-valid references/chunks as unsupported by Originals. Do not describe this as an unrestricted CEL reader. No blanket requirement to fetch every optional feature was found, but `create`/`update`/`deactivate` and `ecdsa-jcs-2019` remain explicit processor MUSTs. Application control, state folding and witness validation must still be specified. [Conformance](https://github.com/w3c-ccg/cel-spec/blob/c12fff8dfb76d76bcb22ad2d614eafb532ff8613/index.html#L328-L350), [application algorithms](https://github.com/w3c-ccg/cel-spec/blob/c12fff8dfb76d76bcb22ad2d614eafb532ff8613/index.html#L1206-L1241)

### Context-free JCS and did:key authorization

**Normative:** applications not intending JSON-LD processing may omit top-level `@context`; they then must not introduce Data Integrity or cryptosuite extensions. This does not prohibit ordinary application payload fields. A context-free profile can use fixed standard proof semantics. If context-bearing documents are accepted, follow prescribed context validation and JCS suite context-copying rules; arbitrary context omission during verification is not equivalent. [Context injection and validation](https://www.w3.org/TR/2025/REC-vc-data-integrity-20250515/#contexts-and-vocabularies), [ECDSA JCS algorithms](https://www.w3.org/TR/2025/REC-vc-di-ecdsa-20250515/#ecdsa-jcs-2019)

For public `Multikey`, P-256 uses prefix bytes `80 24` followed by 33 compressed key bytes; P-384 uses `81 24` followed by 49. Encode the complete bytes in base58btc with `z`. These are public-key prefixes, distinct from secret-key encodings. [Controlled Identifiers §2.2.2](https://www.w3.org/TR/2025/REC-cid-1.0-20250515/#multikey)

The verification-method retrieval algorithm checks the requested URL, controller document ID, resolved fragment, exact absolute method ID, method controller, and membership in the requested verification relationship. **Recommendation:** require `assertionMethod`, perform those checks against the offline-derived did:key document, then separately match that controller against authority established by the verified Originals log position. Decoding a public key from the DID alone is insufficient. [Retrieval algorithm](https://www.w3.org/TR/2025/REC-cid-1.0-20250515/#retrieve-verification-method), [assertion relationship](https://www.w3.org/TR/2025/REC-cid-1.0-20250515/#assertion)

The did:key draft is pinned to **`2cc490c38c5aacf58497a87fc0cf8794668bf716`** (2025-11-02). It requires correct key length and curve-point validation, but contains editorial conflicts: syntax admits `z`/`u` while document creation requires `z`; signature-method creation says to use the multicodec number as fragment, while its examples and W3C suite vectors use the full multibase fingerprint. **Recommendation:** explicitly pin canonical `did:key:z…` and `DID#<full z… fingerprint>`, documenting this resolution of draft ambiguity. [Pinned document/key algorithms](https://github.com/w3c-ccg/did-key-spec/blob/2cc490c38c5aacf58497a87fc0cf8794668bf716/index.html#L330-L564), [published ECDSA vectors](https://www.w3.org/TR/2025/REC-vc-di-ecdsa-20250515/#test-vectors)

### Recommended JSON ↔ CBOR subset

RFC 8949 requires protocols to specify invalid/unexpected-input handling and permits declaring otherwise-valid CBOR types unexpected. The following are **application restrictions** for lossless conversion into the JCS data model, not general CBOR validity rules. [RFC 8949 §5](https://www.rfc-editor.org/rfc/rfc8949.html#section-5)

- Require one top-level document map and complete input consumption. Reject trailing items or bytes; CBOR sequences are a different framing choice.
- Recursively allow only unique text map keys, Unicode text, arrays, booleans, null and finite binary64 numbers. Detect duplicates and invalid UTF-8 before conversion can collapse keys or insert replacement characters.
- Reject non-text keys, byte strings, all semantic tags (including self-described CBOR), undefined, other simple values and non-finite numbers. Do not stringify keys, strip tags, base64-encode bytes or substitute null: RFC §6.1 offers those **non-normative** conversions, but they can change signed meaning.
- Reject CBOR integers not exactly representable as binary64 **before** numeric conversion. Normalize equal integer/float values to the same JSON number. Restrict application counters/quantities to safe integers, with larger exact quantities expressed as decimal strings; this extra restriction is stronger than JCS, which permits finite values such as `1e30`.
- Preserve array order and strings without Unicode normalization; JCS supplies property order and numeric normalization, including `-0` to `0`. Compute event identity and proof input from decoded JSON, never raw CBOR bytes.

Duplicate keys and invalid UTF-8 are CBOR validity failures; rejecting otherwise-valid tags or bytes is the chosen subset. Full-consumption behavior is protocol framing. [Validity and map keys](https://www.rfc-editor.org/rfc/rfc8949.html#section-5.3), [conversion advice](https://www.rfc-editor.org/rfc/rfc8949.html#section-6.1), [single-item framing](https://www.rfc-editor.org/rfc/rfc8949.html#section-3), [JCS rules](https://www.rfc-editor.org/rfc/rfc8785.html#section-3)

Deterministic CBOR writing is an optional transport policy, separate from JCS identity. RFC §4.2 additionally requires shortest encodings, definite lengths and encoded-byte map-key ordering; that ordering is not JCS UTF-16 ordering. Readers can accept equivalent non-preferred widths/map orders without changing identity. If indefinite items or non-preferred encodings are rejected, name that profile restriction explicitly. [RFC 8949 §4.2](https://www.rfc-editor.org/rfc/rfc8949.html#section-4.2)
