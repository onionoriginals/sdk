---
'@originals/landing': minor
---

New did:webvh identities and Original aliases use the build's `VITE_WEBVH_HOST` (legacy `magby.originals.build` when unset), so readers can fetch what was published. An identity already minted on the legacy domain is found and kept, never replaced. Hosted-layout reads for an object stored under the request's host are served there instead of redirected, only for this instance's own did:webvh hosts (`VITE_WEBVH_HOST` and the legacy domain); a hosted write or save under any other host is refused. `VITE_WEBVH_HOST` is required on every deployed instance. `GET /api/version` reports the deployed server and SPA revisions, marking a dirty build tree with `-dirty` (#976 B, G1 and G6).
