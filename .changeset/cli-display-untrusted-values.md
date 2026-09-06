---
"@originals/sdk": patch
---

**`originals-cel inspect` no longer prints `[object Object]`.** CEL event data is arbitrary JSON written by whoever produced the log, so a field the CLI renders as a string — an asset `name`, a `layer`, a deactivation `reason` — can legitimately be an object. `String(value)` turned those into `[object Object]`, hiding the content at exactly the moment someone is inspecting a log to understand it. Non-primitives are now JSON-rendered. The `Unsupported proof type` error from the Data Integrity proof path had the same flaw and is fixed the same way.

Found by quoting the `lint` script's glob: it was unquoted, so the shell expanded it to one directory level and `cel/cli`, `bitcoin/transactions`, `migration/*` and several other directories had never been linted at all.
