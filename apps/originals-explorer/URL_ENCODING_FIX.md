# URL Encoding Fix for DID:WebVH

## Summary

Fixed DID generation and slug extraction to properly URL-encode the domain portion of DIDs, as required by the DID:WebVH specification.

## Problem

The code review identified that DIDs like `did:webvh:localhost:5000:user123` were ambiguous because the regex pattern couldn't distinguish between the port separator (`:5000`) and the DID component separator (`:user123`). This caused `getUserSlugFromDID()` to return `"5000:user123"` instead of `"user123"`.

## Solution

### 1. URL-Encode the Domain (did-service.ts)

```typescript
// Before
const did = `did:webvh:${domain}:${userSlug}`;

// After
const encodedDomain = encodeURIComponent(domain);
const did = `did:webvh:${encodedDomain}:${userSlug}`;
```

**Result:**
- `localhost:5000` → `localhost%3A5000`
- DID becomes: `did:webvh:localhost%3A5000:user123`

### 2. Updated Slug Extraction (did-service.ts)

```typescript
export function getUserSlugFromDID(did: string): string | null {
  // DID format: did:webvh:{encoded-domain}:{slug}
  // The domain is URL-encoded, so colons in ports become %3A
  // We split on ':' and take the last segment as the slug
  const parts = did.split(':');
  
  // Valid format: ['did', 'webvh', '{encoded-domain}', '{slug}']
  // Minimum 4 parts, last part is the slug
  if (parts.length < 4 || parts[0] !== 'did' || parts[1] !== 'webvh') {
    return null;
  }
  
  // Return the last segment (the user slug)
  return parts[parts.length - 1];
}
```

**How it works:**
- `did:webvh:localhost%3A5000:user123` splits into: `['did', 'webvh', 'localhost%3A5000', 'user123']`
- Returns the last element: `'user123'` ✅

## Examples

### Development (with port)
```
Domain: localhost:5000
Encoded: localhost%3A5000
DID: did:webvh:localhost%3A5000:cltest123456
Resolves to: http://localhost:5000/cltest123456/did.jsonld
Slug extracted: cltest123456
```

### Production (without port)
```
Domain: app.example.com
Encoded: app.example.com (no special chars)
DID: did:webvh:app.example.com:user123
Resolves to: https://app.example.com/user123/did.jsonld
Slug extracted: user123
```

## DID:WebVH Spec Compliance

According to the [DID:WebVH specification](https://identity.foundation/didwebvh/v1.0/), the domain portion of a DID should be URL-encoded to handle special characters like colons in ports.

**Transformation:**
1. DID: `did:webvh:localhost%3A5000:user123`
2. Split on `:` → `['did', 'webvh', 'localhost%3A5000', 'user123']`
3. Extract domain: `localhost%3A5000`
4. Decode domain: `localhost:5000`
5. Extract path: `user123`
6. Resolve to: `http://localhost:5000/user123/did.jsonld`

## Files Updated

### Core Logic
1. **`server/did-service.ts`**
   - Added `encodeURIComponent()` when creating DID
   - Rewrote `getUserSlugFromDID()` to split on `:` and take last segment

### Tests
2. **`server/__tests__/did-service.test.ts`**
   - Updated all DID assertions to use `%3A` instead of `:`
   - Added test for domain without port
   - Added test for missing slug validation

### Documentation
3. **`DID_SETUP.md`** - Updated examples with URL-encoded domains
4. **`README_DID.md`** - Added explanation of URL encoding
5. **`IMPLEMENTATION_SUMMARY.md`** - Updated all DID examples
6. **`server/routes.ts`** - Updated route comments with correct format

## Breaking Changes

⚠️ **This is a breaking change for existing DIDs**

If any DIDs were created before this fix, they will have the wrong format and need to be recreated. Since this is a new feature, this should not affect production systems.

## Testing

### Unit Tests
All tests updated to expect URL-encoded domains:

```typescript
// Development (with port)
expect(result.did).toMatch(/^did:webvh:localhost%3A5000:cltest123456$/);

// Production (no port)
expect(result.did).toMatch(/^did:webvh:app\.example\.com:user123$/);
```

### Slug Extraction Tests
```typescript
// Extracts correctly from encoded DID
getUserSlugFromDID('did:webvh:localhost%3A5000:user123') 
// Returns: 'user123' ✅

// Works with domains without ports
getUserSlugFromDID('did:webvh:app.example.com:user123')
// Returns: 'user123' ✅
```

## Verification Checklist

- [x] Domain encoding added to `createUserDID()`
- [x] `getUserSlugFromDID()` rewritten to handle encoded domains
- [x] All tests updated with `%3A` for ports
- [x] Documentation updated with URL encoding explanation
- [x] Route comments updated with correct transformation
- [x] Examples show both development and production formats

## Additional Notes

### Why URL Encode?

The DID:WebVH spec requires URL encoding because:
1. DIDs use `:` as a component separator
2. Domains with ports also use `:` 
3. Without encoding, `did:webvh:localhost:5000:user` is ambiguous
4. With encoding, `did:webvh:localhost%3A5000:user` is unambiguous

### What Gets Encoded?

`encodeURIComponent()` encodes:
- `:` → `%3A` (colon in ports)
- `/` → `%2F` (if paths in domain)
- `?` → `%3F` (query params)
- `#` → `%23` (fragments)
- And all other special URI characters

### Resolution Still Works

The HTTP endpoint doesn't change:
- Request: `GET /user123/did.jsonld`
- The domain in the DID is encoded, but the HTTP path is not
- Resolution works because we decode when needed

## References

- [DID:WebVH Specification](https://identity.foundation/didwebvh/v1.0/)
- [RFC 3986 - URI Generic Syntax](https://www.rfc-editor.org/rfc/rfc3986)
- [MDN - encodeURIComponent()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent)
