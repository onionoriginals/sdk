# Upgrading to Originals SDK 4 / CEL 2

SDK 3.0.0 is already published. This checkout prepares the next major versions:
`@originals/sdk` 4 and `@originals/cel` 2. This guide is not a publication notice.
The public identity string and SDK envelope fields change, so this update is
not patch-compatible. The `originals/cel/3` signed representation and `/v3`
subpath names remain unchanged.

An Original still records authenticated controller claims about files and their
versions. Verification still checks history, available file bytes and the
relevant publication evidence. The identity correction separates that asset's
genesis commitment from DID-method identity.

## Update public identifiers and saved-container consumers

| SDK 3 | SDK 4 |
| --- | --- |
| `asset.id` is `did:cel:<genesis-multihash>` | `asset.id` is `ni:///sha-256;<raw-genesis-hash>` |
| `state.didCel` is the primary genesis identifier | Use `state.assetId`; `state.didCel` is deprecated compatibility data |
| Initial `state.alias` is the Originals `did:cel` spelling | Initial `state.alias` is canonical `ni`; hosted/Bitcoin aliases continue to change on migration |
| Envelope `version: 3`, `assetDid` | Envelope `version: 4`, `assetId` |
| `deriveDid(genesisEvent)` | `deriveAssetId(genesisEvent)` |
| `expectedDid` verification option | `expectedAssetId`; old option remains deprecated |

The new URI is defined by [RFC 6920](https://www.rfc-editor.org/rfc/rfc6920).
For Originals it carries the complete SHA-256 of the JCS genesis event as
canonical unpadded base64url. The suffix omits the old multibase/multihash header.
No authority host, query or fragment is accepted. The event and resource
multihashes, chain links and signatures do not change.

Use the public helpers instead of slicing strings:

```ts
import {
  deriveAssetId, normalizeAssetId, sameAssetIdentity, assetDigest,
} from '@originals/sdk/cel';

const { asset, verification } = await sdk.lifecycle.loadAsset(savedSdk3Envelope);
const canonical = asset.id;
console.log(canonical === deriveAssetId(asset.celLog.log[0].event));
console.log(sameAssetIdentity(oldOriginals3AssetId, canonical));
const lookupKey = normalizeAssetId(oldOriginals3AssetId);
const unchangedGenesisMultihash = assetDigest(canonical);
const savedSdk4Envelope = asset.serialize(); // version: 4, assetId: canonical
```

`normalizeAssetId` accepts only canonical `ni` or the exact historical Originals
3 alias form. A successful conversion validates an identifier's encoding; it
must still be bound to authenticated genesis when loading an asset. It does
not convert arbitrary CCG method DIDs or establish a WebVH/Bitcoin binding.
`sameAssetIdentity` returns false for malformed or unrelated identities.
`assetIdFromDigest` is available when you already have the canonical event
multihash. Standalone integrations import these APIs from `@originals/cel/v3`.

## Read existing records without rewriting signed history

`loadAsset` and `parseAssetEnvelope` retain a strict SDK 3 envelope reader.
Version 3 requires historical `assetDid: 'did:cel:…'`; version 4 requires
canonical `assetId: 'ni:///sha-256;…'`. Both authenticate the same CEL 3 history
and reject a genesis mismatch. A container cannot mix these fields or add
unknown fields. Successful reads normalize the container to version 4.
Full loads also check resource attachments and publication evidence; partial
loads never bypass signatures or supplied-byte integrity.

Preserve original archives. Applications indexing by the old identifier should
add a canonical key or a verified alias lookup, then write new SDK 4 containers.
Do not update identity strings inside old signed migration entries, WebVH
method logs, proofs or inscriptions. Existing hosted paths, `alsoKnownAs`
bindings, prepared records and Bitcoin histories remain readable through
validated compatibility handling. Existing assets need no new genesis,
re-signing or reinscription. A new genesis would create a different asset.

`state.aliases` begins with canonical `ni` and can retain a historical Originals
3 alias encountered in authenticated signed migration history. Do not assume
the old spelling always occurs at a fixed array index. `state.didCel` and
`deriveDid` expose it only as explicitly deprecated compatibility values.

## Update identity expectations and labels

Pass `expectedAssetId` to history/sat verification. `expectedDid` remains a
compatibility option; supplying both requires both to bind the same genesis.
One never overrides a conflicting other value. Sat resolution still chooses
the accepted history from publication ordering before comparing the requested
identity.

`parseAssetDid` retains its historical name and result shape. It accepts `ni`
under `method: 'cel'`, preserving the existing local-layer discriminator. That
label is not a claim that a `ni` URI is a DID or that Originals implements a
DID method. Prefer “asset identity” or “Local CEL” in user interfaces.

Originals uses the generic CCG CEL application profile and standard JCS proof
suites. It does not implement the separate CCG `did:cel` DID method. This update
adds no heartbeat, witness, DID document or DID-method resolver. Independent
WebVH identity utilities and publication aliases retain their existing scope.

## What to verify in your integration

1. Load representative SDK 3 archives and confirm canonical identity, original
   signed events and proofs, and exact historical file bytes.
2. Update container consumers for `version: 4` / `assetId`, database lookup keys,
   labels and any string comparisons. Reject mismatched identities.
3. Exercise fresh WebVH and Bitcoin recovery for historical publications, and
   new publication with the same explicit custody and durable retry contract.
4. Retest callers of `deriveDid`, `state.didCel`, `parseAssetDid` and `expectedDid`
   before replacing deprecated usage.

Controller rotation and deactivation, accepted Bitcoin ordering, complete
provider observations and sat possession rules are unchanged. Holding the sat
never grants authority to write creator claims. Pre-CEL-3 logs and earlier
custom proofs remain unsupported; see the historical
[SDK 3 migration guide](MIGRATION_3.0.md) for that earlier format boundary.
The exact contract is [Originals asset identity](../specs/originals-asset-identity.md).
