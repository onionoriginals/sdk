---
"@originals/sdk": patch
---

Fix timing race in `BatchOperationExecutor` fail-fast mode: backoff sleeps are now interruptible via `AbortController`, so a sibling that exhausts its retries and aborts the batch immediately wakes any peers sleeping in backoff rather than requiring their full delay to elapse. This eliminates a race where, under CPU load, item 1's backoff could expire before item 0 had set the abort flag, causing item 1 to start a retry it should never have run.
