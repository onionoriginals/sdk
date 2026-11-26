# @originals/sdk

The SDK for the Originals Protocol. Each Original is a `did:vh` log under the
`originals:1.0` extension, signed by its author's DID, and has exactly one
resource, which can have many versions (P4.1). The root export is the
Originals workflow; [ORIGINALS.md](ORIGINALS.md) is the consumer contract and
says which parts are implemented.

## Quick start: create, edit, export, verify

Everything below comes from `@originals/sdk`. The SDK signs each entry,
links it to the one before and hashes the bytes; you choose the author and
say which checkpoint each change builds on.

```ts
import { writeFile } from 'node:fs/promises';
import { OriginalsSDK, MemoryStore, createLocalAuthor, isVerified } from '@originals/sdk';

// 1. An author. createLocalAuthor makes one on this device (see "Authors" below).
const author = await createLocalAuthor();
const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [author.evidence] });
const signer = author.signer;

// 2. Create: version 1 of the Original's one resource.
const created = await sdk.create({ name: 'My app', resource: { mediaType: 'text/html', bytes: v1 }, author: author.ref, signer });
if (created.kind !== 'original') throw new Error('unreachable: a signer was given');
let original = created.original;

// 3. Edit: the next version. `parent` is the checkpoint this change builds on.
({ original } = await sdk.edit(original.did, {
  parent: original.checkpoint,
  resource: { bytes: v2 },
  metadata: { note: 'New UI: reworked the navigation.' },
  author: author.ref, signer,
}));

// 4. Export: an evidence package, a ZIP anyone can verify offline.
const pkg = await sdk.package(original.did);
await writeFile('my-app.originals.zip', pkg.bytes);

// 5. Verify it as the recipient would: a fresh SDK, no key, no network.
const reader = OriginalsSDK.create({ authors: [] });
const { report, reasons } = await reader.load(pkg.bytes);
isVerified(report, reasons); // true
```

Then hand the file to anyone. They check it with the command line tool, which
gives the same verdict as `isVerified` and explains it:

```sh
npx originals verify my-app.originals.zip
```

`tests/unit/originals/quick-start.test.ts` runs this example, so it stays
correct.

### Authors

Every entry is signed by the author: `ref` names the author's DID and key,
`evidence` is that DID's log, and `signer` signs.

- **No DID yet** (trying the SDK, or an app whose users have none):
  `createLocalAuthor()`. Keep `ref`, `evidence` and `secret` to edit later;
  `restoreLocalAuthor({ ref, evidence, secret })` gives you the signer back.
  The secret signs, so store it like a password. It is never put in a package.
- **A did:webvh identity**: `ensureWebvhIdentity` from `@originals/sdk/did`
  gives `identity.ref` and `identity.evidence`. Sign with
  `keySigner({ keyType: 'Ed25519', secretKey, verificationMethod: identity.ref.verificationMethod })`,
  or with your own `OriginalsSigner` for a key held elsewhere (a custody
  service). See [Identities in a browser app](ORIGINALS.md#identities-in-a-browser-app-originalssdkdid-implemented).

### Describing a version

Put your own description in `metadata`, such as `{ note: 'New UI: …' }`. It is
part of the signed entry. `edit` replaces `metadata` when you give it, keeps it
when you leave it out, and removes it when you pass `null` (P4.6). So a later
edit that leaves `metadata` out still shows the old note; set it on every
edit that should have its own.

### Reading the result

- **`isVerified(report, reasons)`** is the overall yes or no. When it is no,
  the report's parts say why: history, author binding, identity evidence or
  resource bytes, each reported separately (see
  [Verification report](ORIGINALS.md#verification-report--phase-1-extended-in-later-phases)).
- **Verified is not current.** An Original that isn't anchored on Bitcoin is
  valid as of its checkpoint (`report.validAsOf`), and `report.current` is
  false: nothing off Bitcoin shows that no newer entry exists (P7.10).
- **Conflicts are never rebased.** If the Original moved past `parent`,
  `edit` fails with `stale-parent` (P4.5). Read the head with `sdk.get(did)`
  and decide what the change should be.
- **The same bytes add no version** (P4.4). Versions are counted from history.
- Errors are `OriginalsError`, with a `category` and a `code`.

For the whole SDK (where an Original lives, how a change is made, who may
sign and what a check returns), see
[The SDK at a glance](ORIGINALS.md#the-sdk-at-a-glance).

## Modules

- `@originals/sdk`: the Originals workflow (`OriginalsSDK`, `MemoryStore`,
  `keySigner`, `createLocalAuthor`, evidence packages, `isVerified`,
  `OriginalsError` and the report types, so you need nothing from
  `@originals/vh`) and the kept utilities: did:webvh identity
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
