# Resource bytes and JSON interchange

`AssetResource.content` is a `Uint8Array` containing the original bytes. A PNG
stays a PNG through creation, web publication, inscription, and on-sat recovery.
The resource hash is SHA-256 of those bytes; `size` is their byte length. An
incorrect declared hash or size is rejected before creation or publication.

```ts
import { ResourceManager } from '@originals/sdk';

const resources = new ResourceManager();
const bytes = new Uint8Array(await file.arrayBuffer());
const resource = resources.createResource(bytes, {
  id: 'art.png', type: 'image', contentType: 'image/png'
});
const asset = await sdk.lifecycle.createAsset([resource]);
await sdk.lifecycle.publishToWeb(asset, 'example.com');

const json = JSON.stringify(asset.serialize());
const { asset: restored, verification } = await sdk.lifecycle.loadAsset(json);
// restored.resources[0].content is Uint8Array; verification runs by default.
```

Creation methods accept `AssetResourceInput`: inline content may also be a
string, encoded once as UTF-8. `addResourceVersion(id, bytes, contentType)` uses
the same input convention. Existing string hashes therefore remain unchanged.
Inputs, including Buffer subarrays, are copied before asynchronous work begins.
Returned runtime resources always contain bytes. To display known text, decode
it explicitly with `new TextDecoder().decode(resource.content)`.

## AssetEnvelope version 2

Use `asset.serialize()` before JSON serialization. Serializing a raw
`Uint8Array` with `JSON.stringify` does not preserve its type.

Version 2 represents inline content as exactly:

```json
{ "encoding": "base64", "data": "iVBORw0KGgo=" }
```

The encoding is canonical padded RFC 4648 base64, without whitespace. Base64
is only an interchange encoding: hashes, storage writes, fee byte counts, and
inscription bodies use the decoded bytes. `loadAsset` validates the encoding,
checks decoded bytes against the resource hash, and retains the existing CEL
genesis and version binding checks. Plain strings, JSON Buffer/numeric-key
objects, extra encoding fields, and noncanonical base64 are rejected in v2.
Structural decoding also runs when `skipVerification` is explicitly requested.

The loader still accepts version-1 envelopes containing UTF-8 string content.
Loading v1 and reserializing emits v2. It does not guess that a legacy string is
base64: a string containing base64 characters remains literal UTF-8 text. Old
readers reject v2 by version instead of silently misreading its bytes. Versions
outside 1 and 2 are rejected. Hash-only resources remain supported; omitted
content is distinct from a zero-length byte array.

## Standalone ResourceManager exports

`ResourceManager.exportResources()` preserves its separate legacy JSON format:
inline content is emitted in `contentBase64`. `importResource()` decodes that
format (and old UTF-8 `content` strings), checks byte counts and hashes, and
returns runtime bytes. Both content encodings on one imported resource are
rejected. Decode these snapshots with `importResource` before passing them to
`createAsset`; they are not `AssetEnvelope` objects.

This resource representation change preserves the currently implemented CEL
event and Bitcoin inscription metadata formats. It does not implement the
proposed `application/cel` format.
