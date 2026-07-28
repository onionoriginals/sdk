---
"@originals/sdk": minor
---

Make the SDK importable in browsers and edge runtimes, and add a slim genesis-only entry point.

**`@originals/sdk` no longer pulls Node builtins at import time.** Previously the package entry point statically reached `fs`, `path`, `fs/promises`, a bare `crypto`, and `node:zlib`, so it failed to load outside Node regardless of which features you used.

- Status-list GZIP moves from `node:zlib` to `fflate`. `BitstringStatusList.encode()`/`decode()` and `StatusListManager.encodeBitstring`/`decodeBitstring` stay **synchronous** — a lazy `await import('node:zlib')` would have forced those public methods async. The wire format is unchanged and verified round-trip against `node:zlib` in both directions, including the legacy ZLIB-wrapped DEFLATE encoding.
- `utils/encoding` uses `@scure/base` instead of `Buffer` for base64/base64url/base58. Drops the `b58` dependency.
- `LocalStorageAdapter` and `WebVHManager` load `fs`/`path` lazily on first use, matching `FileLogOutput`. Node-only behaviour is unchanged; the path-traversal guards keep Node's exact `path` semantics.
- Selective disclosure uses the Web Crypto `crypto.randomUUID` global rather than importing `crypto`.

**New `@originals/sdk/cel` entry point** for genesis-only (`did:cel`) consumers: 34 modules and 248 KB versus 116 modules and 1201 KB for the root barrel, dropping `bitcoinjs-lib`, `jsonld`, `@digitalbazaar/bbs-signatures`, `didwebvh-ts`, `@scure/btc-signer` and more. `@originals/sdk/cel/*` deep imports are exported too.

**`LifecycleManager` no longer pulls the VC stack.** `CredentialManager` is injected, so it is now a type-only import; `OriginalsAsset` duck-types its credential check instead of `instanceof`. Importing `lifecycle/LifecycleManager` drops from 75 modules / 821 KB to 59 / 653 KB and no longer drags in `jsonld`.

**Bug fix:** `OrdinalsLookup.content` is typed `Uint8Array`, but four call sites in `verifyEventLog` and `LifecycleManager` called `.toString('utf8')` on it — a `Buffer`-only overload. Any `OrdinalsProvider` returning a plain `Uint8Array` produced a comma-separated digit string and threw in `JSON.parse`. They now use `TextDecoder`.

A new `scripts/check-browser-safety.mjs` CI gate fails the build if a guarded entry point regains a static Node-builtin import, and runs as a publish gate alongside the ESM check.

Note: the Bitcoin modules (`bitcoin/transactions/commit`, `QuickNodeProvider`, `crypto/Signer`) still require `Buffer` at runtime, because `bitcoinjs-lib`'s API is Buffer-based. They are not reachable from the `cel` entry point.
