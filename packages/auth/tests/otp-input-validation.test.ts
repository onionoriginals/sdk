import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { generateP256KeyPair } from '@turnkey/crypto';
import { StructuredError } from '@originals/sdk';
import type { Turnkey } from '@turnkey/sdk-server';
import { createInMemorySessionStorage, verifyEmailAuth } from '../src/server/email-auth';
import { encryptOtpCode } from '../src/otp-encryption';
import { createOtpTargetBundle, decryptOtpBundle } from './helpers/otp-test-utils';

const fixture = createOtpTargetBundle();
const keyPair = generateP256KeyPair();
const options = { dangerouslyOverrideSignerPublicKey: fixture.signerPublicKey };
const invalidCodes: unknown[] = [123456, 123456n, ['123456'], { toString: () => '123456' }, new String('123456'), null, undefined, true, Symbol('code'), '', '12345', '1234567', '12345a', '１２３４５６', '123456\n'];
const invalidKeys: unknown[] = [null, false, 123456, [], {}, new String(keyPair.publicKey), '', 'not-a-key', `0x${keyPair.publicKey}`, ` ${keyPair.publicKey}`, keyPair.publicKey.slice(0, -1), '05' + keyPair.publicKey.slice(2), '02' + 'gg'.repeat(32), '02' + 'ff'.repeat(32), '04' + '00'.repeat(64), keyPair.publicKeyUncompressed + '00'];
const cases = [
  ...invalidCodes.map((code, index) => ({ name: `code ${index}`, code, publicKey: keyPair.publicKey as unknown, errorCode: 'AUTH_OTP_CODE_FORMAT_INVALID' })),
  ...invalidKeys.map((publicKey, index) => ({ name: `key ${index}`, code: '123456' as unknown, publicKey, errorCode: 'AUTH_OTP_PUBLIC_KEY_INVALID' })),
];

function setup() {
  const storage = createInMemorySessionStorage();
  storage.set('session', { email: 'user@example.com', timestamp: Date.now(), verified: false, otpId: 'otp', otpEncryptionTargetBundle: fixture.otpEncryptionTargetBundle });
  const claim = mock(storage.claimForVerification);
  storage.claimForVerification = claim;
  const verifyOtp = mock(async () => ({ verificationToken: 'token' }));
  const apiClient = mock(() => ({ verifyOtp, getSubOrgIds: async () => ({ organizationIds: ['suborg'] }), getWallets: async () => ({ wallets: [{}] }) }));
  return { storage, claim, verifyOtp, apiClient, client: { apiClient } as unknown as Turnkey };
}

describe('OTP input validation (#891)', () => {
  let originalOrgId: string | undefined;
  beforeEach(() => {
    originalOrgId = process.env.TURNKEY_ORGANIZATION_ID;
    process.env.TURNKEY_ORGANIZATION_ID = 'org_test';
  });
  afterEach(() => {
    if (originalOrgId === undefined) delete process.env.TURNKEY_ORGANIZATION_ID;
    else process.env.TURNKEY_ORGANIZATION_ID = originalOrgId;
  });
  for (const entry of cases) {
    test(`rejects malformed ${entry.name} before claiming or calling Turnkey`, async () => {
      const { storage, claim, apiClient, client } = setup();
      const before = structuredClone(await storage.get('session'));
      const error = await verifyEmailAuth('session', entry.code as string, client, storage, { ...options, publicKey: entry.publicKey as string }).catch(error => error);
      expect(error).toBeInstanceOf(StructuredError);
      expect(error.code).toBe(entry.errorCode);
      expect(claim).not.toHaveBeenCalled();
      expect(apiClient).not.toHaveBeenCalled();
      expect(await storage.get('session')).toEqual(before);
    });

    test(`encryption helper rejects malformed ${entry.name}`, async () => {
      const error = await encryptOtpCode({ otpCode: entry.code as string, publicKey: entry.publicKey as string, otpEncryptionTargetBundle: fixture.otpEncryptionTargetBundle, ...options }).catch(error => error);
      expect(error).toBeInstanceOf(StructuredError);
      expect(error.code).toBe(entry.errorCode);
    });
  }

  for (const publicKey of [keyPair.publicKey, keyPair.publicKeyUncompressed, keyPair.publicKey.toUpperCase(), keyPair.publicKeyUncompressed.toUpperCase(), undefined]) {
    test(`preserves valid key encoding ${publicKey?.length ?? 'omitted'} and leading-zero OTP`, async () => {
      const { storage, client, verifyOtp } = setup();
      const result = await verifyEmailAuth('session', '000123', client, storage, { ...options, publicKey });
      expect(result.verified).toBe(true);
      if (publicKey === undefined) expect(result.privateKey).toMatch(/^[0-9a-f]{64}$/);
      else {
        expect(result.publicKey).toBe(publicKey);
        expect(result.privateKey).toBeUndefined();
      }
      const request = verifyOtp.mock.calls[0] as unknown as [{ encryptedOtpBundle: string }];
      expect(decryptOtpBundle(request[0].encryptedOtpBundle, fixture.targetPrivateKey)).toEqual({ otp_code: '000123', public_key: result.publicKey });
    });
  }

  test('invalid inputs leave the last attempt usable after four genuinely wrong codes', async () => {
    const { storage, client, claim, verifyOtp } = setup();
    verifyOtp.mockImplementation(async () => { throw Object.assign(new Error('Invalid OTP'), { code: 3 }); });
    for (let i = 0; i < 4; i++) {
      await expect(verifyEmailAuth('session', '111111', client, storage, options)).rejects.toMatchObject({ code: 'AUTH_OTP_CODE_INCORRECT' });
    }
    expect((await storage.get('session'))?.otpAttempts).toBe(4);
    for (const entry of cases) {
      await expect(verifyEmailAuth('session', entry.code as string, client, storage, { ...options, publicKey: entry.publicKey as string })).rejects.toMatchObject({ code: entry.errorCode });
    }
    expect(claim).toHaveBeenCalledTimes(4);
    expect(verifyOtp).toHaveBeenCalledTimes(4);
    expect((await storage.get('session'))?.otpAttempts).toBe(4);
    expect((await storage.get('session'))?.verifying).toBe(false);
    verifyOtp.mockImplementation(async () => ({ verificationToken: 'token' }));
    expect((await verifyEmailAuth('session', '000123', client, storage, options)).verified).toBe(true);
  });
});
