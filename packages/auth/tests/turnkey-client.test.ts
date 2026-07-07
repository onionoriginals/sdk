import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  createTurnkeyClient,
  getOrCreateTurnkeySubOrg,
  normalizeEmail,
} from '../src/server/turnkey-client';

describe('turnkey-client', () => {
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

  describe('createTurnkeyClient', () => {
    test('creates client with explicit config', () => {
      const client = createTurnkeyClient({
        apiPublicKey: 'pub_key_123',
        apiPrivateKey: 'priv_key_456',
        organizationId: 'org_789',
      });
      expect(client).toBeDefined();
    });

    test('uses env vars when config not provided', () => {
      process.env.TURNKEY_API_PUBLIC_KEY = 'env_pub';
      process.env.TURNKEY_API_PRIVATE_KEY = 'env_priv';
      process.env.TURNKEY_ORGANIZATION_ID = 'env_org';

      const client = createTurnkeyClient();
      expect(client).toBeDefined();
    });

    test('throws when public key missing', () => {
      expect(() =>
        createTurnkeyClient({
          apiPrivateKey: 'priv_key',
          organizationId: 'org_id',
        })
      ).toThrow('TURNKEY_API_PUBLIC_KEY is required');
    });

    test('throws when private key missing', () => {
      expect(() =>
        createTurnkeyClient({
          apiPublicKey: 'pub_key',
          organizationId: 'org_id',
        })
      ).toThrow('TURNKEY_API_PRIVATE_KEY is required');
    });

    test('throws when organization ID missing', () => {
      expect(() =>
        createTurnkeyClient({
          apiPublicKey: 'pub_key',
          apiPrivateKey: 'priv_key',
        })
      ).toThrow('TURNKEY_ORGANIZATION_ID is required');
    });

    test('uses default API base URL', () => {
      const client = createTurnkeyClient({
        apiPublicKey: 'pub_key',
        apiPrivateKey: 'priv_key',
        organizationId: 'org_id',
      });
      expect(client).toBeDefined();
    });

    test('uses custom API base URL', () => {
      const client = createTurnkeyClient({
        apiBaseUrl: 'https://custom.api.com',
        apiPublicKey: 'pub_key',
        apiPrivateKey: 'priv_key',
        organizationId: 'org_id',
      });
      expect(client).toBeDefined();
    });
  });

  describe('normalizeEmail', () => {
    test('trims whitespace and lowercases', () => {
      expect(normalizeEmail('  Alice@Example.COM  ')).toBe('alice@example.com');
    });

    test('leaves already-normalized emails unchanged', () => {
      expect(normalizeEmail('user+tag.name@example.org')).toBe('user+tag.name@example.org');
    });
  });

  describe('getOrCreateTurnkeySubOrg', () => {
    function createMockClient(overrides?: {
      getSubOrgIds?: () => Promise<unknown>;
      getWallets?: () => Promise<unknown>;
      createWallet?: () => Promise<unknown>;
      createSubOrganization?: () => Promise<unknown>;
    }) {
      const getSubOrgIds =
        overrides?.getSubOrgIds ??
        mock(() => Promise.resolve({ organizationIds: ['existing_sub_org'] }));
      const getWallets =
        overrides?.getWallets ??
        mock(() => Promise.resolve({ wallets: [{ walletId: 'w1' }] }));
      const createWallet =
        overrides?.createWallet ?? mock(() => Promise.resolve({ walletId: 'w_new' }));
      const createSubOrganization =
        overrides?.createSubOrganization ??
        mock(() =>
          Promise.resolve({
            activity: {
              result: {
                createSubOrganizationResultV7: { subOrganizationId: 'new_sub_org' },
              },
            },
          })
        );

      return {
        apiClient: () => ({
          getSubOrgIds,
          getWallets,
          createWallet,
          createSubOrganization,
        }),
      } as unknown as import('@turnkey/sdk-server').Turnkey;
    }

    beforeEach(() => {
      process.env.TURNKEY_ORGANIZATION_ID = 'parent_org_123';
    });

    test('returns existing sub-org when found with wallet', async () => {
      const client = createMockClient();
      const result = await getOrCreateTurnkeySubOrg('user@example.com', client);
      expect(result).toBe('existing_sub_org');
    });

    test('creates new sub-org when none exists', async () => {
      const createSubOrganization = mock(() =>
        Promise.resolve({
          activity: {
            result: {
              createSubOrganizationResultV7: { subOrganizationId: 'brand_new_org' },
            },
          },
        })
      );
      const client = createMockClient({
        getSubOrgIds: mock(() => Promise.resolve({ organizationIds: [] })),
        createSubOrganization,
      });

      const result = await getOrCreateTurnkeySubOrg('new@example.com', client);
      expect(result).toBe('brand_new_org');
      expect(createSubOrganization).toHaveBeenCalled();
    });

    test('repairs walletless sub-org in place instead of minting a new identity', async () => {
      // The sub-org ID is the user's stable identity; a missing wallet must
      // be fixed by creating the wallet under the EXISTING sub-org.
      const createWallet = mock(() => Promise.resolve({ walletId: 'w_repaired' }));
      const createSubOrganization = mock(() =>
        Promise.resolve({
          activity: {
            result: {
              createSubOrganizationResultV7: { subOrganizationId: 'rebuilt_org' },
            },
          },
        })
      );
      const client = createMockClient({
        getSubOrgIds: mock(() =>
          Promise.resolve({ organizationIds: ['existing_no_wallet'] })
        ),
        getWallets: mock(() => Promise.resolve({ wallets: [] })),
        createWallet,
        createSubOrganization,
      });

      const result = await getOrCreateTurnkeySubOrg('user@example.com', client);
      expect(result).toBe('existing_no_wallet');
      expect(createSubOrganization).not.toHaveBeenCalled();
      expect(createWallet).toHaveBeenCalledTimes(1);

      // Wallet is created under the existing sub-org with the same account
      // layout the creation path uses.
      const callArgs = (createWallet as any).mock.calls[0][0];
      expect(callArgs.organizationId).toBe('existing_no_wallet');
      expect(callArgs.walletName).toBe('default-wallet');
      expect(callArgs.accounts).toHaveLength(3);
      expect(callArgs.accounts[0].curve).toBe('CURVE_SECP256K1');
      expect(callArgs.accounts[1].curve).toBe('CURVE_ED25519');
      expect(callArgs.accounts[2].curve).toBe('CURVE_ED25519');
    });

    test('propagates wallet-repair failure instead of minting a new sub-org', async () => {
      const client = createMockClient({
        getSubOrgIds: mock(() =>
          Promise.resolve({ organizationIds: ['existing_no_wallet'] })
        ),
        getWallets: mock(() => Promise.resolve({ wallets: [] })),
        createWallet: mock(() => Promise.reject(new Error('createWallet exploded'))),
      });

      await expect(getOrCreateTurnkeySubOrg('user@example.com', client)).rejects.toThrow(
        'createWallet exploded'
      );
    });

    test('picks deterministically (sorted) when multiple sub-orgs exist', async () => {
      const createSubOrganization = mock(() => Promise.resolve({}));
      const client = createMockClient({
        // Unsorted response order must not affect the selection
        getSubOrgIds: mock(() =>
          Promise.resolve({ organizationIds: ['org_charlie', 'org_alpha', 'org_bravo'] })
        ),
        createSubOrganization,
      });

      const result = await getOrCreateTurnkeySubOrg('user@example.com', client);
      expect(result).toBe('org_alpha');
      expect(createSubOrganization).not.toHaveBeenCalled();

      // Same result regardless of the order Turnkey returns
      const client2 = createMockClient({
        getSubOrgIds: mock(() =>
          Promise.resolve({ organizationIds: ['org_bravo', 'org_charlie', 'org_alpha'] })
        ),
      });
      expect(await getOrCreateTurnkeySubOrg('user@example.com', client2)).toBe('org_alpha');
    });

    test('returns existing sub-org when wallet check fails', async () => {
      const client = createMockClient({
        getSubOrgIds: mock(() =>
          Promise.resolve({ organizationIds: ['fallback_org'] })
        ),
        getWallets: mock(() => Promise.reject(new Error('Wallet check failed'))),
      });

      const result = await getOrCreateTurnkeySubOrg('user@example.com', client);
      expect(result).toBe('fallback_org');
    });

    test('throws when TURNKEY_ORGANIZATION_ID not set', async () => {
      delete process.env.TURNKEY_ORGANIZATION_ID;
      const client = createMockClient();
      await expect(getOrCreateTurnkeySubOrg('user@example.com', client)).rejects.toThrow(
        'TURNKEY_ORGANIZATION_ID is required'
      );
    });

    test('throws when createSubOrganization returns no ID', async () => {
      const client = createMockClient({
        getSubOrgIds: mock(() => Promise.resolve({ organizationIds: [] })),
        createSubOrganization: mock(() =>
          Promise.resolve({ activity: { result: { createSubOrganizationResultV7: {} } } })
        ),
      });

      await expect(getOrCreateTurnkeySubOrg('user@example.com', client)).rejects.toThrow(
        'No sub-organization ID returned'
      );
    });

    test('creates sub-org with correct wallet configuration', async () => {
      const createSubOrganization = mock(() =>
        Promise.resolve({
          activity: {
            result: {
              createSubOrganizationResultV7: { subOrganizationId: 'new_org' },
            },
          },
        })
      );
      const client = createMockClient({
        getSubOrgIds: mock(() => Promise.resolve({ organizationIds: [] })),
        createSubOrganization,
      });

      await getOrCreateTurnkeySubOrg('user@example.com', client);

      const callArgs = (createSubOrganization as any).mock.calls[0][0];
      expect(callArgs.wallet.walletName).toBe('default-wallet');
      expect(callArgs.wallet.accounts).toHaveLength(3);

      // Secp256k1 account
      expect(callArgs.wallet.accounts[0].curve).toBe('CURVE_SECP256K1');
      expect(callArgs.wallet.accounts[0].path).toBe("m/44'/0'/0'/0/0");

      // Ed25519 assertion key
      expect(callArgs.wallet.accounts[1].curve).toBe('CURVE_ED25519');
      expect(callArgs.wallet.accounts[1].path).toBe("m/44'/501'/0'/0'");

      // Ed25519 update key
      expect(callArgs.wallet.accounts[2].curve).toBe('CURVE_ED25519');
      expect(callArgs.wallet.accounts[2].path).toBe("m/44'/501'/1'/0'");
    });

    test('passes email as root user', async () => {
      const createSubOrganization = mock(() =>
        Promise.resolve({
          activity: {
            result: {
              createSubOrganizationResultV7: { subOrganizationId: 'new_org' },
            },
          },
        })
      );
      const client = createMockClient({
        getSubOrgIds: mock(() => Promise.resolve({ organizationIds: [] })),
        createSubOrganization,
      });

      await getOrCreateTurnkeySubOrg('alice@example.com', client);

      const callArgs = (createSubOrganization as any).mock.calls[0][0];
      expect(callArgs.rootUsers[0].userName).toBe('alice@example.com');
      expect(callArgs.rootUsers[0].userEmail).toBe('alice@example.com');
    });

    test('rethrows transient getSubOrgIds errors instead of creating a duplicate', async () => {
      // A network blip / 429 / auth misconfig during lookup must NOT be
      // treated as "no existing sub-org" - that would fork the identity.
      const createSubOrganization = mock(() => Promise.resolve({}));
      const client = createMockClient({
        getSubOrgIds: mock(() => Promise.reject(new Error('Network error'))),
        createSubOrganization,
      });

      await expect(getOrCreateTurnkeySubOrg('user@example.com', client)).rejects.toThrow(
        'Failed to look up existing Turnkey sub-organization'
      );
      expect(createSubOrganization).not.toHaveBeenCalled();
    });

    test('rethrows rate-limit errors from getSubOrgIds', async () => {
      const rateLimited = Object.assign(new Error('rate limit exceeded'), { code: 8 });
      const createSubOrganization = mock(() => Promise.resolve({}));
      const client = createMockClient({
        getSubOrgIds: mock(() => Promise.reject(rateLimited)),
        createSubOrganization,
      });

      await expect(getOrCreateTurnkeySubOrg('user@example.com', client)).rejects.toThrow(
        'rate limit exceeded'
      );
      expect(createSubOrganization).not.toHaveBeenCalled();
    });

    test('creates new sub-org when lookup fails with definitive not-found (gRPC code 5)', async () => {
      const notFound = Object.assign(new Error('resource not found'), { code: 5 });
      const createSubOrganization = mock(() =>
        Promise.resolve({
          activity: {
            result: {
              createSubOrganizationResultV7: { subOrganizationId: 'fallback_new' },
            },
          },
        })
      );
      const client = createMockClient({
        getSubOrgIds: mock(() => Promise.reject(notFound)),
        createSubOrganization,
      });

      const result = await getOrCreateTurnkeySubOrg('user@example.com', client);
      expect(result).toBe('fallback_new');
    });

    test('normalizes email before the Turnkey lookup filter', async () => {
      const getSubOrgIds = mock(() =>
        Promise.resolve({ organizationIds: ['existing_sub_org'] })
      );
      const client = createMockClient({ getSubOrgIds });

      await getOrCreateTurnkeySubOrg('  MixedCase@Example.COM ', client);

      expect(getSubOrgIds).toHaveBeenCalledWith(
        expect.objectContaining({
          filterType: 'EMAIL',
          filterValue: 'mixedcase@example.com',
        })
      );
    });

    test('normalizes email in the created root user', async () => {
      const createSubOrganization = mock(() =>
        Promise.resolve({
          activity: {
            result: {
              createSubOrganizationResultV7: { subOrganizationId: 'new_org' },
            },
          },
        })
      );
      const client = createMockClient({
        getSubOrgIds: mock(() => Promise.resolve({ organizationIds: [] })),
        createSubOrganization,
      });

      await getOrCreateTurnkeySubOrg(' Bob@Example.COM ', client);

      const callArgs = (createSubOrganization as any).mock.calls[0][0];
      expect(callArgs.rootUsers[0].userName).toBe('bob@example.com');
      expect(callArgs.rootUsers[0].userEmail).toBe('bob@example.com');
    });
  });
});
