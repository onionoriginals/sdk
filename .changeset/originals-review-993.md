---
'@originals/vh': minor
'@originals/sdk': minor
'@originals/landing': patch
---

Review of the originals-spec #51 work. While an earlier inscription blocks, each later candidate is judged in full: one that would be rejected on its own is rejected, one unverifiable itself is listed in `unverifiable` as well as waiting. A malformed did:vh or did:webvh versionId, or one numbered below 1, is `AUTHOR_VERSION_IMPOSSIBLE`, and the limit and after-deactivation rules apply in the anchoring inscription too. A did:btco gap counts only for a DID that signed an entry depending on it. A head change from an inscription's verifiability keeps the result current and adds the notice `head-changed`; `headChange.vanished` reports blockers a reorganization removed, and the retained anchor keeps accepted inscription ids (`RetainedAnchor.accepted`). `IdentityObtained.movedTo` and `movedLog` report a fetched log whose latest version names another location; a host-served did:webvh signer log is judged as fetched from its host URL, and a package log has no move. The evidence reader rejects a non-UTF-8 local-header name as `ARCHIVE_PATH` and an entry with no Unix mode. The CLI verdict line names its notices (`verdictLine`, `noticeLines`), and the landing's anchoring panel lists each unverifiable and waiting inscription.
