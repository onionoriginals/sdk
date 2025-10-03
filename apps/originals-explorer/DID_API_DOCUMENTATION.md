# DID Management API Documentation

This document describes the DID (Decentralized Identifier) management API endpoints for creating and managing `did:webvh` identifiers.

## Overview

The system automatically creates `did:webvh` identifiers for new users during authentication. These DIDs are fully spec-compliant and include cryptographic proofs and verification methods.

## DID Format

```
did:webvh:{url-encoded-domain}:{user-slug}
```

Example:
```
did:webvh:localhost%3A5000:alice
```

## Automatic DID Creation

DIDs are **automatically created** when a user authenticates for the first time. No manual action required.

### How It Works

1. User authenticates via Privy
2. System checks if user has a DID
3. If not, creates:
   - Three Privy-managed wallets (Bitcoin for authentication, 2x Stellar for assertion and updates)
   - DID document with verification methods
   - DID log (did.jsonl) with cryptographic metadata
4. User record is created with DID as primary identifier

## API Endpoints

### 1. Get Current User's DID

Get the authenticated user's information including their DID.

**Endpoint:** `GET /api/user`

**Authentication:** Required (Bearer token)

**Response:**
```json
{
  "id": "did:webvh:localhost%3A5000:alice",
  "did": "did:webvh:localhost%3A5000:alice",
  "privyId": "did:privy:cltest123456"
}
```

---

### 2. Get DID Document (Authenticated)

Retrieve the full DID document for the authenticated user.

**Endpoint:** `GET /api/did/me`

**Authentication:** Required (Bearer token)

**Response:**
```json
{
  "did": "did:webvh:localhost%3A5000:alice",
  "didDocument": {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1"
    ],
    "id": "did:webvh:localhost%3A5000:alice",
    "verificationMethod": [
      {
        "id": "did:webvh:localhost%3A5000:alice#auth-key",
        "type": "Multikey",
        "controller": "did:webvh:localhost%3A5000:alice",
        "publicKeyMultibase": "z6Mk..."
      },
      {
        "id": "did:webvh:localhost%3A5000:alice#assertion-key",
        "type": "Multikey",
        "controller": "did:webvh:localhost%3A5000:alice",
        "publicKeyMultibase": "z6Mk..."
      }
    ],
    "authentication": ["did:webvh:localhost%3A5000:alice#auth-key"],
    "assertionMethod": ["did:webvh:localhost%3A5000:alice#assertion-key"]
  },
  "createdAt": "2025-10-03T10:30:00.000Z"
}
```

---

### 3. Get DID Log (Authenticated)

Retrieve the DID log (did.jsonl content) for the authenticated user.

**Endpoint:** `GET /api/did/me/log`

**Authentication:** Required (Bearer token)

**Response:**
```json
{
  "did": "did:webvh:localhost%3A5000:alice",
  "log": [
    {
      "versionId": "1-1696334400000",
      "versionTime": "2025-10-03T10:30:00.000Z",
      "parameters": {
        "method": "did:webvh",
        "updateKeys": ["did:key:z6Mk..."],
        "portable": false
      },
      "state": {
        "@context": [...],
        "id": "did:webvh:localhost%3A5000:alice",
        "verificationMethod": [...]
      },
      "proof": [
        {
          "type": "DataIntegrityProof",
          "cryptosuite": "eddsa-jcs-2022",
          "created": "2025-10-03T10:30:00.000Z",
          "verificationMethod": "did:webvh:localhost%3A5000:alice#update-key",
          "proofPurpose": "authentication",
          "proofValue": "z...",
          "metadata": {
            "authWalletId": "...",
            "assertionWalletId": "...",
            "updateWalletId": "..."
          }
        }
      ]
    }
  ]
}
```

---

### 4. Resolve DID (Public)

Resolve any DID:WebVH identifier to get its document.

**Endpoint:** `GET /api/did/resolve/:did`

**Authentication:** Not required

**Parameters:**
- `did` (path) - The full DID to resolve (e.g., `did:webvh:localhost%3A5000:alice`)

**Example:**
```
GET /api/did/resolve/did:webvh:localhost%3A5000:alice
```

**Response:**
```json
{
  "did": "did:webvh:localhost%3A5000:alice",
  "didDocument": { ... },
  "createdAt": "2025-10-03T10:30:00.000Z"
}
```

**Error Responses:**
- `400` - Invalid DID format
- `404` - DID not found

---

### 5. Serve DID Document (Public - DID:WebVH Spec)

Public endpoint that serves the DID document according to the DID:WebVH specification.

**Endpoint:** `GET /:userSlug/did.jsonld`

**Authentication:** Not required

**Content-Type:** `application/did+ld+json`

**Example:**
```
GET /alice/did.jsonld
```

**Response:**
```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1"
  ],
  "id": "did:webvh:localhost%3A5000:alice",
  "verificationMethod": [...],
  "authentication": [...],
  "assertionMethod": [...]
}
```

---

### 6. Serve DID Log (Public - DID:WebVH Spec)

Public endpoint that serves the DID log (did.jsonl) according to the DID:WebVH specification.

**Endpoint:** `GET /.well-known/did/:userSlug/did.jsonl`

**Authentication:** Not required

**Content-Type:** `application/jsonl`

**Example:**
```
GET /.well-known/did/alice/did.jsonl
```

**Response:** (JSONL format - one JSON object per line)
```jsonl
{"versionId":"1-1696334400000","versionTime":"2025-10-03T10:30:00.000Z","parameters":{"method":"did:webvh","updateKeys":["did:key:z6Mk..."],"portable":false},"state":{...},"proof":[...]}
```

---

## DID Creation Modes

### Mode 1: Privy-Managed Keys (Default)

**Automatic on first authentication**

- Private keys managed securely by Privy
- Three wallets created:
  - Bitcoin wallet (authentication key - Secp256k1)
  - Stellar wallet (assertion key - Ed25519)
  - Stellar wallet (update key - Ed25519)
- Public keys extracted and stored as multibase
- DID document and log created

**Pros:**
- No private key management required
- Fully managed security
- Automatic during authentication

**Cons:**
- Signing requires Privy API calls
- Limited to Privy-supported operations

### Mode 2: SDK-Managed Keys (Advanced)

**For advanced users who want full control**

Use the WebVH Integration Service directly:

```typescript
import { webvhService } from './server/webvh-integration';

// Create DID with SDK-managed keys
const result = await webvhService.createDIDWithSDK('alice');

// Result includes:
// - did: The DID identifier
// - didDocument: Full DID document
// - log: DID log entries
// - keyPair: Generated key pair (Ed25519)
// - logPath: Path where did.jsonl was saved
```

**Pros:**
- Full cryptographic signing capabilities
- Complete control over keys
- Standards-compliant proofs

**Cons:**
- User must manage private keys
- More complex implementation

---

## DID Resolution Flow

1. **Internal Resolution** (via API):
   ```
   GET /api/did/resolve/did:webvh:localhost%3A5000:alice
   → Queries database
   → Returns DID document
   ```

2. **External Resolution** (DID:WebVH spec):
   ```
   did:webvh:localhost%3A5000:alice
   → Resolves to: http://localhost:5000/alice/did.jsonld
   → Public HTTP endpoint
   → Returns DID document
   ```

3. **Log Resolution** (DID:WebVH spec):
   ```
   did:webvh:localhost%3A5000:alice
   → Log at: http://localhost:5000/.well-known/did/alice/did.jsonl
   → Returns JSONL format log
   ```

---

## Security Considerations

### Private Key Management

**Privy-Managed:**
- Private keys never leave Privy's secure infrastructure
- Keys are stored in Privy's HSM (Hardware Security Module)
- Access via Privy API with proper authentication

**SDK-Managed:**
- Private keys generated and stored locally
- User responsible for key security
- Recommended for advanced use cases only

### DID Document Security

- DID documents are public by design
- Only contain public keys
- Verification methods enable authentication
- No sensitive data in DID documents

### API Authentication

- All authenticated endpoints require Bearer token
- Token verified via Privy
- User identity tied to DID

---

## Example Usage

### Creating a User with DID

```typescript
// User authenticates via Privy
const token = await privy.authenticate();

// Make authenticated request
const response = await fetch('https://api.example.com/api/user', {
  headers: {
    'Authorization': `Bearer ${token}`,
  },
});

const user = await response.json();
console.log(user.did); // did:webvh:example.com:alice
```

### Resolving a DID

```typescript
// Resolve via API
const response = await fetch(
  'https://api.example.com/api/did/resolve/did:webvh:example.com:alice'
);
const { didDocument } = await response.json();

// Or resolve via DID:WebVH spec
const docResponse = await fetch('https://example.com/alice/did.jsonld');
const didDoc = await docResponse.json();
```

### Getting DID Log

```typescript
// Via API (authenticated)
const response = await fetch('https://api.example.com/api/did/me/log', {
  headers: { 'Authorization': `Bearer ${token}` },
});
const { log } = await response.json();

// Via DID:WebVH spec (public)
const logResponse = await fetch('https://example.com/.well-known/did/alice/did.jsonl');
const jsonlContent = await logResponse.text();
const logEntries = jsonlContent.split('\n').map(line => JSON.parse(line));
```

---

## Troubleshooting

### DID Not Found

**Issue:** `404` error when resolving DID

**Solutions:**
1. Verify the DID format is correct
2. Ensure user has authenticated at least once
3. Check the user slug matches the DID

### DID Log Not Available

**Issue:** DID log endpoint returns `404`

**Solutions:**
1. Ensure database schema includes `did_log` field
2. Run migrations: Check `migrations/0001_add_did_log_fields.sql`
3. Verify user was created after migration

### Authentication Failures

**Issue:** `401` errors on protected endpoints

**Solutions:**
1. Verify Bearer token is valid
2. Check token hasn't expired
3. Ensure token is properly formatted: `Bearer <token>`

---

## Related Documentation

- [DID:WebVH Specification](https://github.com/bcgov/trustdidweb)
- [Privy Documentation](https://docs.privy.io/)
- [Originals SDK Documentation](../../README.md)

---

## Support

For issues or questions:
1. Check this documentation
2. Review the implementation in `server/routes.ts`
3. Examine `server/did-webvh-service.ts` for DID creation logic
4. See `server/webvh-integration.ts` for SDK integration

---

*Last Updated: 2025-10-03*
