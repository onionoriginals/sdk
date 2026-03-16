import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  TurnkeySessionExpiredError,
  withTokenExpiration,
  initializeTurnkeyClient,
  initOtp,
  completeOtp,
  fetchUser,
  fetchWallets,
  getKeyByCurve,
} from '../src/client/turnkey-client';
import type { TurnkeyWallet } from '../src/types';

describe('client/turnkey-client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.TURNKEY_API_PUBLIC_KEY;
    delete process.env.TURNKEY_API_PRIVATE_KEY;
    delete process.env.TURNKEY_ORGANIZATION_ID;
  });

  afterEach(() => {
    process.env.TURNKEY_API_PUBLIC_KEY = originalEnv.TURNKEY_API_PUBLIC_KEY;
    process.env.TURNKEY_API_PRIVATE_KEY = originalEnv.TURNKEY_API_PRIVATE_KEY;
    process.env.TURNKEY_ORGANIZATION_ID = originalEnv.TURNKEY_ORGANIZATION_ID;
  });

  describe('TurnkeySessionExpiredError', () => {
    test('has correct name and default message', () => {
      const error = new TurnkeySessionExpiredError();
      expect(error.name).toBe('TurnkeySessionExpiredError');
      expect(error.message).toContain('session has expired');
    });

    test('accepts custom message', () => {
      const error = new TurnkeySessionExpiredError('Custom message');
      expect(error.message).toBe('Custom message');
    });

    test('is instanceof Error', () => {
      const error = new TurnkeySessionExpiredError();
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('withTokenExpiration', () => {
    test('returns result on success', async () => {
      const result = await withTokenExpiration(() => Promise.resolve('hello'));
      expect(result).toBe('hello');
    });

    test('rethrows non-expiration errors', async () => {
      await expect(
        withTokenExpiration(() => Promise.reject(new Error('network error')))
      ).rejects.toThrow('network error');
    });

    test('throws TurnkeySessionExpiredError for api_key_expired', async () => {
      const expiredError = { code: 'api_key_expired' };
      await expect(
        withTokenExpiration(() => Promise.reject(expiredError))
      ).rejects.toBeInstanceOf(TurnkeySessionExpiredError);
    });

    test('throws TurnkeySessionExpiredError for expired api key message', async () => {
      const expiredError = { message: 'Expired API Key detected' };
      await expect(
        withTokenExpiration(() => Promise.reject(expiredError))
      ).rejects.toBeInstanceOf(TurnkeySessionExpiredError);
    });

    test('throws TurnkeySessionExpiredError for code 16', async () => {
      const expiredError = { code: 16, message: 'unauthenticated' };
      await expect(
        withTokenExpiration(() => Promise.reject(expiredError))
      ).rejects.toBeInstanceOf(TurnkeySessionExpiredError);
    });

    test('calls onExpired callback for expired keys', async () => {
      const onExpired = mock(() => {});
      const expiredError = { code: 'api_key_expired' };

      await expect(
        withTokenExpiration(() => Promise.reject(expiredError), onExpired)
      ).rejects.toBeInstanceOf(TurnkeySessionExpiredError);

      expect(onExpired).toHaveBeenCalled();
    });

    test('does not call onExpired for non-expiration errors', async () => {
      const onExpired = mock(() => {});
      await expect(
        withTokenExpiration(() => Promise.reject(new Error('other')), onExpired)
      ).rejects.toThrow('other');
      expect(onExpired).not.toHaveBeenCalled();
    });
  });

  describe('initializeTurnkeyClient', () => {
    test('creates client with explicit config', () => {
      const client = initializeTurnkeyClient({
        apiPublicKey: 'pub',
        apiPrivateKey: 'priv',
        organizationId: 'org',
      });
      expect(client).toBeDefined();
    });

    test('uses env vars as fallback', () => {
      process.env.TURNKEY_API_PUBLIC_KEY = 'env_pub';
      process.env.TURNKEY_API_PRIVATE_KEY = 'env_priv';
      process.env.TURNKEY_ORGANIZATION_ID = 'env_org';
      const client = initializeTurnkeyClient();
      expect(client).toBeDefined();
    });

    test('throws when public key missing', () => {
      expect(() => initializeTurnkeyClient({ apiPrivateKey: 'p', organizationId: 'o' })).toThrow(
        'TURNKEY_API_PUBLIC_KEY is required'
      );
    });

    test('throws when private key missing', () => {
      expect(() => initializeTurnkeyClient({ apiPublicKey: 'p', organizationId: 'o' })).toThrow(
        'TURNKEY_API_PRIVATE_KEY is required'
      );
    });

    test('throws when organization ID missing', () => {
      expect(() => initializeTurnkeyClient({ apiPublicKey: 'p', apiPrivateKey: 'k' })).toThrow(
        'TURNKEY_ORGANIZATION_ID is required'
      );
    });
  });

  describe('initOtp', () => {
    function createMockClient(initOtpFn?: () => Promise<unknown>) {
      return {
        apiClient: () => ({
          initOtp: initOtpFn ?? mock(() => Promise.resolve({ otpId: 'otp_abc' })),
        }),
      } as unknown as import('@turnkey/sdk-server').Turnkey;
    }

    test('returns OTP ID on success', async () => {
      const client = createMockClient();
      const result = await initOtp(client, 'user@example.com');
      expect(result).toBe('otp_abc');
    });

    test('passes subOrgId when provided', async () => {
      const initOtpFn = mock(() => Promise.resolve({ otpId: 'otp_123' }));
      const client = createMockClient(initOtpFn);
      await initOtp(client, 'user@example.com', 'sub_org_456');

      expect(initOtpFn).toHaveBeenCalledWith(
        expect.objectContaining({
          otpType: 'OTP_TYPE_EMAIL',
          contact: 'user@example.com',
          organizationId: 'sub_org_456',
        })
      );
    });

    test('throws when no OTP ID returned', async () => {
      const client = createMockClient(mock(() => Promise.resolve({ otpId: null })));
      await expect(initOtp(client, 'user@example.com')).rejects.toThrow('Failed to send OTP');
    });

    test('throws on API error', async () => {
      const client = createMockClient(mock(() => Promise.reject(new Error('API down'))));
      await expect(initOtp(client, 'user@example.com')).rejects.toThrow('Failed to send OTP');
    });
  });

  describe('completeOtp', () => {
    function createMockClient(verifyOtpFn?: () => Promise<unknown>) {
      return {
        apiClient: () => ({
          verifyOtp:
            verifyOtpFn ??
            mock(() => Promise.resolve({ verificationToken: 'vtoken_123' })),
        }),
      } as unknown as import('@turnkey/sdk-server').Turnkey;
    }

    test('returns verification token and subOrgId', async () => {
      const client = createMockClient();
      const result = await completeOtp(client, 'otp_123', '654321', 'sub_org_abc');
      expect(result.verificationToken).toBe('vtoken_123');
      expect(result.subOrgId).toBe('sub_org_abc');
    });

    test('passes correct parameters to verifyOtp', async () => {
      const verifyOtpFn = mock(() => Promise.resolve({ verificationToken: 'tok' }));
      const client = createMockClient(verifyOtpFn);
      await completeOtp(client, 'otp_id_1', '111222', 'sub_org_1');

      expect(verifyOtpFn).toHaveBeenCalledWith(
        expect.objectContaining({
          otpId: 'otp_id_1',
          otpCode: '111222',
          expirationSeconds: '900',
          organizationId: 'sub_org_1',
        })
      );
    });

    test('throws when no verification token returned', async () => {
      const client = createMockClient(
        mock(() => Promise.resolve({ verificationToken: null }))
      );
      await expect(completeOtp(client, 'otp_1', '123456', 'sub_1')).rejects.toThrow(
        'Failed to complete OTP'
      );
    });

    test('throws on API error', async () => {
      const client = createMockClient(
        mock(() => Promise.reject(new Error('Verification failed')))
      );
      await expect(completeOtp(client, 'otp_1', '123456', 'sub_1')).rejects.toThrow(
        'Failed to complete OTP'
      );
    });
  });

  describe('fetchUser', () => {
    function createMockClient(getUsersFn?: () => Promise<unknown>) {
      return {
        apiClient: () => ({
          getUsers:
            getUsersFn ??
            mock(() =>
              Promise.resolve({
                users: [{ userId: 'u1', userName: 'Alice' }],
              })
            ),
        }),
      } as unknown as import('@turnkey/sdk-server').Turnkey;
    }

    test('returns first user', async () => {
      const client = createMockClient();
      const result = await fetchUser(client, 'sub_org_123');
      expect(result).toEqual({ userId: 'u1', userName: 'Alice' });
    });

    test('returns null when no users', async () => {
      const client = createMockClient(mock(() => Promise.resolve({ users: [] })));
      const result = await fetchUser(client, 'sub_org_123');
      expect(result).toBeNull();
    });

    test('returns null when users undefined', async () => {
      const client = createMockClient(mock(() => Promise.resolve({})));
      const result = await fetchUser(client, 'sub_org_123');
      expect(result).toBeNull();
    });

    test('throws on API error', async () => {
      const client = createMockClient(mock(() => Promise.reject(new Error('Network'))));
      await expect(fetchUser(client, 'sub_org_123')).rejects.toThrow('Failed to fetch user');
    });
  });

  describe('fetchWallets', () => {
    function createMockClient(
      getWalletsFn?: () => Promise<unknown>,
      getWalletAccountsFn?: () => Promise<unknown>
    ) {
      return {
        apiClient: () => ({
          getWallets:
            getWalletsFn ??
            mock(() =>
              Promise.resolve({
                wallets: [{ walletId: 'w1', walletName: 'default-wallet' }],
              })
            ),
          getWalletAccounts:
            getWalletAccountsFn ??
            mock(() =>
              Promise.resolve({
                accounts: [
                  {
                    address: 'addr1',
                    curve: 'CURVE_SECP256K1',
                    path: "m/44'/0'/0'/0/0",
                    addressFormat: 'ADDRESS_FORMAT_ETHEREUM',
                  },
                  {
                    address: 'addr2',
                    curve: 'CURVE_ED25519',
                    path: "m/44'/501'/0'/0'",
                    addressFormat: 'ADDRESS_FORMAT_SOLANA',
                  },
                ],
              })
            ),
        }),
      } as unknown as import('@turnkey/sdk-server').Turnkey;
    }

    test('returns wallets with accounts', async () => {
      const client = createMockClient();
      const wallets = await fetchWallets(client, 'sub_org_1');

      expect(wallets).toHaveLength(1);
      expect(wallets[0].walletId).toBe('w1');
      expect(wallets[0].walletName).toBe('default-wallet');
      expect(wallets[0].accounts).toHaveLength(2);
      expect(wallets[0].accounts[0].curve).toBe('CURVE_SECP256K1');
      expect(wallets[0].accounts[1].curve).toBe('CURVE_ED25519');
    });

    test('returns empty array when no wallets', async () => {
      const client = createMockClient(
        mock(() => Promise.resolve({ wallets: [] }))
      );
      const wallets = await fetchWallets(client, 'sub_org_1');
      expect(wallets).toHaveLength(0);
    });

    test('handles undefined wallets', async () => {
      const client = createMockClient(mock(() => Promise.resolve({})));
      const wallets = await fetchWallets(client, 'sub_org_1');
      expect(wallets).toHaveLength(0);
    });

    test('throws on API error', async () => {
      const client = createMockClient(
        mock(() => Promise.reject(new Error('Network')))
      );
      await expect(fetchWallets(client, 'sub_org_1')).rejects.toThrow('Failed to fetch wallets');
    });
  });

  describe('getKeyByCurve', () => {
    const wallets: TurnkeyWallet[] = [
      {
        walletId: 'w1',
        walletName: 'default',
        accounts: [
          {
            address: 'addr_secp',
            curve: 'CURVE_SECP256K1',
            path: "m/44'/0'/0'/0/0",
            addressFormat: 'ADDRESS_FORMAT_ETHEREUM',
          },
          {
            address: 'addr_ed1',
            curve: 'CURVE_ED25519',
            path: "m/44'/501'/0'/0'",
            addressFormat: 'ADDRESS_FORMAT_SOLANA',
          },
        ],
      },
    ];

    test('finds Secp256k1 key', () => {
      const key = getKeyByCurve(wallets, 'CURVE_SECP256K1');
      expect(key).toBeDefined();
      expect(key!.address).toBe('addr_secp');
    });

    test('finds Ed25519 key', () => {
      const key = getKeyByCurve(wallets, 'CURVE_ED25519');
      expect(key).toBeDefined();
      expect(key!.address).toBe('addr_ed1');
    });

    test('returns null when curve not found', () => {
      const emptyWallets: TurnkeyWallet[] = [
        { walletId: 'w1', walletName: 'empty', accounts: [] },
      ];
      const key = getKeyByCurve(emptyWallets, 'CURVE_SECP256K1');
      expect(key).toBeNull();
    });

    test('returns null for empty wallets array', () => {
      const key = getKeyByCurve([], 'CURVE_ED25519');
      expect(key).toBeNull();
    });

    test('searches across multiple wallets', () => {
      const multiWallets: TurnkeyWallet[] = [
        { walletId: 'w1', walletName: 'first', accounts: [] },
        {
          walletId: 'w2',
          walletName: 'second',
          accounts: [
            {
              address: 'found',
              curve: 'CURVE_ED25519',
              path: "m/44'/501'/0'/0'",
              addressFormat: 'ADDRESS_FORMAT_SOLANA',
            },
          ],
        },
      ];
      const key = getKeyByCurve(multiWallets, 'CURVE_ED25519');
      expect(key!.address).toBe('found');
    });
  });
});
