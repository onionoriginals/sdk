---
"@originals/sdk": patch
---

**Bitcoin resolution response bodies are now capped while streaming, not after full allocation (#606).**

`QuickNodeProvider` and `OrdHttpProvider` checked `Content-Length` as a cheap early reject, but then called `response.arrayBuffer()` to materialize the entire body before comparing its actual size against the configured cap. A chunked/streamed response with no (or a lying) `Content-Length` header could therefore force a full oversized allocation into memory before any cap took effect, even though the aggregate request/time/inscription-count budget from #606's earlier fix (`SatSnapshotBudget`) was already in place.

- New shared `readResponseBodyCapped()` (`packages/sdk/src/adapters/response-body-limit.ts`) reads a response body incrementally via its stream reader and cancels the underlying stream the instant more than the configured cap has been observed, so the excess is never buffered. Falls back to `arrayBuffer()` only for response-like objects without a streaming body (e.g. test doubles).
- `QuickNodeProvider.rpcCall()`, its raw `contentBaseUrl` `/content/:id` and `/r/metadata/:id` reads, and `OrdHttpProvider`'s content/JSON/`  /r/metadata` fetches all route through it. Error codes and messages are unchanged (`QUICKNODE_RESPONSE_TOO_LARGE`, `OrdHttpProvider: response (body) exceeds N bytes`).
- A resource-limit failure still surfaces as the existing typed error / `incomplete` resolution outcome — never a truncated "complete" result.
