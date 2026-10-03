---
"@originals/sdk": patch
---

Use StructuredError consistently for local storage traversal, Signet inscription capability guards, OrdinalsClient SSRF and response-size rejections, and the retained experimental migration error factory. OrdinalsClient index and content fetch rejections and non-success content HTTP responses now use ORD_FETCH_FAILED, with serializable cause details for fetch and malformed-URL failures. Preserve rejection messages, non-success index null results, fetch safeguards, and migration metadata.
