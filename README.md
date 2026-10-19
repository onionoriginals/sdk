# Originals SDK

The SDK for the [Originals Protocol](specs/README.md). Each Original is a
`did:vh` log under the `originals:1.0` extension, signed by its author's DID,
with a fixed set of named resources whose versions are derived from history.

The local workflow is implemented: create (or prepare an unsigned draft),
edit against an explicit parent, deactivate, verify, and exchange ZIP evidence
packages. Web publication and Bitcoin anchoring arrive in later phases of
[plan 011](plans/011-originals-vh-replacement.md).
[`packages/sdk/ORIGINALS.md`](packages/sdk/ORIGINALS.md) is the consumer
contract and says which parts are implemented.

```ts
import { OriginalsSDK, MemoryStore, keySigner } from '@originals/sdk';

const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [authorDidEvidence] });
const signer = keySigner({ keyType: 'Ed25519', secretKey, verificationMethod: `${authorDid}#orig` });
const author = { did: authorDid, verificationMethod: `${authorDid}#orig`, versionId: authorVersionId };

const created = await sdk.create({ name: 'Harbor at dawn', resources: [{ id: 'photo', mediaType: 'image/jpeg', bytes }], author, signer });
```

The earlier CEL 3 asset format and its predecessors were deleted in plan 011
PR 5. No Originals were issued under them, so nothing is read, converted or
migrated.

## Packages

- [`@originals/vh`](packages/vh): strict JSON and JCS, the `eddsa-jcs-2022` and
  `bip340-jcs-2025` cryptosuites, the VH-Log engine, did:vh and did:webvh
  resolution, and the `originals:1.0` extension.
- [`@originals/sdk`](packages/sdk): the Originals workflow, plus did:webvh
  identity operations, credentials, storage, signers, Bitcoin and provider
  utilities.
- [`@originals/auth`](packages/auth): author DIDs and Turnkey custody.

## Repository development

Read [CLAUDE.md](CLAUDE.md) for implementation routes and verification
requirements. Package scripts define build, test, typecheck and lint commands.
[The regtest guide](scripts/regtest/README.md) describes disposable real Bitcoin
Core/ord proof.

[MIT](LICENSE) © Aviary Tech
