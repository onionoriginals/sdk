# Originals asset identity

Status: selected identity contract for SDK 4 / CEL 2, following
[issue #583](https://github.com/onionoriginals/sdk/issues/583). SDK 3.0.0 is
already published. This is a major-version public API change; it does not
announce publication of SDK 4 or CEL 2.

## File provenance and identity are separate checks

An Original records signed claims about named files and their versions. The
verifier authenticates the controller history and checks supplied file bytes
against the signed resource digests. The asset identifier commits to the genesis
event; it does not itself prove authorship, current publication, possession,
complete file availability, or the truth of a creator's claims.

Current identity rules live here. The [wire and proof profile](originals-cel-v3-profile.md)
defines the unchanged `originals/cel/3` event representation; the
[authority contract](originals-cel-v3-authority.md) governs controller authority
and Bitcoin acceptance. The former [Originals did:cel document](did-cel-method.md)
is historical and does not define a current DID method.

## Canonical identity

Originals uses the Named Information URI scheme defined by
[RFC 6920, section 3](https://www.rfc-editor.org/rfc/rfc6920#section-3).
This application's canonical form selects the full SHA-256 digest, an empty
authority, and no query or fragment:

```text
B(E) = UTF8(JCS(E))
H(E) = SHA256(B(E))
assetId = "ni:///sha-256;" + base64url_unpadded(H(genesis.event))
D(E) = "u" + base64url_unpadded(0x12 || 0x20 || H(E))
next.event.previousEvent = D(previous.event)
```

`genesis.event` MUST be a validated `create` event in the selected profile.
JCS is RFC 8785, applied to the complete event object, never the containing
entry, proof, transport bytes, resource bytes, or SDK envelope. The URI suffix
MUST decode to exactly 32 bytes and round-trip to identical unpadded base64url.
Padding, noncanonical trailing bits, other algorithms, truncation, authority
hosts, percent-encoded alternatives, queries and fragments MUST be rejected as
Originals asset identities. This is a restricted application form of `ni`, not
a claim that all other RFC 6920 forms are invalid URIs.

The `ni` suffix is the raw digest: it MUST NOT contain the multibase `u` prefix
or the two multihash header bytes. Existing event/resource multihashes and
`previousEvent` commitments retain their exact encoding. Proofs and encoding
presentation do not select identity; any change to a genesis event value does.

`asset.id` and verifier `state.assetId` MUST return this canonical URI. Before
publication, `state.alias` and the first member of `state.aliases` use it too.
WebVH and Bitcoin publication establish additional aliases for retrieval and
acceptance. They do not replace the canonical `assetId` or alter genesis.
This choice introduces no DID method, DID document, generic `ni` resolver,
heartbeat, witness protocol, or new controller authority.

## Historical Originals 3 identifiers

SDK 3 used `"did:cel:" + D(genesis.event)` for this same commitment. Here that
string is an **Originals 3 compatibility alias**, not an implementation of the
[CCG DID method at revision `7626f0acb5f0a203eac61d59c5dc7bfa3319c56c`](https://github.com/w3c-ccg/did-cel-spec/blob/7626f0acb5f0a203eac61d59c5dc7bfa3319c56c/index.html). The former Originals prefix cannot be treated as evidence of
standards conformance or generic DID resolution.

Readers MAY accept that exact historical form only after validating its
canonical SHA-256 multihash and binding it to authenticated CEL 3 genesis.
Comparison with a canonical `ni` identifier MUST compare the complete digest.
A prefix match, truncated digest, unrelated WebVH/Bitcoin alias, or arbitrary
DID MUST NOT count as equivalent identity.

Already signed migration `from` values and WebVH `alsoKnownAs` bindings may
contain the historical spelling. Readers MUST preserve those signed values and
compare their identity commitment when appropriate. They MUST NOT rewrite
existing events, migration entries, proofs, method logs or Bitcoin inscriptions.
Old hosted paths and saved records remain readable. Existing assets require no
reinscription or new genesis to adopt the canonical public identifier.
New local-to-WebVH migrations use the canonical current alias. The journey
remains local CEL → WebVH → Bitcoin. Controller authorization, rotation,
deactivation, complete Bitcoin observations and accepted publication ordering
are unchanged; holding a sat grants no controller-write authority.

## Public API and interchange

| Surface | Contract |
| --- | --- |
| `deriveAssetId(genesisEvent)` | Validate a creation event and derive its canonical `ni` URI. |
| `assetIdFromDigest(eventMultihash)` | Validate an existing canonical event multihash and encode its raw hash as `ni`. |
| `assetDigest(identity)` | Recover the canonical event multihash from `ni` or the historical Originals 3 alias. |
| `normalizeAssetId(identity)` | Validate either permitted identity spelling and return canonical `ni`. |
| `sameAssetIdentity(left, right)` | Compare complete validated genesis commitments; return false for invalid identities. |
| `parseAssetAlias(alias)` | Alias/publication parser (renamed from `parseAssetDid`); `ni` uses the `layer: 'cel'` discriminator, naming the Originals lifecycle stage, not DID-method conformance. |

`deriveDid(genesisEvent)` and `state.didCel`, once deprecated Originals 3
compatibility surfaces, are removed from the CEL 2 / SDK 4 API. A fresh
genesis's historical spelling, when genuinely needed, is reconstructed as
`"did:cel:" + assetDigest(state.assetId)`; a spelling signed into real
migration history remains readable through `state.aliases`.

These helpers are available through `@originals/cel/v3` and
`@originals/sdk/cel`. The `/v3` subpath and `originals/cel/3` profile identify
the retained CEL representation, independently of the npm major versions.

`verifyHistory` and `resolveSat` accept only `expectedAssetId`; the deprecated
`expectedDid` option is removed. An expected identifier does not select a
preferred Bitcoin fork; accepted publication ordering remains independently
determined by the authority contract.

New SDK envelopes MUST use:

```text
{ format: "originals/asset", version: 4, assetId, eventLog, resources, unverified? }
```

Readers retain a strict version-3 path with `assetDid` in the historical
`did:cel:` form, and a strict version-4 path with canonical `assetId`. Fields
from the other version, unknown fields and malformed identities fail closed.
The read path authenticates unchanged signed history, binds its genesis to the
container identity, and returns the normalized version-4 container. Serialization
writes version 4. Attachment integrity, incomplete-evidence handling and memory
limits retain their existing checks. This does not add support for pre-CEL-3
histories or custom earlier proofs.

Applications MUST account for the public string and envelope-field changes;
see [the SDK 4 migration guide](../docs/MIGRATION_4.0.md). Preserve original
archives and use validated identity comparison when indexing old records.
