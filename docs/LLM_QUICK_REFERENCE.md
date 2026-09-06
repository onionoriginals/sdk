# Originals SDK 3 quick reference

```ts
import { OriginalsSDK, createLocalSigner } from '@originals/sdk';

const signer = createLocalSigner('Ed25519', secretKeyBytes);
const sdk = OriginalsSDK.create({ signer });
const asset = await sdk.lifecycle.createAsset(
  [{ id: 'art', mediaType: 'image/png', content: pngBytes }],
  { name: 'First edition' },
);
await asset.update({ name: 'Revised edition' });
await asset.addResourceVersion('art', revisedPngBytes, 'image/png');
const saved = JSON.stringify(asset.serialize());
const { asset: restored, verification } =
  await OriginalsSDK.create().lifecycle.loadAsset(saved);
```

`secretKeyBytes`, `pngBytes`, and `revisedPngBytes` are caller-provided bytes.
Creation and edits require current-controller custody; reads do not.

| Need | Public API |
| --- | --- |
| Hosted publication | `prepareWebPublication`, `publishPreparedToWeb`, or `publishToWeb(asset, { domain })` |
| Hosted cold read | `resolveAssetFromWeb(did)` |
| Bitcoin publication | `prepareBitcoinPublication`, persist its result, then `publishPreparedToBitcoin` |
| Fresh accepted Bitcoin state | `resolveAssetFromSat(sat)` |
| Rotation / termination | `asset.rotateKey`, `asset.deactivate` |
| Verification | `asset.verification()`; `loadAsset` checks the same evidence |
| Types | `@originals/sdk/types` |
| Local CLI | `originals-cel --help` |

See [V3.md](../packages/sdk/V3.md) for the complete options, dependencies,
result unions, byte limits, retry rules, removed APIs, and verification scope.
Current-controller authorization and Bitcoin possession are separate. Every
WebVH writer requires an explicit host. Retained identity and credential
utilities do not add asset publication evidence.

[Previous-format quick reference](history/previous-sdk/LLM_QUICK_REFERENCE.md)
is historical regression documentation.
