---
"@originals/sdk": major
---

**Packaging: tree-shakeable entry, curated `exports`, test doubles moved to `/testing`** (plan 043).

The package is no longer hostile to bundlers, and the export surface now matches what a remote-custody integrator needs instead of what the repo happened to contain.

- **`"sideEffects": false`.** The root entry's side-effect-only `import './crypto/noble-init.js'` is gone; the noble sync-hash configuration now happens explicitly (an idempotent `initNobleCrypto()` call) inside the modules that use sync noble APIs (`crypto/Signer.ts`, `did/KeyManager.ts`). A bundler can now drop the ~150-module graph (jsonld included) when you only import types. If you imported the SDK purely for its import-time noble setup, call the exported `initNobleCrypto` — but no SDK path requires you to.
- **Curated `exports` map.** The 11 internal `./dir/*` wildcards are gone; every internal file is no longer a semver commitment. The supported entry points are now exactly: `.` (root), `./cel` (browser-safe genesis entry), `./testing` (test doubles), `./types`, and `./package.json`. Deep imports like `@originals/sdk/crypto/Multikey` no longer resolve — everything public is exported from the root (e.g. `multikey`).
- **Test doubles off the root.** `OrdMockProvider` and `FeeOracleMock` moved from the root entry to `@originals/sdk/testing`. Update imports: `import { OrdMockProvider, FeeOracleMock } from '@originals/sdk/testing'`. Production bundles no longer carry mock providers.
- **Remote-signer toolkit added to the root:** `Verifier` (issuer-bound credential verification), `EdDSACryptosuiteManager` (shared signing-input construction), `createDocumentLoader` (JSON-LD loader bound to a `DIDManager`), and `currentControllerVm` (fold a CEL log to the current controller's verification method; also exported from `./cel`).
- **Dropped from the root:** `withRetry`/`RetryOptions` (`utils/retry`) and `CircuitBreaker`/`withCircuitBreaker` (`utils/circuit-breaker`). These are internal infrastructure, not Originals API; vendor your own if you depended on them.
