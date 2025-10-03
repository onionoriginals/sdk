# DID:WebVH Authentication

This application uses **did:webvh** identifiers for user authentication, created using the `didwebvh-ts` library.

## Overview

When users log in with Privy, the system automatically creates a `did:webvh` identifier for them using Privy-managed wallets. All private keys are securely managed by Privy and never exposed to the application.

## How It Works

### 1. User Login
- User authenticates with Privy (social login, email, etc.)
- Privy issues a JWT token
- Application verifies the token

### 2. DID Creation
- First time a user logs in, the system calls `/api/user/ensure-did`
- Three Privy-managed wallets are created:
  - **Bitcoin wallet** (Secp256k1) - for authentication
  - **Stellar wallet #1** (Ed25519) - for assertions
  - **Stellar wallet #2** (Ed25519) - for DID updates
- Public keys are extracted and converted to multibase format
- A `did:webvh` is generated with the format: `did:webvh:{domain}:{user-slug}`

### 3. DID Format

```
did:webvh:localhost%3A5000:p-cltest123
```

- **Method**: `webvh`
- **Domain**: URL-encoded (ports use `%3A`)
- **User Slug**: Privy user ID (without `did:privy:` prefix), prefixed with `p-`

**Example transformation**:
- Privy ID: `did:privy:cltest123`
- User Slug: `p-cltest123`
- Full DID: `did:webvh:localhost%3A5000:p-cltest123`

### 4. DID Document

The DID document contains two verification methods:

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1"
  ],
  "id": "did:webvh:example.com:p-cltest123",
  "verificationMethod": [
    {
      "id": "did:webvh:example.com:p-cltest123#auth-key",
      "type": "Multikey",
      "controller": "did:webvh:example.com:p-cltest123",
      "publicKeyMultibase": "z6Mk..."
    },
    {
      "id": "did:webvh:example.com:p-cltest123#assertion-key",
      "type": "Multikey",
      "controller": "did:webvh:example.com:p-cltest123",
      "publicKeyMultibase": "z6Mk..."
    }
  ],
  "authentication": ["did:webvh:example.com:p-cltest123#auth-key"],
  "assertionMethod": ["did:webvh:example.com:p-cltest123#assertion-key"]
}
```

## Configuration

### Environment Variables

```bash
# Required
PRIVY_APP_ID=your_app_id
PRIVY_APP_SECRET=your_app_secret

# DID domain (defaults to localhost:5000 in dev)
DID_DOMAIN=localhost:5000

# Optional: Privy wallet policy IDs
PRIVY_EMBEDDED_WALLET_POLICY_IDS=
```

### Development

```bash
# Install dependencies
bun install

# Set environment variables
cp .env.example .env
# Edit .env with your Privy credentials

# Run development server
bun run dev
```

## API Endpoints

### Create/Get User DID

**POST** `/api/user/ensure-did`

Requires authentication (Bearer token from Privy).

Creates a `did:webvh` for the user if one doesn't exist, or returns the existing DID.

**Response:**
```json
{
  "did": "did:webvh:localhost%3A5000:p-cltest123",
  "didDocument": { ... },
  "created": true
}
```

### Get DID Document

**GET** `/{userSlug}/did.jsonld`

Public endpoint that serves the DID document for a user.

Example: `http://localhost:5000/p-cltest123/did.jsonld`

## Database Schema

```typescript
users {
  id: string (primary key)
  username: string
  did: string (unique) // did:webvh identifier
  didDocument: jsonb   // Complete DID document
  didCreatedAt: timestamp
  authWalletId: string // Privy wallet IDs
  assertionWalletId: string
  updateWalletId: string
  authKeyPublic: string // Public keys in multibase
  assertionKeyPublic: string
  updateKeyPublic: string
}
```

## Key Management

- **Private Keys**: Managed entirely by Privy, never exposed
- **Public Keys**: Stored in multibase format in DID document
- **Wallet IDs**: Stored for future key operations
- **Key Rotation**: Supported via update key (future enhancement)

## Security

- ✅ All private keys managed by Privy's secure infrastructure
- ✅ Public keys in standard multibase format
- ✅ DID format validated on creation
- ✅ User slug uses SHA256 hash for stability and security
- ✅ HTTPS enforced for DID resolution in production

## Testing

```bash
# Run tests
bun test server/__tests__/didwebvh-service.test.ts

# Test DID creation
curl -X POST http://localhost:5000/api/user/ensure-did \
  -H "Authorization: Bearer YOUR_PRIVY_TOKEN"

# Get DID document
curl http://localhost:5000/p-cltest123/did.jsonld
```

## References

- [DID:WebVH Specification](https://github.com/aviarytech/didwebvh-ts)
- [DID Core Specification](https://www.w3.org/TR/did-core/)
- [Multikey Specification](https://w3c-ccg.github.io/multikey/)
- [Privy Documentation](https://docs.privy.io/)

## Implementation Files

- `server/didwebvh-service.ts` - Core DID creation logic
- `server/routes.ts` - API endpoints
- `server/key-utils.ts` - Key conversion utilities
- `shared/schema.ts` - Database schema
- `server/__tests__/didwebvh-service.test.ts` - Tests
