---
"@originals/sdk": patch
---

Fix `FileLogOutput` so file logging works under Node.js. Its flush previously called `Bun.file()`/`Bun.write()` unguarded, so under Node every flush threw `ReferenceError: Bun is not defined` (swallowed by the internal try/catch) and file logging silently did nothing. Flushing now uses `node:fs/promises` `appendFile`, which works under both Node and Bun and appends instead of re-reading and rewriting the whole log file on every flush.
