---
'@originals/sdk': patch
---

`generateImagePreview` no longer reports WASM memory running out as an undecodable image. Running out is retried with a fresh codec instance after explicit waits (`PREVIEW_CODEC_RETRY_DELAYS_MS`, 250 ms, 1 s and 4 s; `configurePreviewCodecs({ retryDelaysMs })`). If memory stays short, it throws `limit-exceeded` `PREVIEW_RUNTIME_EXHAUSTED` instead of returning `failed`, so no caller silently names no preview. A codec instance that threw is never reused. An AVIF is sized from its `meta`/`iprp`/`ipco` `ispe` properties only, so bytes in the coded data can no longer make it "too large".
