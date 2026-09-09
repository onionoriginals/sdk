# Historical Originals did:cel identifier

**Superseded:** the current contract is [Originals asset identity](originals-asset-identity.md).
SDK 4 / CEL 2 use an RFC 6920 `ni:///sha-256;…` URI for canonical asset identity.
The signed `originals/cel/3` history and its genesis commitment remain unchanged.

The previous file described an Originals-specific `did:cel` spelling and
previous-format verifier behavior. It is retained in
[repository history](https://github.com/onionoriginals/sdk/blob/a8fe507693f102133c109128c7228a8d859b3d95/specs/did-cel-method.md)
for provenance, not as a current normative method specification. Its claims
about registry status, legacy acceptance, witness behavior and holder writes
must not be applied to the current SDK.

Originals does not implement the [CCG `did:cel` DID method at revision
`7626f0acb5f0a203eac61d59c5dc7bfa3319c56c`](https://github.com/w3c-ccg/did-cel-spec/blob/7626f0acb5f0a203eac61d59c5dc7bfa3319c56c/index.html). CEL is the generic
cryptographic event-log substrate selected by the
[wire and proof profile](originals-cel-v3-profile.md); using it does not establish
DID-method conformance. Asset controller identity continues to use `did:key`,
and WebVH/Bitcoin aliases retain their separate verification requirements.

Strict historical Originals 3 `did:cel:<genesis-multihash>` strings remain
readable as compatibility aliases of the same authenticated genesis. Deprecated
`state.didCel` and `deriveDid` expose that spelling only. They do not resolve a
DID or implement another protocol. Preserve old signed migrations, method logs,
hosted paths and inscriptions; normalize the public asset identity through the
current identity helpers without rewriting history.
