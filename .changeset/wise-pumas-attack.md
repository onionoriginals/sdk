---
"@originals/sdk": minor
"@originals/auth": patch
---

Make the published packages importable under Node's ESM resolver.

The built `dist` previously emitted extensionless relative imports and
attribute-less JSON imports, which Node ESM rejects — so the packages could not
be imported by npm consumers. All relative imports now carry explicit
`.js`/`/index.js` extensions, JSON imports use `with { type: "json" }`, and both
packages compile under `moduleResolution: "NodeNext"` so the compiler enforces
correct ESM specifiers going forward.

`engines.node` is raised to `>=20.10.0` (required for JSON import attributes).
This is released as a `minor` rather than `major` deliberately: the previous
builds did not import on **any** Node version (the broken specifiers failed
resolution everywhere), so there is no working consumer on Node 18 whose runtime
this change could break — it documents the floor that actually works rather than
removing functioning support.

The SDK release also includes opt-in `did:webvh` pre-rotation key support
(`createDIDWebVH`/`rotateDIDWebVHKeys` `prerotation` option, returned
`nextKeyPair`), with guards that reject misuse on pre-rotation chains.
