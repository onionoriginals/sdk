# @originals/cel

This checkout prepares CEL 2 for Originals SDK 4. SDK 3.0.0 is already published;
this major-version update changes public asset identity while retaining its
signed CEL 3 representation. Import the CEL 3 profile from
`@originals/cel/v3`. It supplies strict JSON/CBOR transport, canonical event
identity, authenticated controller history, and the ordered Bitcoin publication
fold. See [V3.md](./V3.md) for the supported contracts and limits.

```ts
import { parseDocument, verifyHistory } from '@originals/cel/v3';
const document = parseDocument(serializedLog, 'json');
const result = verifyHistory(document);
```

An Original records signed claims about files and their versions.
`result.state.assetId` is the canonical `ni:///sha-256;…` URI of the JCS genesis
event. `deriveAssetId`, `normalizeAssetId`, `assetDigest`, `sameAssetIdentity` and
`assetIdFromDigest` support derivation and comparison with strict historical
Originals 3 aliases. `state.didCel` and `deriveDid` are deprecated compatibility
surfaces, not CCG DID-method identities. Originals uses generic CCG CEL and does
not implement the separate CCG `did:cel` DID method.

History verification authenticates controllers and signed resource descriptors.
It does not fetch resource bytes, establish WebVH hosting, or prove Bitcoin
acceptance or current possession. The full SDK supplies those public interfaces.

The root, `/encoding`, `/cbor`, and `/testing` entry points retain the preceding
CEL utility API for existing integrations. They do not verify the Originals
CEL 3 profile and are not a fallback for pre-3.0 Originals. New asset applications
should use `@originals/sdk` or the explicit `/v3` profile.

See [asset identity](../../specs/originals-asset-identity.md) and
[the SDK 4 / CEL 2 migration guide](../../docs/MIGRATION_4.0.md) for public
identifier changes, strict SDK 3 envelope compatibility and unchanged signed
history. The `/v3` subpath names the retained representation, not the npm major.

Node 20.10 or later is required. The profile is also browser-safe. Licensed MIT.
