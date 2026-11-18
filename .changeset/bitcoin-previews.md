---
'@originals/vh': minor
'@originals/sdk': minor
---

Signed Bitcoin previews, built to originals-spec PR 64 (`940c6d4`, open;
owner decision, 18 November 2026; P9.17, P9.18, P9.30, P14.5, P14.10,
P14.12, P14.13). By default an inscription's body is a preview of the
version its last entry names, at most 8,192 bytes, which that entry signs in
its asset state's `preview` member (`{mediaType, size, digest}`, PROVISIONAL
name and shape).

- `@originals/vh`: the `preview` member and its rules (only from the
  anchoring entry on; 1 to 8,192 bytes; `image/webp` for an `image/` version;
  a new version names a new preview or none, the same version keeps its
  parent's or none; editors per P5.16). The Bitcoin verifier checks the body
  against the named preview, or with none against the version or no body
  (`SatInscription.noBody`); an empty body is a body. New ignored reasons
  `body-not-the-preview`, `content-type-without-body` and `names-a-delegate`
  (delegates rejected, PROVISIONAL); `Placed.body` says what each accepted
  inscription carries. A preview never counts as the version's bytes, is not
  in the derived DID document, and a carried file is never made from one
  (`CARRIER_PREVIEW`). `verifyOriginal` takes `localCopy`: without it, a copy
  of an anchored Original's log read with no Bitcoin evidence reports at most
  the entries before the anchoring entry (P7.14).
- `@originals/sdk`: `anchor`, `edit` and `deactivate` take `body: "preview" |
  "full"` and, for a non-image version, the author's `preview`; for an image
  version the SDK generates a deterministic WebP preview with one scalar WASM
  libwebp in browsers and Node (`generateImagePreview`; PNG, JPEG, WebP, AVIF,
  GIF and SVG; codecs loaded only when a preview is made;
  `configurePreviewCodecs` for SVG in a browser). The commit reports the
  preview or why none (`CommitResult.preview`). `prepareEntryInscription`
  inscribes the preview, or with none no body (no ord body push), or the full
  version with `body: "full"`; its notice says which and what the pair costs
  (`notice.body`, `notice.cost`, `pair.cost`). `waitForFeeRate` is an
  optional, caller-driven wait for a lower fee rate. The sat reader reports an
  inscription with no body (`noBody`). Packages never carry a preview.
- Behaviour change: an entry naming no preview is inscribed with no body
  unless `body: "full"` is passed; an entry after the anchor is no longer
  refused for a large version unless the full version is chosen.
