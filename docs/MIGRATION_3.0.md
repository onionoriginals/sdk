# Upgrading to `@originals/sdk` 3.0

> Historical guide for the already-published 3.0.0 release. The current
> [SDK 4 migration guide](MIGRATION_4.0.md) supersedes identity and envelope
> details. SDK 4 reads strict SDK 3 CEL 3 envelopes without rewriting signed
> history; this does not restore pre-CEL-3 compatibility. The API-guide links
> below now describe the current checkout.

SDK 3.0 uses CEL 3 for asset creation, mutation, publication and recovery.
This changes the asset format and custody contract. The [released API guide](../packages/sdk/V3.md)
is the complete reference; the earlier asset APIs are not a compatibility path.

## 1. Existing asset histories are not automatically migrated

Neither the default SDK nor `@originals/sdk/v3` accepts or translates earlier
asset logs or envelopes. Preserve old histories and their matching verifier
when maintaining historical records. Changing a proof label cannot convert a
signed history to CEL 3. Creating an asset anew produces a new identity; it does
not preserve the old asset's authenticated lineage.

CEL 3 envelopes have `format: 'originals/asset'`, `version: 3`, an `eventLog`
containing `{ log: [...] }`, and explicit base64 resource attachments. Loading
checks the history and the actual bytes of every supplied resource version.
`allowPartial: true` can retain incomplete evidence, but never bypasses signature
or supplied-byte verification.

## 2. Asset custody uses `CelSigner`

A CEL 3 signer declares `algorithm`, a canonical `did:key` `controller`, and
`sign(message): Promise<Uint8Array>`. Supported algorithms are Ed25519, P-256
and P-384. Configure a signer or pass one per operation; creation without one
throws `NO_CUSTODY`.

```ts
import { OriginalsSDK, createLocalSigner } from '@originals/sdk';

// Obtain secretKeyBytes from your own custody.
const signer = createLocalSigner('Ed25519', secretKeyBytes);
const sdk = OriginalsSDK.create({ signer });
const asset = await sdk.lifecycle.createAsset([
  { id: 'art', mediaType: 'image/png', content: pngBytes },
], { name: 'First edition' });
await asset.addResourceVersion('art', revisedPngBytes, 'image/png');
const { asset: restored, verification } =
  await OriginalsSDK.create().lifecycle.loadAsset(JSON.stringify(asset.serialize()));
```

The retained `OriginalsSigner`/`ExternalSigner` utilities use different interfaces;
they cannot be passed straight into this lifecycle. Implement the `CelSigner`
contract for remote custody, including its algorithm-specific hashing and
fixed-width signature requirements; see [the signing contract](../packages/cel/V3.md#offline-creation-and-continuation).
Every returned signature is checked. A `keyStore` alone configures independent
identity/credential utilities; it does not select an asset controller. The old
`controller: 'ephemeral'` creation option is not supported.

## 3. Mutations and publication return explicit results

Use `asset.update`, `asset.addResourceVersion`, `asset.rotateKey` and
`asset.deactivate`. The outgoing controller authorizes rotation; later edits
require the new controller. Holder possession does not grant controller authority.

Mutations serialize per asset instance. A failed signature preserves the previous
committed state. Explicit `onAppendFailure: 'skip'` permits missing-custody skips,
not invalid signatures or unauthorized signers. Skipped resource edits remain
unsigned local drafts and make full verification false until signed or discarded.

Hosted publication takes `publishToWeb(asset, { domain })` and returns a new
published asset. Bitcoin publication uses preparation, durable submission and
fresh sat resolution. A signed proposal or broadcast acknowledgement does not
establish acceptance. See [publication and recovery](../packages/sdk/V3.md#hosted-publication)
for configuration, return states and retry requirements.

## 4. Imports select the CEL 3 implementation explicitly

- `@originals/sdk`: default CEL 3 SDK and independent utilities.
- `@originals/sdk/v3`: smaller local-only SDK.
- `@originals/sdk/cel`: CEL 3 core, equivalent to `@originals/cel/v3`.
- `@originals/sdk/types`: current public asset types.
- `@originals/sdk/testing`: provider test doubles.

The standalone `@originals/cel` root still exposes retained previous-format APIs
and a `celV3` namespace. Its root is **not interchangeable** with `@originals/sdk/cel`.
Use `@originals/cel/v3` for new standalone histories.

Previous asset exports such as `OriginalsCel`, `createEventLog`, `verifyEventLog`,
`toCelSigner`, witness factories and old batch/lifecycle APIs are removed from
the SDK root. See the [removed surfaces](../packages/sdk/V3.md#public-entry-points-and-removed-surfaces).
There is no `@originals/sdk/legacy` fallback.

## 5. CEL 3 uses standard JCS cryptosuite identifiers

CEL 3 emits `DataIntegrityProof` with `eddsa-jcs-2022` for Ed25519, or
`ecdsa-jcs-2019` for P-256/P-384. These suites are defined in the W3C
[EdDSA](https://www.w3.org/TR/2025/REC-vc-di-eddsa-20250515/) and
[ECDSA](https://www.w3.org/TR/2025/REC-vc-di-ecdsa-20250515/) Recommendations.
The signing message binds both the canonicalized proof configuration and event
through their hashes. See [the implementation](../packages/cel/src/v3/proofs.ts).

`originals-cel-ed25519-jcs-v1` belongs to the retained previous-format code.
It honestly labels a custom construction; it is neither emitted nor accepted by
the CEL 3 implementation. Some even older proofs used the standard-looking
`eddsa-jcs-2022` label with a different signing construction. Their label does
not make those histories CEL 3, and relabelling does not migrate them.

`originals/cel/3` identifies the Originals **application profile**: asset operations,
controller authorization and supported CEL features. It is not a cryptosuite.
The [selected profile](../specs/originals-cel-v3-profile.md) is based on the CCG
community draft; this is not certification of every CCG feature or generic
processor interoperability.

## 6. Independent auth and byte utilities

Import auth server utilities from `@originals/auth/server` and client utilities
from `@originals/auth/client`. The auth root carries types and the isomorphic
`turnkeySignBytes` helper, rather than re-exporting server code.

Public byte APIs use `Uint8Array`. On Node, convert with
`Buffer.from(bytes).toString('hex')` when a Buffer encoding method is needed;
`Uint8Array.toString()` does not produce hex. Browser integrations should use
portable byte encoders.

## 7. Retained credential utilities use current RDFC-1.0 canonicalization

**Breaks:** some credentials signed with earlier JSON-LD canonicalization can fail verification through credential utilities exported from `@originals/sdk` after upgrading.

The retained credential utilities now use `jsonld` 9 and `rdf-canonize` 5. This also moves the JSON-LD HTTP client onto the maintained Undici 6 dependency line. The canonicalizer implements RDFC-1.0, matching the utilities' `eddsa-rdfc-2022` proof contract; its accepted `URDNA2015` algorithm name is an alias for that implementation.

Canonical N-Quads now escape tabs and other control characters instead of leaving them as raw characters. For example, a literal tab becomes the two characters `\t`, and U+0001 becomes `\u0001`. Those changed bytes change a credential's signature input. An existing signature made over the older bytes cannot be carried over by relabelling the proof: the issuer must reissue affected credentials using the current canonicalization.

The canonicalizer also enforces complexity limits for graphs with certain blank-node structures. Previously accepted graphs may now be rejected during signing or verification. Check representative existing credentials before upgrading; affected graphs may need to be simplified and their credentials reissued. See the [upstream canonicalization changes](https://github.com/digitalbazaar/rdf-canonize/blob/main/CHANGELOG.md) for the escaping and complexity-control details.

**The CEL 3 event format is unaffected.** CEL 3 event signing and verification use their own deterministic JSON/CBOR encoding, independently of these retained JSON-LD credential utilities.

## Recommended upgrade order

1. Inventory previous-format histories and keep their verification path separate.
2. Implement CEL 3 custody and update resource inputs and imports.
3. Exercise creation, mutation, serialization and fresh recovery with real resource bytes.
4. Update hosted/Bitcoin publication and durable retry integrations using the API guide.
5. Check representative retained credentials for the canonicalization changes above.
