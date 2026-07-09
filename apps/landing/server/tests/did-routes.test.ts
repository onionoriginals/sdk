import { describe, test, expect } from 'bun:test';
import { createInMemorySessionStorage } from '@originals/auth/server';
import { createDidRoutes } from '../did-routes';

const JWT_SECRET = 'test-secret';

// A Turnkey mock that returns a wallet with a real ed25519 (Solana) account and
// signs payloads with a real ed25519 key so didwebvh-ts's post-sign verification
// passes. Reuse the pattern from packages/auth/tests/turnkey-did-creation.integration.test.ts.
// (Implementer: import @noble/ed25519, generate a keypair, expose signRawPayload
// returning { activity: { result: { signRawPayloadResult: { r, s } } } }.)

test.todo('createDid returns a did:webvh for an authenticated user (real-ed25519 signing mock)');

describe('did-routes auth gate', () => {
  test('rejects unauthenticated requests', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.WEBVH_DOMAIN = 'magby.originals.build';
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
