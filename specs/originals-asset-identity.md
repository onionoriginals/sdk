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

Originals uses `did:cel:<SCID>` as its public history identifier. The suffix is
the full SHA-256 multihash encoded with CEL's existing `u` base64url multibase.
For new histories:

```text
B(E) = UTF8(JCS(E))
D(E) = "u" + base64url_unpadded(0x12 || 0x20 || SHA256(B(E)))
template = genesis.event with top-level previousEvent = "{SCID}"
SCID = D(template)
genesis.event.previousEvent = SCID
assetId = "did:cel:" + SCID
next.event.previousEvent = D(previous.event)
```

`genesis.event` MUST be a validated `create` event in the selected profile.
Creation and verification substitute only its top-level `previousEvent`; no
other fields are excluded, and application strings are never substituted.
JCS applies to the complete event object, never the containing entry, proof,
transport bytes, resource bytes, or SDK envelope. Verification MUST independently
recompute the commitment and compare it with the expected and embedded SCID.
Signing and event hashing use the final published event after substitution;
the SCID is not the final genesis event digest.

The suffix MUST decode to `0x12 0x20` followed by exactly 32 bytes and round-trip
to identical `u` base64url multibase. Padding, noncanonical trailing bits, other
algorithms, truncation, percent-encoded alternatives, queries and fragments are
rejected. Discovery locations are not commitment inputs; URLs deliberately
included in immutable genesis application state remain committed.

`asset.id` and verifier `state.assetId` MUST return this canonical identifier.
Before publication, `state.alias` and the first member of `state.aliases` use it.
WebVH and Bitcoin publication establish additional aliases for retrieval and
acceptance. They do not replace the canonical `assetId` or alter genesis.
This choice introduces no DID method, DID document, generic `ni` resolver,
heartbeat, witness protocol, or new controller authority.

## Historical Originals 3 identifiers

SDK 3 genesis events without `previousEvent` retain the commitment
`D(genesis.event)` and their `did:cel:` identity. Readers MUST NOT insert a SCID
into such signed events. The interim `ni:///sha-256;…` form contains the same
32-byte raw commitment hash, without multibase or multihash headers, encoded as
canonical unpadded base64url with no host, query or fragment. Readers accept
that strict spelling and normalize it to `did:cel:` after checking the complete
digest. A prefix match, truncated digest, unrelated WebVH/Bitcoin alias, or
arbitrary DID MUST NOT count as equivalent identity.

This spelling names an Originals history; it does not implement a separate
CCG DID-method resolver or imply conformance to every feature of that method.

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
| `deriveAssetId(genesisEvent)` | Validate a creation event and derive its `did:cel:` identifier. |
| `assetIdFromDigest(scid)` | Validate a canonical commitment multihash and prepend `did:cel:`. |
| `assetDigest(identity)` | Recover the commitment multihash from `did:cel:` or the former `ni:` spelling. |
| `normalizeAssetId(identity)` | Validate either permitted identity spelling and return `did:cel:`. |
| `sameAssetIdentity(left, right)` | Compare complete validated genesis commitments; return false for invalid identities. |
| `parseAssetAlias(alias)` | Alias/publication parser (renamed from `parseAssetDid`); `did:cel:` and `ni:` use the `layer: 'cel'` discriminator, naming the Originals lifecycle stage, not DID-method conformance. |

`deriveDid(genesisEvent)` and `state.didCel`, once deprecated Originals 3
compatibility surfaces, remain removed from the CEL 2 / SDK 4 API. The selected
public names are still `deriveAssetId` and `state.assetId`. A spelling signed
into migration history remains readable through `state.aliases`.

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
`did:cel:` form, and a strict version-4 path with `assetId` accepting either `did:cel:` or the
former `ni:` spelling. New writes use `did:cel:`. Fields
from the other version, unknown fields and malformed identities fail closed.
The read path authenticates unchanged signed history, binds its genesis to the
container identity, and returns the normalized version-4 container. Serialization
writes version 4. Attachment integrity, incomplete-evidence handling and memory
limits retain their existing checks. This does not add support for pre-CEL-3
histories or custom earlier proofs.

Applications MUST account for the public string and envelope-field changes;
see [the SDK 4 migration guide](../docs/MIGRATION_4.0.md). Preserve original
archives and use validated identity comparison when indexing old records.
