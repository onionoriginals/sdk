---
'@originals/sdk': patch
---

`generateImagePreview` reports `failed` only for the image's own faults. A codec instance that throws, for any reason, is discarded. WASM memory running out, a WASM trap, or any other error is retried on a fresh instance after explicit waits (`PREVIEW_CODEC_RETRY_DELAYS_MS`: 250 ms, 1 s, 4 s; `configurePreviewCodecs({ retryDelaysMs })`). An error counts as the image's only when it recurs identically on a fresh instance. Memory that stays short throws `limit-exceeded` `PREVIEW_RUNTIME_EXHAUSTED`, and errors that differ on every fresh instance throw `PREVIEW_RUNTIME_FAULT`, so no caller silently names no preview. An AVIF is sized from its `meta`/`iprp`/`ipco` `ispe` properties only.
