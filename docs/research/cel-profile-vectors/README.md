# Canonicalization evidence for the proposed CEL profile

These are literals for evaluating the wire/proof decision, not assertions that
the new protocol is implemented. See the [contract](../../../specs/originals-cel-v3-profile.md)
and [primary sources](../2026-09-05-cel-profile-primary-sources.md).

`canonical-json.json` contains seven input/canonical-output pairs and four
rejection cases. Expected canonical strings are independently written from RFC
8785 rules and published examples. UTF-8 bytes are hashed using Python hashlib
and the OpenSSL CLI; the outputs must agree. Regenerate with:

```sh
python3 docs/research/cel-profile-vectors/generate-independent.py
```

All seven accepted outputs were additionally compared successfully with the
already-installed independent `json-canonicalize` 2.0.0 implementation. This
cross-check covers accepted outputs only; it does not establish that dependency's
strict input rejection or make it the production parser recommendation.

`current-implementation-observation.json` records comparison with the unchanged
current CEL canonicalizer. Five match and two differ (numeric/prototype-named
properties, and UTF-16 key order with a numeric-looking property). This is evidence
for the already-mapped canonicalization correction, not a newly implemented fix.

The owner selected CCG conformance on 2026-09-05. The [published W3C vectors](published-w3c/README.md)
now cover P-256, P-384 and Ed25519 canonical documents, proof configurations,
hashes and signatures. An independent rerun with Node 25.2.1 passed all three
suite comparisons. These are cryptographic checks, not complete processor conformance.

`ccg-create.example.json` is a signed reference example using the selected CCG
layout and the optional standard EdDSA suite. `ccg-create.evidence.json` records
its canonical bytes, digest, signature and checks. Reproduce it with:

```sh
node docs/research/cel-profile-vectors/create-ccg-example.mjs
```

The script imports no Originals code. It uses the public RFC 8032 test key,
first verifies that primitive's published known answer, then signs an Original
description referencing the existing 68-byte regtest PNG. Signature verification
passes; changing the title or signing the wrong event wrapper fails verification.
The nonce is fixed solely for reproducibility. This example has not been produced
or accepted by the new SDK, nor inscribed. Its application fields now follow the
linked representation contract; the SDK implementation and full authorization/fold
checks remain pending.

## Full-document and transport reference corpus

`profile-documents.json` contains 14 accepted representation/proof cases and 40
rejected cases. Each accepted case includes the complete signed document,
canonical event UTF-8 bytes, digests, did:cel where derivable, proof configuration,
signing message, signature and CBOR bytes. It covers the required ECDSA curves,
Ed25519, single/multiple proofs, metadata member preservation, updates, deltas,
and the wire shapes for rotation/deactivation/migration. The migration fixture's
WebVH alias is illustrative; neither its resolution nor its SCID is verified.

Expected bytes/signatures use independent `json-canonicalize` 2.0.0, Node SHA-2
and Noble 2.2.0 with public RFC/W3C keys. CBOR uses cborg 5.1.7. The written
profile supplies the expected accepted/rejected result; no Originals production
code supplies expectations. The checker reads saved evidence without regenerating
it and independently verifies signatures using Node/OpenSSL. The separate W3C
literal-vector checks establish that the reference primitives match published
suite examples, rather than only agreeing with themselves.

`transport-inputs.json` adds nine JSON parser cases and sixteen CBOR subset cases.
Python independently checks duplicate decoded JSON names and invalid Unicode.
CBOR checking inspects original string bytes with fatal UTF-8 decoding before
cborg conversion. cborg's default text decoder replaces invalid UTF-8; its
ordinary `decode()` result alone does not satisfy the profile. This observation
is an implementation requirement, not a claim of a completed production fix.

Run without contacting any network or chain:

```sh
node docs/research/cel-profile-vectors/check-profile-corpus.mjs
python3 docs/research/cel-profile-vectors/check-json-inputs.py
node docs/research/cel-profile-vectors/published-w3c/compare.mjs
```

To deliberately regenerate the reference corpus after a reviewed contract change:

```sh
node docs/research/cel-profile-vectors/generate-profile-corpus.mjs
```

The reference files are engineering evidence, not an alternate production verifier.
They do not establish full controller succession, provider completeness, WebVH
identity, Bitcoin authority, complete runtime-object rejection, all limit
boundaries, or resource retrieval. Reference scripts are not exported by any
package. Production tests must consume the saved expectations at the contract's
public verification boundaries; changing implementation must not regenerate them.
