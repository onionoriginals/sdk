# Turnkey Migration V2 - Comprehensive Plan

## Summary
Complete migration from Privy to Turnkey, incorporating all PR #102 feedback for secure, production-ready implementation.

## Critical PR Feedback Addressed

### 1. **Authentication Security** (CRITICAL)
**Problem:** Tokens and emails stored in localStorage (XSS/PII risks)
**Solution:**
- Use HTTP-only cookies for authentication tokens
- Server-side session management with secure cookies
- Email/user info fetched from secure server endpoint
- NO client-side storage of sensitive data

### 2. **Token Format Alignment** (CRITICAL)
**Problem:** Client tokens are not proper JWTs, server parsing fails
**Solution:**
- Implement proper JWT token issuance server-side
- Use jsonwebtoken library for signing/verification
- Include proper claims: sub (Turnkey org ID), exp, iat
- OR: Update server to explicitly accept simplified format

### 3. **Turnkey ID Consistency** (CRITICAL)
**Problem:** Using email as Turnkey user ID instead of org/sub-org ID
**Solution:**
- Create Turnkey sub-organizations for each user
- Store and use sub-org ID as turnkeyUserId
- Email is metadata only, never used as ID in API calls
- Update all DID creation and signing to use sub-org ID

### 4. **User Record Integrity** (CRITICAL)
**Problem:** User records swapped/replaced, breaking referential integrity
**Solution:**
- Keep `user.id` (UUID) stable - NEVER change it
- Update records in-place when promoting temp users
- Make `getUserByTurnkeyId` resilient with fallback logic
- Preserve foreign key relationships

### 5. **Ed25519 Signing Fixes** (CRITICAL)
**Problem:** Wrong hash function and signature extraction
**Solution:**
- Use `HASH_FUNCTION_NOT_APPLICABLE` (not NO_OP) for Ed25519
- Extract signature as single hex blob (not r/s fields)
- Signature format: entire response is 64-byte hex string
- Update signature concatenation logic

### 6. **Key Management with Tagging** (HIGH)
**Problem:** No key isolation between users, potential collisions
**Solution:**
- Tag ALL keys with user-specific slug: `user-${userSlug}`
- Filter keys by tag on read/list operations
- Ensure proper key isolation per sub-organization
- Clear key ownership tracking

### 7. **Documentation Updates** (MEDIUM)
**Problem:** References old SDK versions, no breaking change warnings
**Solution:**
- Update to latest Turnkey SDK versions (v5.x for client, v4.10+ for server)
- Document supported version range
- Add warnings about breaking changes
- Include migration guide updates

## Implementation Plan

### Phase 1: Dependencies & Configuration

#### 1.1 Update package.json
```json
{
  "dependencies": {
    // REMOVE
    "@privy-io/node": "REMOVE",
    "@privy-io/react-auth": "REMOVE",

    // ADD
    "@turnkey/sdk-server": "^4.10.4",
    "@turnkey/sdk-browser": "^5.11.5",
    "@turnkey/sdk-react": "^5.4.7",
    "jsonwebtoken": "^9.0.2",
    "cookie-parser": "^1.4.7"
  },
  "devDependencies": {
    "@types/jsonwebtoken": "^9.0.6",
    "@types/cookie-parser": "^1.4.7"
  }
}
```

#### 1.2 Update .env.example
```env
# Turnkey Configuration
TURNKEY_ORGANIZATION_ID=your_main_org_id
TURNKEY_API_PUBLIC_KEY=your_api_public_key
TURNKEY_API_PRIVATE_KEY=your_api_private_key

# JWT Configuration
JWT_SECRET=your_jwt_secret_min_32_chars
JWT_EXPIRES_IN=7d

# Vite Client Config
VITE_TURNKEY_ORGANIZATION_ID=your_main_org_id
```

### Phase 2: Database Schema

#### 2.1 Update shared/schema.ts
```typescript
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),

  // Turnkey-related fields
  turnkeySubOrgId: text("turnkey_sub_org_id").unique(), // Sub-organization ID (NOT email!)
  email: text("email"), // Metadata only, not used as ID

  // DID-related fields
  did: text("did"),
  didDocument: jsonb("did_document"),
  didLog: jsonb("did_log"),
  didSlug: text("did_slug"),

  // Turnkey private key IDs (tagged with user slug)
  authKeyId: text("auth_key_id"), // For authentication
  assertionKeyId: text("assertion_key_id"), // For signing credentials
  updateKeyId: text("update_key_id"), // For DID updates

  // Public keys in multibase format
  authKeyPublic: text("auth_key_public"),
  assertionKeyPublic: text("assertion_key_public"),
  updateKeyPublic: text("update_key_public"),

  didCreatedAt: timestamp("did_created_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
```

### Phase 3: Authentication System

#### 3.1 Create server/auth/jwt.ts
```typescript
import jwt from 'jsonwebtoken';

export interface TokenPayload {
  sub: string; // Turnkey sub-org ID
  email: string; // User email (metadata)
  iat: number;
  exp: number;
}

export function signToken(subOrgId: string, email: string): string {
  return jwt.sign(
    { sub: subOrgId, email },
    process.env.JWT_SECRET!,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
}
```

#### 3.2 Update server/routes.ts - Authentication Middleware
```typescript
import cookieParser from 'cookie-parser';
import { verifyToken } from './auth/jwt';

app.use(cookieParser());

const authenticateUser = async (req, res, next) => {
  try {
    const token = req.cookies.auth_token;
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const payload = verifyToken(token);
    const turnkeySubOrgId = payload.sub; // Use sub-org ID from token

    let user = await storage.getUserByTurnkeyId(turnkeySubOrgId);

    if (!user) {
      // Auto-create user with DID
      const didData = await createUserDIDWebVH(turnkeySubOrgId, turnkeyClient);
      user = await storage.createUserWithDid(
        payload.email,
        turnkeySubOrgId,
        didData.did,
        didData
      );
    }

    req.user = {
      id: user.id, // Stable UUID
      turnkeySubOrgId,
      did: user.did,
      email: payload.email
    };
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};
```

### Phase 4: Turnkey Integration

#### 4.1 Create server/turnkey-signer.ts

**Critical Ed25519 Fixes:**
```typescript
async sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }): Promise<{ proofValue: string }> {
  const { prepareDataForSigning } = await import('@originals/sdk');
  const dataToSign = await prepareDataForSigning(input.document, input.proof);
  const dataHex = bytesToHex(dataToSign);

  // CRITICAL: Use HASH_FUNCTION_NOT_APPLICABLE for Ed25519 (not NO_OP!)
  const signResponse = await this.turnkeyClient.apiClient().signRawPayload({
    signWith: this.privateKeyId,
    payload: dataHex,
    encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
    hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE', // CORRECT for Ed25519
  });

  // CRITICAL: Ed25519 returns single hex blob, NOT r/s fields
  const signature = signResponse.signature; // Single 64-byte hex string
  const signatureBytes = Buffer.from(signature, 'hex');
  const proofValue = multikey.encodeMultibase(signatureBytes);
  return { proofValue };
}
```

#### 4.2 Key Management with Tagging
```typescript
async function createVerificationMethodsFromTurnkey(
  subOrgId: string,
  turnkeyClient: Turnkey,
  domain: string,
  userSlug: string
) {
  // Generate unique tag for this user
  const userTag = `user-${userSlug}`;

  // Create keys with user-specific tags
  const authKeyResponse = await turnkeyClient.apiClient().createPrivateKeys({
    organizationId: subOrgId, // Sub-org context
    privateKeys: [{
      privateKeyName: `auth-key-${userSlug}`,
      curve: 'CURVE_ED25519',
      addressFormats: ['ADDRESS_FORMAT_XLM'],
      privateKeyTags: [userTag, 'auth', 'did:webvh'], // TAGGED!
    }],
  });

  // Similar for update and assertion keys...

  // Filter keys by tag when retrieving
  const userKeys = existingKeys.filter(k =>
    k.privateKeyTags?.includes(userTag)
  );
}
```

#### 4.3 Sub-Organization Management
```typescript
async function ensureUserSubOrg(email: string, turnkeyClient: Turnkey): Promise<string> {
  // Check if sub-org exists for this user
  const subOrgs = await turnkeyClient.apiClient().getSubOrganizations();
  const userSlug = generateUserSlug(email);

  const existing = subOrgs.subOrganizations?.find(
    org => org.subOrganizationId?.includes(userSlug)
  );

  if (existing) {
    return existing.subOrganizationId!;
  }

  // Create new sub-organization
  const result = await turnkeyClient.apiClient().createSubOrganization({
    subOrganizationName: `user-${userSlug}`,
    rootUsers: [{
      userName: email,
      userEmail: email,
      authenticators: [],
    }],
  });

  return result.subOrganizationId!;
}
```

### Phase 5: Database Layer

#### 5.1 Update storage.ts - Maintain User ID Integrity
```typescript
async getUserByTurnkeyId(turnkeySubOrgId: string): Promise<User | undefined> {
  const result = await this.db.select().from(users)
    .where(eq(users.turnkeySubOrgId, turnkeySubOrgId))
    .limit(1);
  return result[0];
}

async createUserWithDid(
  email: string,
  turnkeySubOrgId: string,
  did: string,
  didData: DIDData
): Promise<User> {
  // Check for existing temp user to promote
  const tempUser = await this.db.select().from(users)
    .where(eq(users.email, email))
    .where(isNull(users.turnkeySubOrgId))
    .limit(1);

  if (tempUser[0]) {
    // UPDATE in place - keep user.id stable!
    await this.db.update(users)
      .set({
        turnkeySubOrgId,
        did,
        didDocument: didData.didDocument,
        authKeyId: didData.authKeyId,
        assertionKeyId: didData.assertionKeyId,
        updateKeyId: didData.updateKeyId,
        authKeyPublic: didData.authKeyPublic,
        assertionKeyPublic: didData.assertionKeyPublic,
        updateKeyPublic: didData.updateKeyPublic,
        didCreatedAt: new Date(),
      })
      .where(eq(users.id, tempUser[0].id));

    return { ...tempUser[0], turnkeySubOrgId, did, ...didData };
  }

  // Create new user
  const [newUser] = await this.db.insert(users).values({
    username: email,
    email,
    turnkeySubOrgId,
    did,
    // ... rest of didData
  }).returning();

  return newUser;
}
```

### Phase 6: Client-Side Updates

#### 6.1 Update client/src/App.tsx
```typescript
import { TurnkeyProvider } from "@turnkey/sdk-react";

const turnkeyConfig = {
  apiBaseUrl: "https://api.turnkey.com",
  defaultOrganizationId: import.meta.env.VITE_TURNKEY_ORGANIZATION_ID,
  // DO NOT store credentials client-side!
};

export default function App() {
  return (
    <TurnkeyProvider config={turnkeyConfig}>
      <QueryClientProvider client={queryClient}>
        {/* App content */}
      </QueryClientProvider>
    </TurnkeyProvider>
  );
}
```

#### 6.2 Update client/src/hooks/useAuth.ts
```typescript
export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Fetch user from server (includes email from secure endpoint)
  const { data: serverUser } = useQuery<{
    id: string;
    did: string;
    email: string;
    turnkeySubOrgId: string;
  }>({
    queryKey: ['/api/user'],
    enabled: isAuthenticated,
  });

  const login = useCallback(async (email: string) => {
    // Server creates sub-org and issues JWT in HTTP-only cookie
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      credentials: 'include', // Important for cookies!
    });

    if (response.ok) {
      setIsAuthenticated(true);
      // NO localStorage! Cookie is HTTP-only
    }
  }, []);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
    });
    setIsAuthenticated(false);
  }, []);

  return { user: serverUser, isAuthenticated, login, logout };
}
```

## Testing Checklist

- [ ] Authentication flow with HTTP-only cookies
- [ ] JWT token issuance and validation
- [ ] Sub-organization creation
- [ ] Key creation with proper tagging
- [ ] Ed25519 signing with correct hash function
- [ ] Signature extraction (single hex blob)
- [ ] DID creation with Turnkey keys
- [ ] User record integrity (stable ID)
- [ ] Credential signing with assertion keys
- [ ] Session persistence across page reloads
- [ ] Secure logout (cookie clearing)

## Security Improvements

1. ✅ No client-side token/email storage (XSS protection)
2. ✅ HTTP-only cookies (can't be accessed by JavaScript)
3. ✅ Proper JWT validation server-side
4. ✅ Secure session management
5. ✅ Key isolation with user tags
6. ✅ Sub-organization per user (Turnkey best practice)

## Documentation Updates

- Update README with new Turnkey setup instructions
- Document JWT secret generation
- Explain sub-organization architecture
- Add security best practices section
- Update SDK version compatibility matrix
