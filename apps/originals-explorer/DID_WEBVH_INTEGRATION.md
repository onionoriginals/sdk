# DID:WebVH Integration Documentation

## Overview

This document provides technical details about the DID:WebVH integration for migrating user authentication from `did:privy` to `did:webvh` identifiers.

## Table of Contents

1. [Architecture](#architecture)
2. [DID Format & Structure](#did-format--structure)
3. [Feature Flags](#feature-flags)
4. [API Reference](#api-reference)
5. [Token Structure](#token-structure)
6. [Authentication Flow](#authentication-flow)
7. [Migration Strategy](#migration-strategy)
8. [Security Considerations](#security-considerations)
9. [Performance & Caching](#performance--caching)
10. [Testing](#testing)

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Application                      │
│                    (React + Privy Auth)                      │
└─────────────────────────┬───────────────────────────────────┘
                          │ JWT Token
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                   Auth Middleware                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Token Verify │→│ DID Resolver │→│ User Lookup      │  │
│  │ (Privy)      │  │ (did:webvh)  │  │ (Storage)        │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────┬───────────────────────────────────┘
                          │ Authenticated Request
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                    Application Routes                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ User Mgmt    │  │ Asset Mgmt   │  │ DID Services     │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Authentication**:
   - Client sends JWT from Privy
   - Middleware verifies token
   - Resolves DID (did:webvh or did:privy based on flags)
   - Attaches user info to request

2. **DID Creation**:
   - User login/registration triggers DID creation
   - System creates Privy wallets for key material
   - Generates did:webvh identifier
   - Stores mapping in database

3. **Dual-Mode Operation**:
   - Dual-Write: Creates both DIDs
   - Dual-Read: Accepts both DIDs
   - Cutover: Switches primary DID

## DID Format & Structure

### DID:WebVH Format

```
did:webvh:{url-encoded-domain}:{user-slug}
```

**Examples**:
- `did:webvh:localhost%3A5000:u-abc123def456`
- `did:webvh:app.example.com:u-789xyz012abc`
- `did:webvh:example.com%3A8080:u-fedcba987654`

### User Slug Generation

```typescript
// SHA256 hash truncated to 16 chars for stability
const hash = crypto.createHash('sha256')
  .update(privyUserId)
  .digest('hex')
  .substring(0, 16);

const slug = `u-${hash}`; // e.g., "u-abc123def456"
```

**Properties**:
- Stable: Same input → same slug
- Unique: SHA256 ensures no collisions
- URL-safe: Only contains [a-f0-9-]
- Prefixed: Starts with 'u-' (ensures valid URL path)

### DID Document Structure

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1"
  ],
  "id": "did:webvh:localhost%3A5000:u-abc123",
  "verificationMethod": [
    {
      "id": "did:webvh:localhost%3A5000:u-abc123#auth-key",
      "type": "Multikey",
      "controller": "did:webvh:localhost%3A5000:u-abc123",
      "publicKeyMultibase": "z6Mk..."
    },
    {
      "id": "did:webvh:localhost%3A5000:u-abc123#assertion-key",
      "type": "Multikey",
      "controller": "did:webvh:localhost%3A5000:u-abc123",
      "publicKeyMultibase": "z6Mk..."
    }
  ],
  "authentication": [
    "did:webvh:localhost%3A5000:u-abc123#auth-key"
  ],
  "assertionMethod": [
    "did:webvh:localhost%3A5000:u-abc123#assertion-key"
  ]
}
```

**Key Points**:
- Authentication key: Secp256k1 (Bitcoin wallet)
- Assertion key: Ed25519 (Stellar wallet)
- Update key: Stored separately in version history

### Resolution

DID:WebVH resolution follows the specification:

```
did:webvh:{domain}:{path} → https://{domain}/{path}/did.jsonld
```

**Example**:
```
did:webvh:example.com:u-abc123
  ↓
https://example.com/u-abc123/did.jsonld
```

## Feature Flags

### AUTH_DID_WEBVH_ENABLED

**Default**: `false`

Controls whether did:webvh is used as the primary identifier.

- `false`: Use did:privy as primary (legacy mode)
- `true`: Use did:webvh as primary (post-migration)

### AUTH_DID_DUAL_READ_ENABLED

**Default**: `true`

Controls whether both DID types are accepted for authentication.

- `true`: Accept both did:webvh and did:privy
- `false`: Only accept the primary DID type

**Use Case**: Gradual migration, backward compatibility

### AUTH_DID_DUAL_WRITE_ENABLED

**Default**: `true`

Controls whether both DID types are created for new users.

- `true`: Create both did:webvh and did:privy
- `false`: Only create the primary DID type

**Use Case**: Migration phase, ensure all users have both DIDs

### Flag Combinations

| Scenario | WEBVH_ENABLED | DUAL_READ | DUAL_WRITE | Behavior |
|----------|---------------|-----------|------------|----------|
| Pre-migration | `false` | `true` | `false` | Legacy only |
| Migration start | `false` | `true` | `true` | Create both, use privy |
| Post-backfill | `true` | `true` | `true` | Create both, use webvh |
| Post-migration | `true` | `false` | `false` | WebVH only |

## API Reference

### DID Creation

#### `createUserDIDWebVH(userId, privyClient, domain?)`

Creates a did:webvh for a user.

**Parameters**:
- `userId` (string): Privy user ID
- `privyClient` (PrivyClient): Initialized Privy client
- `domain` (string, optional): Domain for DID (default: from env)

**Returns**: `DIDWebVHCreationResult`
```typescript
{
  did: string;
  didDocument: any;
  authWalletId: string;
  assertionWalletId: string;
  updateWalletId: string;
  authKeyPublic: string;
  assertionKeyPublic: string;
  updateKeyPublic: string;
  didCreatedAt: Date;
  didSlug: string;
}
```

**Example**:
```typescript
const result = await createUserDIDWebVH(
  "did:privy:cltest123", 
  privyClient,
  "app.example.com"
);

console.log(result.did);
// "did:webvh:app.example.com:u-abc123"
```

### DID Verification

#### `verifyDIDWebVH(did)`

Validates a did:webvh identifier.

**Parameters**:
- `did` (string): The DID to verify

**Returns**: `{ valid: boolean; error?: string; document?: any }`

**Example**:
```typescript
const result = await verifyDIDWebVH("did:webvh:example.com:u-abc123");

if (result.valid) {
  console.log("DID is valid");
} else {
  console.error("Invalid:", result.error);
}
```

### DID Resolution

#### `resolveDIDWebVH(did)`

Resolves a did:webvh to its DID Document.

**Parameters**:
- `did` (string): The DID to resolve

**Returns**: `any | null` (DID Document or null)

**Caching**: Automatic with 5-minute TTL

**Example**:
```typescript
const doc = await resolveDIDWebVH("did:webvh:example.com:u-abc123");

if (doc) {
  console.log("DID Document:", doc);
}
```

### Utility Functions

#### `getUserSlugFromDID(did)`

Extracts the user slug from a did:webvh.

**Parameters**:
- `did` (string): The DID

**Returns**: `string | null`

**Example**:
```typescript
const slug = getUserSlugFromDID("did:webvh:example.com:u-abc123");
// Returns: "u-abc123"
```

#### `isDidWebVHEnabled()`, `isDualReadEnabled()`, `isDualWriteEnabled()`

Check feature flag status.

**Returns**: `boolean`

## Token Structure

### Post-Migration Token Payload

```json
{
  "sub": "did:webvh:example.com:u-abc123",
  "legacy_sub": "did:privy:cltest123",
  "ver": "webvh-v1",
  "userId": "did:privy:cltest123",
  "iat": 1234567890,
  "exp": 1234571490
}
```

**Fields**:
- `sub`: Primary identifier (did:webvh after cutover)
- `legacy_sub`: Legacy identifier for backward compatibility (optional)
- `ver`: Version identifier for token format
- `userId`: Privy user ID (internal)

### Pre-Migration Token Payload

```json
{
  "sub": "did:privy:cltest123",
  "userId": "did:privy:cltest123",
  "iat": 1234567890,
  "exp": 1234571490
}
```

## Authentication Flow

### 1. Token Verification Flow

```
┌─────────────┐
│   Client    │
│  (JWT)      │
└─────┬───────┘
      │ Bearer token
      ↓
┌─────────────────────────────────────┐
│   Auth Middleware                   │
│                                     │
│  1. Extract token                   │
│  2. Verify with Privy              │
│  3. Get user from storage          │
│  4. Determine canonical DID        │
│     ┌─────────────────────────┐   │
│     │ if WEBVH_ENABLED:       │   │
│     │   if user.did_webvh:    │   │
│     │     verify(did_webvh)   │   │
│     │   else if DUAL_READ:    │   │
│     │     use did_privy       │   │
│     └─────────────────────────┘   │
│  5. Attach user to request         │
└─────────────┬───────────────────────┘
              │ Authenticated request
              ↓
        ┌──────────┐
        │  Routes  │
        └──────────┘
```

### 2. DID Creation Flow

```
┌─────────────┐
│   Client    │
│  (Login)    │
└─────┬───────┘
      │
      ↓
┌─────────────────────────────────────┐
│   POST /api/user/ensure-did         │
│                                     │
│  1. Check existing DIDs             │
│  2. Determine what to create        │
│     ┌─────────────────────────┐   │
│     │ if WEBVH_ENABLED:       │   │
│     │   if !did_webvh:        │   │
│     │     create_webvh()      │   │
│     │ if DUAL_WRITE:          │   │
│     │   if !did_privy:        │   │
│     │     create_legacy()     │   │
│     └─────────────────────────┘   │
│  3. Store in database              │
│  4. Return DID info                │
└─────────────┬───────────────────────┘
              │
              ↓
        ┌──────────┐
        │  Client  │
        │(DID Info)│
        └──────────┘
```

### 3. Dual-Read Decision Logic

```typescript
// Simplified authentication logic
async function authenticate(token: string) {
  // Verify token
  const claims = await privyClient.verifyAuthToken(token);
  const user = await storage.getUser(claims.userId);
  
  // Determine canonical DID
  let canonicalDid: string;
  
  if (isDidWebVHEnabled() && user.did_webvh) {
    // Prefer did:webvh when enabled
    const verification = await verifyDIDWebVH(user.did_webvh);
    
    if (verification.valid) {
      canonicalDid = user.did_webvh;
    } else if (isDualReadEnabled() && user.did_privy) {
      // Fallback to did:privy
      canonicalDid = user.did_privy;
      auditLog('fallback_to_privy', { reason: verification.error });
    } else {
      throw new Error('DID verification failed');
    }
  } else if (isDualReadEnabled() && user.did_privy) {
    canonicalDid = user.did_privy;
  } else {
    canonicalDid = claims.userId; // Fallback
  }
  
  return { ...user, canonicalDid };
}
```

## Migration Strategy

### Phase Diagram

```
┌────────────────────────────────────────────────────────────┐
│                      MIGRATION TIMELINE                     │
└────────────────────────────────────────────────────────────┘

Day 0          Day 2-3        Day 7           Day 30
│              │              │               │
│              │              │               │
▼              ▼              ▼               ▼

Dual-Write     Backfill       Cutover         Cleanup
Started        Complete       to WebVH        Legacy

┌──────────┐  ┌──────────┐  ┌──────────┐    ┌──────────┐
│ Both DIDs│→ │ All users│→ │ Use WebVH│ →  │ WebVH    │
│ created  │  │ migrated │  │ as sub   │    │ only     │
└──────────┘  └──────────┘  └──────────┘    └──────────┘
```

### Database Schema Evolution

**Initial State**:
```sql
users (
  id VARCHAR PRIMARY KEY,
  username TEXT,
  did TEXT,  -- legacy webvh from old system
  ...
)
```

**Migration State**:
```sql
users (
  id VARCHAR PRIMARY KEY,
  username TEXT,
  did_webvh TEXT UNIQUE,           -- NEW: canonical
  did_privy TEXT UNIQUE,            -- NEW: legacy mapping
  did TEXT,                         -- DEPRECATED
  didWebvhDocument JSONB,           -- NEW
  ...
)
```

**Final State** (after cleanup):
```sql
users (
  id VARCHAR PRIMARY KEY,
  username TEXT,
  did_webvh TEXT UNIQUE NOT NULL,  -- canonical
  didWebvhDocument JSONB NOT NULL,
  ...
)
```

## Security Considerations

### Key Management

- **Private Keys**: Never leave Privy infrastructure
- **Public Keys**: Stored as multibase in DID document
- **Key Rotation**: Supported via update key (future)

### DID Verification

```typescript
// Verification includes:
1. Format validation (regex)
2. Component validation (domain, slug)
3. Resolution attempt (with timeout)
4. Signature verification (via didwebvh-ts)
```

### Threat Model

| Threat | Mitigation |
|--------|------------|
| DID spoofing | Cryptographic verification |
| Key compromise | Privy-managed keys, rotation support |
| Downgrade attack | Flag-based primary DID, audit logging |
| SSRF via DID URL | URL validation, HTTPS enforcement |
| Replay attacks | Short-lived tokens, revocation lists |

### Input Validation

```typescript
// DID format
/^did:webvh:[a-zA-Z0-9%._-]+:[a-z0-9-]+$/

// User slug  
/^u-[a-f0-9]{16}$/

// Domain (RFC-compliant)
/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
```

## Performance & Caching

### Latency Budget

| Operation | Target | Acceptable | Maximum |
|-----------|--------|------------|---------|
| DID Creation | < 2s | < 5s | 10s |
| DID Verification (cached) | < 10ms | < 50ms | 100ms |
| DID Verification (uncached) | < 100ms | < 300ms | 500ms |
| DID Resolution (cached) | < 5ms | < 20ms | 50ms |
| DID Resolution (uncached) | < 200ms | < 500ms | 1s |

### Caching Strategy

**In-Memory Cache** (current):
```typescript
const cache = new Map<string, {
  document: any;
  expiresAt: number;
}>();

// Default TTL: 5 minutes
const TTL = 5 * 60 * 1000;
```

**Production Recommendations**:
- Use Redis for distributed caching
- Implement cache warming for active users
- Set cache size limits (LRU eviction)
- Monitor cache hit rate (target: > 90%)

### Performance Monitoring

```typescript
// Metrics to track
emitMetric('didwebvh.create.latency', duration);
emitMetric('didwebvh.verify.latency', duration);
emitMetric('didwebvh.resolve.latency', duration, { cache: 'hit|miss' });
emitMetric('didwebvh.resolve.cache_miss', 1);
```

## Testing

### Unit Tests

```bash
# DID service tests
bun test server/__tests__/didwebvh-service.test.ts

# Auth middleware tests
bun test server/__tests__/auth-middleware.test.ts

# Backfill tests
bun test server/__tests__/backfill-did-webvh.test.ts
```

### Integration Tests

```typescript
describe("End-to-End Migration", () => {
  test("User login with did:webvh", async () => {
    // 1. Create user with did:webvh
    // 2. Login and get token
    // 3. Verify token has did:webvh as sub
    // 4. Make authenticated request
    // 5. Verify request succeeds
  });
  
  test("Dual-read fallback", async () => {
    // 1. User has both DIDs
    // 2. did:webvh verification fails
    // 3. System falls back to did:privy
    // 4. Authentication succeeds
    // 5. Audit log records fallback
  });
});
```

### Load Testing

```bash
# Simulate migration load
artillery run load-test.yml

# Test backfill performance
bun run server/backfill-did-webvh.ts \
  --execute \
  --batch-size 100 \
  --delay 100
```

### Test Scenarios

1. **DID Creation**: Verify stable slug generation
2. **Format Validation**: Test edge cases (ports, special chars)
3. **Dual Mode**: Verify both DIDs work during migration
4. **Fallback**: Test did:privy fallback when did:webvh fails
5. **Idempotency**: Backfill can run multiple times safely
6. **Concurrency**: Handle concurrent DID creation
7. **Error Handling**: Graceful degradation
8. **Performance**: Meet latency budgets

## Observability

### Audit Logging

All DID operations are logged:

```typescript
auditLog('did.webvh_created', {
  userId: 'user-123',
  did: 'did:webvh:...',
  correlationId: 'req-456'
});
```

**Log Format**:
```json
{
  "timestamp": "2025-10-03T12:00:00Z",
  "event": "did.webvh_created",
  "correlationId": "req-456",
  "userId": "user-123",
  "did": "did:webvh:example.com:u-abc123"
}
```

### Metrics

```
# Counters
didwebvh.create.success
didwebvh.create.error
auth.verify.success
auth.verify.error

# Gauges
users.with_webvh
users.with_privy
users.with_both

# Histograms
didwebvh.create.latency
didwebvh.verify.latency
didwebvh.resolve.latency
```

### Alerts

```yaml
alerts:
  - name: HighDIDCreationErrors
    condition: didwebvh.create.error.rate > 1%
    severity: critical
    
  - name: SlowDIDResolution
    condition: didwebvh.resolve.latency.p95 > 300ms
    severity: warning
    
  - name: AuthFailureSpike
    condition: auth.verify.error.rate > 0.1%
    severity: critical
```

## Downstream Service Integration

### Token Validation

Downstream services must:

1. Accept `did:webvh:*` as `sub` claim
2. Optionally use `legacy_sub` for migration
3. Update DID resolution logic
4. Handle both formats during transition

### Example Integration

```typescript
// Before
const userId = claims.sub; // did:privy:*

// After
const userId = claims.sub; // did:webvh:*

// During migration
const userId = claims.sub.startsWith('did:webvh:') 
  ? claims.sub 
  : claims.legacy_sub || claims.sub;
```

### Communication Template

```
Subject: DID Format Migration - Action Required

We are migrating user identifiers from did:privy to did:webvh.

Timeline:
- Phase 1 (Days 0-7): Both formats active
- Phase 2 (Day 7+): did:webvh becomes primary
- Phase 3 (Day 30+): did:privy deprecated

Action Required:
1. Update token validation to accept did:webvh:* format
2. Use 'legacy_sub' claim during transition if needed
3. Deploy changes before Day 7

Breaking Changes:
- 'sub' claim format will change
- DID resolution endpoints updated

Support: your-team@example.com
```

## References

- [DID:WebVH Specification](https://github.com/aviarytech/didwebvh-ts)
- [DID Core Specification](https://www.w3.org/TR/did-core/)
- [Multikey Specification](https://w3c-ccg.github.io/multikey/)
- [Migration Runbook](./MIGRATION_RUNBOOK.md)
