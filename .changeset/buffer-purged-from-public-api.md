---
"@originals/sdk": major
---

**`Buffer` is purged from every public signature — the API speaks `Uint8Array`** (plan 044).

`Buffer` is a Node global; any browser consumer without a bundler shim got `ReferenceError` the moment a Buffer-typed path executed. Public signatures now use `Uint8Array` throughout, and the browser-reachable entry points (`index`, `LifecycleManager`, `OriginalsAsset`, `cel`) no longer construct Buffers at runtime.

**Signature changes** (callers passing `Buffer` still compile — `Buffer` extends `Uint8Array`; code that called Buffer methods on *returned* values must convert):

- `Signer` and all four implementations (`ES256KSigner`, `Ed25519Signer`, `ES256Signer`, `Bls12381G2Signer`): `sign`/`verify` take and return `Uint8Array`. The returned signature is no longer a `Buffer` instance — use `Buffer.from(sig)` in Node if you need one.
- `OrdinalsProvider` (and every shipped provider): `createInscription({ data })`, `InscriptionParts`, and returned/`getInscriptionById` `content` are `Uint8Array`. Decode text content with `new TextDecoder().decode(content)`, not `content.toString('utf8')`.
- `StorageAdapter.put(data: Uint8Array | string)` and `StorageGetResult.content: Uint8Array`.
- `OrdinalsInscription.content?: Uint8Array` (`types/bitcoin`).
- `ResourceManager.createResource` / `updateResource` / `hashContent` accept `Uint8Array | string`.
- `KeyManager.encodePublicKeyMultibase(publicKey: Uint8Array, …)` / `decodePublicKeyMultibase` returns `{ key: Uint8Array, … }`.
- `LifecycleManager.estimateAppendCost` `content` option: `string | Uint8Array`.

Internal Node-only paths (transaction building, CLI, server providers) still use `Buffer` where appropriate — the guarantee is about the public surface and the browser-reachable graph.
