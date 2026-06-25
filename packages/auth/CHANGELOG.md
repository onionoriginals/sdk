# @originals/auth

## 2.0.0

### Major Changes

- 366c399: Make the published packages importable under Node's ESM resolver.

  The built `dist` previously emitted extensionless relative imports and
  attribute-less JSON imports, which Node ESM rejects — so the packages could not
  be imported by npm consumers. All relative imports now carry explicit
  `.js`/`/index.js` extensions, JSON imports use `with { type: "json" }`, and both
  packages compile under `moduleResolution: "NodeNext"` so the compiler enforces
  correct ESM specifiers going forward.

  **Breaking:** `engines.node` is raised to `>=20.10.0` (required for JSON import
  attributes; `@originals/auth` also requires it transitively via `@originals/sdk`).
  Released as a major version to reflect the raised runtime floor.

  The SDK release also includes opt-in `did:webvh` pre-rotation key support
  (`createDIDWebVH`/`rotateDIDWebVHKeys` `prerotation` option, returned
  `nextKeyPair`), with guards that reject misuse on pre-rotation chains.

### Patch Changes

- Updated dependencies [366c399]
  - @originals/sdk@2.0.0
