---
"@originals/auth": patch
---

Pass a plain `Uint8Array` (not a `Buffer`) to multibase encoding in the Turnkey signers. Under stricter Node/Bun typings `Buffer` is a `Buffer<ArrayBufferLike>` that TypeScript will not assign to a `Uint8Array<ArrayBufferLike>` parameter, breaking the build (`TS2345`). `Uint8Array.from(Buffer.from(hex, 'hex'))` is equivalent at runtime and type-clean.
