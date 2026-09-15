---
'@originals/landing': patch
---

**Landing demo: the Source picker now accepts any bytes, not just PNG/SVG/text (#540).**

`readAssetFile()` previously rejected any upload outside PNG/SVG/plain-text as `wrong-type`, and further gated PNG uploads on an exact magic-byte match — contradicting #540's own acceptance criterion, "Accept any bytes in the Source picker." It now accepts any non-empty file up to the existing 32 KiB cap and publishes the bytes verbatim, preserving a usable content type (the browser's `file.type`, an extension-based guess for formats browsers commonly leave blank, or `application/octet-stream`). The file input's restrictive `accept` attribute is removed, and the composer preview shows a generic placeholder instead of garbled bytes for uploads that are neither text nor an image.
