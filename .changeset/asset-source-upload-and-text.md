---
"@originals/landing": minor
---

**The demo's asset can be your file or your words, not only generated art.**

A Source picker offers three ways to make the asset's bytes:

- **Generate** — the existing generative artwork, unchanged.
- **Upload** — bring your own SVG or plain text file, up to 32 KB.
- **Write** — type or paste raw text straight into the page.

All three travel the same `did:cel → did:webvh → did:btco` lifecycle, and in every case the bytes published are exactly the bytes supplied — verbatim, not normalised or re-wrapped.

**SVG and text only, deliberately.** `AssetResource.content` is a `string` and the SDK hashes it as `TextEncoder().encode(content)`, so there is no binary path: a PNG would either corrupt or have to be re-encoded into something whose hash no longer belongs to the user's file. Carrying real binary is an SDK change and belongs with the 3.0.0 API-freeze work, not here.

**32 KB cap.** Inscription pays by the byte — witness data is roughly a vbyte per four bytes — so 32 KB is about 8,000 vB, a cost a creator can actually cover. A larger cap would let someone build an asset they can never afford to put on Bitcoin.

Uploaded SVG is safe to host: the store already serves every stored object with `nosniff`, `default-src 'none'; sandbox` and `content-disposition: attachment`, so attacker-supplied markup cannot execute from this origin, and SVG rendered in an `<img>` cannot script either.

`DemoEngine.create`/`update` now take an `AssetSource` (bytes, media type, filename); a bare string remains shorthand for generated SVG artwork, so existing callers are unchanged.
