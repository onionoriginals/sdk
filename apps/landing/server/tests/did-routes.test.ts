import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import crypto from 'node:crypto';
import { createInMemorySessionStorage, signToken } from '@originals/auth/server';
import { encoding } from '@originals/sdk';
import { createDidRoutes } from '../did-routes';

const JWT_SECRET = 'test-secret';

// Generate a real Ed25519 keypair and expose:
//  - solanaAddress: base58btc of the raw 32-byte public key (Turnkey's
//    ADDRESS_FORMAT_SOLANA), which getEd25519Account turns into the
//    publicKeyMultibase / updateKey the signer's key must match.
//  - a Turnkey-shaped mock whose signRawPayload produces a genuine signature
//    over the exact payload bytes, so didwebvh-ts's post-sign verification
//    (via TurnkeyWebVHSigner.verify → @noble/ed25519) passes. Ported from
//    packages/auth/tests/turnkey-did-creation.integration.test.ts.
function makeRealTurnkeyMock() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  // Strip the 'z' multibase code to get a bare base58btc Solana address.
  const solanaAddress = encoding.multibase.encode(new Uint8Array(rawPub), 'base58btc').slice(1);

  const apiClient = () => ({
    getWallets: async (_a: { organizationId: string }) => ({
      wallets: [{ walletId: 'wallet-0' }],
    }),
    getWalletAccounts: async (_a: { organizationId: string; walletId: string }) => ({
      accounts: [{ curve: 'CURVE_ED25519', address: solanaAddress, organizationId: 'acct-org' }],
    }),
    signRawPayload: async (request: { payload: string; [k: string]: unknown }) => {
      const hex = request.payload.startsWith('0x') ? request.payload.slice(2) : request.payload;
      const sig = crypto.sign(null, Buffer.from(hex, 'hex'), privateKey);
      const r = sig.subarray(0, 32).toString('hex');
      const s = sig.subarray(32, 64).toString('hex');
      return { activity: { result: { signRawPayloadResult: { r, s } } } };
    },
  });

  return { turnkey: { apiClient } as any };
}

describe('did-routes happy path', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('createDid returns a did:webvh for an authenticated user (real-ed25519 signing mock)', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.WEBVH_DOMAIN = 'magby.originals.build';

    const subOrgId = 'sub-org-abcdef0123456789';
    const { turnkey } = makeRealTurnkeyMock();

    const { createDid } = createDidRoutes({
      turnkey,
      sessions: createInMemorySessionStorage(),
      jwtSecret: JWT_SECRET,
    });

    const token = signToken(subOrgId, 'alice@example.com', undefined, { secret: JWT_SECRET });
    const res = await createDid(
      new Request('http://x/api/did/create', {
        method: 'POST',
        headers: { Cookie: `auth_token=${token}` },
      }),
      new URL('http://x/api/did/create')
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { did?: string };
    expect(body.did).toBeDefined();
    expect(body.did!.startsWith('did:webvh:')).toBe(true);
  });
});

describe('did-routes auth gate', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.WEBVH_DOMAIN = 'magby.originals.build';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('rejects unauthenticated requests', async () => {
    const { createDid } = createDidRoutes({
      turnkey: { apiClient: () => ({}) } as any,
      sessions: createInMemorySessionStorage(),
      jwtSecret: JWT_SECRET,
    });
    const res = await createDid(
      new Request('http://x/api/did/create', { method: 'POST' }),
      new URL('http://x/api/did/create')
    );
    expect(res.status).toBe(401);
  });
});
