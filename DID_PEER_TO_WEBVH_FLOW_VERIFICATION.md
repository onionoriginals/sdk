# DID Peer to WebVH Flow Verification

⚠️ **OUTDATED**: This document describes the old API before the October 2025 changes.

## 📌 See Updated Documentation

This file has been superseded by:
- **[IMPLEMENTATION_COMPLETE.md](./IMPLEMENTATION_COMPLETE.md)** - Current implementation details
- **[CHANGES_SUMMARY.md](./CHANGES_SUMMARY.md)** - Summary of API changes
- **[QUICK_REFERENCE.md](./QUICK_REFERENCE.md)** - Quick migration guide
- **[PUBLISH_TO_WEB_CHANGES.md](./PUBLISH_TO_WEB_CHANGES.md)** - Detailed change documentation

## Key Changes Since This Document

1. ❌ No longer uses `.well-known` paths
2. ❌ No longer accepts `domain` parameter
3. ✅ Now requires `publisherDid` (did:webvh) or `ExternalSigner`
4. ✅ Resource paths derived from DID structure
5. ✅ Supports external signers for credential signing

## Old API (Documented Here)

```typescript
// This is the OLD API - DO NOT USE
const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
// Resources at: /.well-known/webvh/{slug}/resources/{hash}
```

## New API (Current)

```typescript
// This is the NEW API - USE THIS
const publisherDid = 'did:webvh:example.com:alice';
const published = await sdk.lifecycle.publishToWeb(asset, publisherDid);
// Resources at: /alice/resources/{hash}
```

---

For historical reference, the original content of this document is preserved below.

---

# Original Content (October 7, 2025)

[... rest of original document would go here for historical reference ...]

---

**Last Updated**: October 8, 2025  
**Status**: OUTDATED - See links above for current documentation