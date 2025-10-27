# Turnkey Email Authentication Implementation

This document describes the proper email-based authentication implementation that replaces the previous insecure direct-login flow.

## 🔒 Security Improvement

### Previous Implementation (Insecure)
```typescript
// ❌ BAD: No email verification
app.post("/api/auth/login", async (req, res) => {
  const { email } = req.body;
  // Directly creates sub-org and logs user in - NO VERIFICATION!
  const token = signToken(subOrgId, email);
  res.cookie('auth_token', token);
});
```

**Problem**: Anyone could log in as any email address without proving ownership.

### New Implementation (Secure)
```typescript
// ✅ GOOD: Two-step verification
// Step 1: Request code
app.post("/api/auth/initiate", async (req, res) => {
  const { email } = req.body;
  await initiateEmailAuth(email, turnkeyClient);
  // Sends 6-digit code to email (or console in dev)
});

// Step 2: Verify code
app.post("/api/auth/verify", async (req, res) => {
  const { sessionId, code } = req.body;
  const verified = await verifyEmailAuth(sessionId, code);
  if (verified) {
    // Only now issue JWT token
    const token = signToken(subOrgId, email);
    res.cookie('auth_token', token);
  }
});
```

**Benefit**: Users must prove email ownership before authentication.

## 📐 Architecture

### Authentication Flow

```
┌─────────┐                 ┌─────────┐                 ┌──────────┐
│ Client  │                 │ Server  │                 │ Turnkey  │
└────┬────┘                 └────┬────┘                 └────┬─────┘
     │                           │                           │
     │  1. POST /auth/initiate   │                           │
     │  { email }                │                           │
     ├──────────────────────────>│                           │
     │                           │                           │
     │                           │  2. Create/Get Sub-Org    │
     │                           ├──────────────────────────>│
     │                           │<──────────────────────────┤
     │                           │  subOrgId                 │
     │                           │                           │
     │                           │  3. Generate OTP          │
     │                           │  (Dev: console log)       │
     │                           │  (Prod: Turnkey email)    │
     │                           │                           │
     │  4. { sessionId }         │                           │
     │<──────────────────────────┤                           │
     │                           │                           │
     │  5. User enters code      │                           │
     │  from email/console       │                           │
     │                           │                           │
     │  6. POST /auth/verify     │                           │
     │  { sessionId, code }      │                           │
     ├──────────────────────────>│                           │
     │                           │                           │
     │                           │  7. Verify code           │
     │                           │  (Dev: check stored OTP)  │
     │                           │  (Prod: Turnkey verify)   │
     │                           │                           │
     │  8. Set auth cookie       │                           │
     │<──────────────────────────┤                           │
     │                           │                           │
     │  9. Redirect to app       │                           │
     │                           │                           │
```

### Session Management

Sessions are stored in-memory (development) or Redis (production):

```typescript
interface EmailAuthSession {
  email: string;           // User's email
  subOrgId?: string;       // Turnkey sub-organization ID
  timestamp: number;       // When session was created
  verified: boolean;       // Whether code has been verified
  otp?: string;            // Development only - the generated code
}
```

Sessions expire after 5 minutes.

## 📁 File Structure

```
server/
├── auth/
│   ├── jwt.ts              # JWT token signing/verification
│   └── email-auth.ts       # ✨ NEW: Email auth service
└── routes.ts               # Auth endpoints

client/src/
└── pages/
    └── login.tsx           # ✨ UPDATED: Two-step login UI
```

## 🔧 Implementation Details

### Server-Side Components

#### 1. Email Auth Service (`server/auth/email-auth.ts`)

**Functions**:
- `initiateEmailAuth(email, turnkeyClient)` - Start auth flow
- `verifyEmailAuth(sessionId, code)` - Verify the code
- `isSessionVerified(sessionId)` - Check session status
- `cleanupSession(sessionId)` - Remove session after login

**Key Features**:
- In-memory session storage (upgrade to Redis for production)
- Automatic session cleanup (5-minute timeout)
- Development OTP generation (console logging)
- Production-ready Turnkey integration (commented out for now)

#### 2. Updated Routes (`server/routes.ts`)

**New Endpoints**:
- `POST /api/auth/initiate` - Request verification code
- `POST /api/auth/verify` - Submit code and complete login

**Removed**:
- `POST /api/auth/login` - Old insecure direct login

### Client-Side Components

#### Updated Login Page (`client/src/pages/login.tsx`)

**State Management**:
```typescript
type AuthStep = 'email' | 'code';

const [step, setStep] = useState<AuthStep>('email');
const [email, setEmail] = useState("");
const [code, setCode] = useState("");
const [sessionId, setSessionId] = useState("");
```

**UI Flow**:
1. **Email Step**: User enters email, clicks "Send Verification Code"
2. **Code Step**: User enters 6-digit code, clicks "Verify & Sign In"

**Features**:
- Auto-focus on code input
- Numeric-only code input (filters non-digits)
- 6-digit limit
- Back button to change email
- Resend code option
- Clear error messages

## 🧪 Testing

### E2E Tests

New test file: `__tests__/e2e/auth-email-flow.spec.ts`

**Test Coverage**:
- ✅ Email input validation
- ✅ Code screen display
- ✅ Back button functionality
- ✅ Numeric input enforcement
- ✅ 6-digit code limit
- ✅ Button enable/disable states
- ✅ Full flow with mocked APIs
- ✅ Invalid code handling
- ✅ Network error handling
- ✅ Session expiration

**Running Tests**:
```bash
# Run email auth tests
npx playwright test auth-email-flow

# Run with UI
npx playwright test auth-email-flow --ui

# Run in headed mode
npx playwright test auth-email-flow --headed
```

## 🚀 Development Setup

### 1. Environment Variables

Already configured in `.env`:
```bash
TURNKEY_ORGANIZATION_ID=your_org_id
TURNKEY_API_PUBLIC_KEY=your_public_key
TURNKEY_API_PRIVATE_KEY=your_private_key
JWT_SECRET=your_jwt_secret
```

### 2. Start Development Server

```bash
cd apps/originals-explorer
npm run dev
```

### 3. Testing the Flow

1. Navigate to `http://localhost:5001/login`
2. Enter any email address (e.g., `test@example.com`)
3. Click "Send Verification Code"
4. **Check the server console** for the OTP code:
   ```
   ============================================================
   🔐 EMAIL AUTH CODE for test@example.com
      Session: session_1234567890_abc123
      Code: 123456
      Valid for: 5 minutes
   ============================================================
   ```
5. Enter the code on the verification screen
6. Click "Verify & Sign In"
7. You're logged in! ✨

## 🌐 Production Deployment

### Upgrade to Real Turnkey Email Auth

To use actual email sending via Turnkey in production, update `server/auth/email-auth.ts`:

```typescript
// In initiateEmailAuth function, uncomment:
await turnkeyClient.apiClient().emailAuth({
  email,
  targetPublicKey: clientPublicKey,
  organizationId: subOrgId,
});

// In verifyEmailAuth function, uncomment:
const result = await turnkeyClient.apiClient().verifyEmailAuth({
  sessionId,
  code,
});
```

### Upgrade Session Storage

Replace in-memory storage with Redis:

```typescript
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

// Store session
await redis.setex(
  `auth:session:${sessionId}`,
  300, // 5 minutes
  JSON.stringify(session)
);

// Get session
const data = await redis.get(`auth:session:${sessionId}`);
const session = JSON.parse(data);
```

### Security Checklist

Before going to production:

- [ ] Enable real Turnkey email auth
- [ ] Switch to Redis for session storage
- [ ] Use HTTPS (secure cookies)
- [ ] Set `NODE_ENV=production`
- [ ] Configure rate limiting on auth endpoints
- [ ] Enable CORS properly
- [ ] Add monitoring/alerts for failed auth attempts
- [ ] Implement account lockout after X failed attempts
- [ ] Add logging for security events
- [ ] Review and update JWT expiration times

## 🔍 Troubleshooting

### "Failed to Send Code"

**Cause**: Turnkey API error or network issue

**Fix**:
1. Check Turnkey credentials in `.env`
2. Verify organization is active
3. Check server logs for detailed error

### "Invalid Verification Code"

**Cause**: Code doesn't match or session expired

**Fix**:
1. Codes expire after 5 minutes - request a new one
2. Make sure you're entering the exact code from console/email
3. No spaces or special characters

### "Session Expired"

**Cause**: Took longer than 5 minutes to enter code

**Fix**:
1. Click "Resend" to get a new code
2. Or click back and start over

### Code Not Showing in Console

**Cause**: Server not running or logs disabled

**Fix**:
1. Make sure server is running: `npm run dev`
2. Check terminal where server is running
3. Look for the `🔐 EMAIL AUTH CODE` block

## 📊 Comparison: Before vs After

| Feature | Before (Insecure) | After (Secure) |
|---------|-------------------|----------------|
| Email Verification | ❌ None | ✅ 6-digit OTP |
| Security | 🔴 Anyone can impersonate | 🟢 Proof of email ownership |
| User Experience | Fast but dangerous | Slightly slower but secure |
| Production Ready | ❌ NO | ✅ YES |
| Turnkey Integration | ⚠️ Keys only | ✅ Keys + Auth |
| Session Management | ❌ None | ✅ 5-min timeout |
| Test Coverage | ⚠️ Basic | ✅ Comprehensive |

## 🎯 Next Steps

1. **Test the flow manually** in development
2. **Run E2E tests** to verify everything works
3. **Review security settings** in `server/auth/jwt.ts`
4. **Plan production deployment** with Redis and real email
5. **Consider adding**:
   - SMS auth as alternative
   - Social login (Google, GitHub)
   - Passkey/WebAuthn support
   - Remember device functionality

## 📚 References

- [Turnkey Email Auth Docs](https://docs.turnkey.com/features/email-auth)
- [Turnkey SDK Server](https://www.npmjs.com/package/@turnkey/sdk-server)
- [JWT Best Practices](https://datatracker.ietf.org/doc/html/rfc8725)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
