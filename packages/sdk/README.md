# @originals/sdk

Create and recover Originals from authenticated CEL 3 history and exact resource
bytes. An Original's controller authorizes its history; Bitcoin sat possession is
a separate concept, established by on-chain observations rather than a signature
alone.

This development snapshot makes CEL 3 the default local SDK API. Network
publication, asset resolution, and the landing's new-format journey are still
being integrated. Use a matching source build during this transition; previously
published packages can expose the preceding API. This is not a completed Bitcoin
issuance or release flow.

## Create, edit, recover

```ts
import { OriginalsSDK, createLocalSigner } from '@originals/sdk';

// secretKeyBytes comes from your custody. A remote signer can implement CelSigner.
const signer = createLocalSigner('Ed25519', secretKeyBytes);
const sdk = OriginalsSDK.create({ signer });
const asset = await sdk.lifecycle.createAsset(
  [{ id: 'art', mediaType: 'image/png', content: pngBytes }],
  { name: 'First edition' },
);

await Promise.all([
  asset.update({ name: 'Revised edition' }),
  asset.addResourceVersion('art', revisedPngBytes, 'image/png'),
]);

const saved = JSON.stringify(asset.serialize());
const { asset: restored, verification } =
  await OriginalsSDK.create().lifecycle.loadAsset(saved);

console.log(verification.verified); // complete local history and checked bytes
console.log(restored.state.resources[0].version); // 2
```

The SDK copies runtime `Uint8Array` inputs, encodes string inputs once as UTF-8,
computes resource digests, and serializes byte attachments as explicit base64.
Every resource version must bind to authenticated history and its actual bytes.
All mutations share a queue per asset instance; a failed signature leaves its
previous committed state available and releases that queue.

## Custody and verification

A `CelSigner` declares `algorithm`, canonical `controller`, and an asynchronous
`sign(message)` callback. Supported algorithms are Ed25519, P-256 and P-384.
Every returned signature is checked. The preceding `OriginalsSigner` interface
is not silently converted into this contract.

`rotateKey` is signed by the outgoing controller. Later edits require the new
controller. `deactivate` ends allowable mutations. Reading or verifying an asset
requires no private key; creating or signing a change requires explicit custody.

An explicit `onAppendFailure: 'skip'` can preserve unsigned resource edits as
local drafts. They never advance authenticated history or report full
verification. `retryResourceVersion` signs retained bytes against their exact
predecessor, and `discardLocalResource` removes a draft deliberately.
`loadAsset(..., { allowPartial: true })` can retain missing bytes/drafts without
bypassing signatures or supplied-byte validation.

## Modules

- `@originals/sdk`: the default CEL 3 asset SDK plus independent identity,
  credential, provider, storage, and Bitcoin utilities.
- `@originals/sdk/v3`: the smaller local-only SDK using the same state verifier.
- `@originals/sdk/cel`: CEL 3 encoding, signing, proof and history verification.
- `@originals/sdk/types`: types matching the default public asset API.
- `@originals/sdk/testing`: explicit provider test doubles.

The default SDK retains standalone WebVH identity helpers used by auth. Those
helpers do not establish an asset's publication. The new lifecycle has no network
writer or previous-format fallback; offline Bitcoin history cannot establish
current ownership or accepted on-sat state.

## Command line

```sh
originals-cel create --file art.png --media-type image/png --algorithm Ed25519 --key controller.key --output asset.json
originals-cel verify --asset asset.json
```

The key file holds raw private-key bytes. Outputs are complete version-3 asset
envelopes; existing files are not overwritten. `verify --log` instead checks
controller history only and reports that narrower scope. No command broadcasts
transactions. See `originals-cel --help` and [the API guide](V3.md).

## Documentation

[The CEL 3 API guide](V3.md) describes types, options, limits, recovery, removed
previous-format exports, and remaining integration work. Protocol rules are in
[the selected profile](../../specs/originals-cel-v3-profile.md) and
[authority contract](../../specs/originals-cel-v3-authority.md).

[MIT](LICENSE) © Aviary Tech
