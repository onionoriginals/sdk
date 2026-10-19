# @originals/sdk

The SDK for the Originals Protocol. Each Original is a `did:vh` log under the
`originals:1.0` extension, signed by its author's DID. The root export is the
Originals workflow; [ORIGINALS.md](ORIGINALS.md) is the consumer contract and
says which parts are implemented.

```ts
import { OriginalsSDK, MemoryStore, keySigner } from '@originals/sdk';

const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [authorDidEvidence] });
const signer = keySigner({ keyType: 'Ed25519', secretKey, verificationMethod: `${authorDid}#orig` });
const author = { did: authorDid, verificationMethod: `${authorDid}#orig`, versionId: authorVersionId };

const created = await sdk.create({ name: 'Harbor at dawn', resources: [{ id: 'photo', mediaType: 'image/jpeg', bytes }], author, signer });
if (created.kind !== 'original') throw new Error('no signer: an unsigned draft');
const pkg = await sdk.package(created.original.did);  // ZIP evidence package
const { report } = await sdk.load(pkg.bytes);          // offline, read-only verification
```

## Modules

- `@originals/sdk`: the Originals workflow (`OriginalsSDK`, `MemoryStore`,
  `keySigner`, evidence packages) and the kept utilities: did:webvh identity
  operations (`createDIDOriginal`, `updateDIDOriginal`, `verifyDIDSignature`,
  `prepareDIDDataForSigning`), credentials, storage adapters, Multikey and
  encoding helpers, Bitcoin builders and providers.
- `@originals/sdk/originals`: the Originals workflow alone (browser-safe).
- `@originals/sdk/originals/fs`: the durable Node `FileStore`.
- `@originals/sdk/types`: public types.
- `@originals/sdk/testing`: provider test doubles.

The `originals` command verifies an evidence package offline:
`originals verify harbor.zip [--json]`.

The CEL 3 asset format and its predecessors were deleted in plan 011 PR 5.
Nothing written under them is read, converted or migrated.

[MIT](LICENSE) © Aviary Tech
