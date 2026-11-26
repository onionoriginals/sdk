# @originals/sdk

The SDK for the Originals Protocol. Each Original is a `did:vh` log under the
`originals:1.0` extension, signed by its author's DID, and has exactly one
resource, which can have many versions (P4.1). The root export is the
Originals workflow; [ORIGINALS.md](ORIGINALS.md) is the consumer contract and
says which parts are implemented.

## Quick start: Create → Add a version → Export → Verify

Everything comes from `@originals/sdk`. The SDK makes the author, signs each
entry, links it to the one before and hashes the bytes.

![The guided path: Create, Add a version, Export, Verify](docs/diagrams/guided.svg)

```ts
import { writeFile } from 'node:fs/promises';
import { OriginalsStudio } from '@originals/sdk';

// 1. Create. With no options you get a new local author and an in-memory store.
const studio = await OriginalsStudio.start();
const app = await studio.create({ name: 'My app', resource: { mediaType: 'text/html', bytes: v1 } });

// 2. Add a version: give it new bytes, a label and, optionally, a sentence about what changed.
await app.addVersion({ bytes: v2, label: 'New UI', note: 'Reworked the navigation and the home screen.' });

// 3. Export the evidence package, a ZIP that anyone can verify offline.
const file = await app.export();             // { bytes, fileName: 'my-app-v2.originals.zip', manifest }
await writeFile(file.fileName, file.bytes);

// 4. Verify it the way a recipient would, with no key and none of your local state.
const result = await studio.verify(file.bytes);
result.verified;   // true
result.line;       // 'verified: did:vh:… at …'
result.versions;   // [{ version: 1, … }, { version: 2, label: 'New UI', note: 'Reworked …' }]
```

Next, open the file with the command line tool, which gives the same verdict:
`npx originals verify my-app-v2.originals.zip`.

- **Keep the author** to add versions later. Save `studio.author.ref`,
  `.evidence` and `.secret` (the secret signs, so store it like a password),
  and pass them back as `OriginalsStudio.start({ store, author })`. In Node,
  `FileStore.open(dir)` from `@originals/sdk/originals/fs` keeps the
  Originals, then `studio.open(did)` gives you the handle again.
- **New bytes per version.** The same bytes add no version (P4.4), and
  `addVersion` refuses them (`VERSION_UNCHANGED`).
- **Conflicts are not rebased.** A handle builds on the checkpoint it last
  saw. If the Original moved since then, `addVersion` fails with
  `stale-parent` (P4.5). Call `refresh()` and decide what to do.
- **Verified is not current.** An Original not anchored on Bitcoin is valid
  as of its checkpoint (`result.validAsOf`), and `result.current` is false
  (P7.10).
- Labels and notes are signed metadata under `metadata["originals:version"]`
  (PROVISIONAL). `result.versions` shows them only when the package verifies.

For anything else, such as editors, signer sets, publishing or anchoring, use
`studio.sdk`. That is the full `OriginalsSDK`, described below and in
[ORIGINALS.md](ORIGINALS.md).

## The full workflow

For a map of the whole SDK (where an Original lives, how a change is made,
who may sign and what a check returns), see
[The SDK at a glance](ORIGINALS.md#the-sdk-at-a-glance).

```ts
import { OriginalsSDK, MemoryStore, createLocalAuthor, isVerified } from '@originals/sdk';

const author = await createLocalAuthor();  // or your own DID: { ref, evidence, signer }
const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [author.evidence] });

const created = await sdk.create({ name: 'Harbor at dawn', resource: { mediaType: 'image/jpeg', bytes }, author: author.ref, signer: author.signer });
if (created.kind !== 'original') throw new Error('no signer: an unsigned draft');
const edited = await sdk.edit(created.original.did, { parent: created.original.checkpoint, resource: { bytes: next }, author: author.ref, signer: author.signer });
const pkg = await sdk.package(edited.original.did);   // ZIP evidence package
const { report, reasons } = await sdk.load(pkg.bytes); // offline, read-only verification
isVerified(report, reasons);                            // the `originals verify` verdict
```

## Modules

- `@originals/sdk`: the guided path (`OriginalsStudio`, `createLocalAuthor`),
  the Originals workflow (`OriginalsSDK`, `MemoryStore`, `keySigner`,
  evidence packages, `isVerified`, `OriginalsError` and the report types, so
  you need nothing from `@originals/vh`) and the kept utilities: did:webvh identity
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
