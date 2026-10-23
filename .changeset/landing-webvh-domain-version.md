---
'@originals/landing': minor
---

New did:webvh identities and Original aliases use the build's `VITE_WEBVH_HOST` (legacy `magby.originals.build` when unset), so readers can fetch what was published. An identity already minted on the legacy domain is found and kept, never replaced. Hosted-layout reads for an object stored under the request's host are served there instead of redirected. `GET /api/version` reports the deployed server and SPA revisions (#976 B, G1 and G6).
