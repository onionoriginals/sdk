---
"@originals/sdk": patch
---

Harden `noble-init` so importing the SDK never white-screens a browser app. Under some ESM bundlers the `@noble/ed25519` / `@noble/secp256k1` module namespace is frozen (non-configurable, `hashes` reads `undefined`); the previous init did a raw `Object.defineProperty(mod, 'hashes', …)` that threw `Cannot redefine property: hashes` at import time. Initialization now routes `hashes` creation through the existing `safeSetProperty` (which cannot throw) and skips with a one-time `console.warn` when the namespace can't be configured, instead of crashing every consumer that merely imports the SDK.
