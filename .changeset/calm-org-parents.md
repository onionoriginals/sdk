---
"@originals/auth": patch
---

Use the Turnkey client's configured organization for sub-organization lookup and creation, so explicit configuration works without environment variables and cannot be redirected by a conflicting environment. Preserve the environment fallback for injected clients without configuration.
