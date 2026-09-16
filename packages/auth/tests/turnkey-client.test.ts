import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  createTurnkeyClient,
  getOrCreateTurnkeySubOrg,
  normalizeEmail,
  createInProcessSubOrgLock,
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
    // Default: a single wallet already holding all three required accounts,
    // so existing tests that don't care about per-role completeness see no
    // repair activity.
    const COMPLETE_ACCOUNTS = [
      { curve: 'CURVE_SECP256K1', path: "m/44'/0'/0'/0/0" },
      { curve: 'CURVE_ED25519', path: "m/44'/501'/0'/0'" },
      { curve: 'CURVE_ED25519', path: "m/44'/501'/1'/0'" },
    ];

    function createMockClient(overrides?: {
      getSubOrgIds?: () => Promise<unknown>;
      getWallets?: () => Promise<unknown>;
      getWalletAccounts?: (params: { walletId: string }) => Promise<unknown>;
      createWallet?: () => Promise<unknown>;
      createWalletAccounts?: () => Promise<unknown>;
      createSubOrganization?: () => Promise<unknown>;
    }) {
      const getSubOrgIds =
        overrides?.getSubOrgIds ??
        mock(() => Promise.resolve({ organizationIds: ['existing_sub_org'] }));
      const getWallets =
        overrides?.getWallets ??
        mock(() => Promise.resolve({ wallets: [{ walletId: 'w1' }] }));
      const getWalletAccounts =
        overrides?.getWalletAccounts ??
        mock(() => Promise.resolve({ accounts: COMPLETE_ACCOUNTS }));
      const createWallet =
        overrides?.createWallet ?? mock(() => Promise.resolve({ walletId: 'w_new' }));
      const createWalletAccounts =
        overrides?.createWalletAccounts ?? mock(() => Promise.resolve({ accounts: [] }));
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
          getWalletAccounts,
          createWallet,
          createWalletAccounts,
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

    test('provisions the Bitcoin auth-key account with a Bitcoin address format, not Ethereum', async () => {
      // The secp256k1/m/44'/0'/0'/0/0 account is documented ("Bitcoin path
      // for auth-key") and consumed for Bitcoin funding/sat verification, so
      // its addressFormat must match the client-side definition for the same
      // curve/path rather than defaulting to an Ethereum address.
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

      await getOrCreateTurnkeySubOrg('new@example.com', client);

      const callArgs = (createSubOrganization as any).mock.calls[0][0];
      const btcAccount = callArgs.wallet.accounts.find(
        (acc: { curve: string }) => acc.curve === 'CURVE_SECP256K1'
      );
      expect(btcAccount).toBeDefined();
      expect(btcAccount.path).toBe("m/44'/0'/0'/0/0");
      expect(btcAccount.addressFormat).toBe('ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR');
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

    describe('repairing missing account roles in an existing sub-org (#784)', () => {
      test('is a no-op when the wallet already has all three required roles', async () => {
        const createWalletAccounts = mock(() => Promise.resolve({ accounts: [] }));
        const client = createMockClient({
          getSubOrgIds: mock(() => Promise.resolve({ organizationIds: ['already_complete'] })),
          createWalletAccounts,
        });

        const result = await getOrCreateTurnkeySubOrg('user@example.com', client);

        expect(result).toBe('already_complete');
        expect(createWalletAccounts).not.toHaveBeenCalled();
      });

      test('repairs a missing did-assertion account in place', async () => {
        const createWalletAccounts = mock(() => Promise.resolve({ accounts: [] }));
        const client = createMockClient({
          getSubOrgIds: mock(() => Promise.resolve({ organizationIds: ['missing_assertion'] })),
          getWalletAccounts: mock(() =>
            Promise.resolve({
              accounts: [
                { curve: 'CURVE_SECP256K1', path: "m/44'/0'/0'/0/0" },
                { curve: 'CURVE_ED25519', path: "m/44'/501'/1'/0'" },
              ],
            })
          ),
          createWalletAccounts,
        });

        const result = await getOrCreateTurnkeySubOrg('user@example.com', client);

        expect(result).toBe('missing_assertion');
        expect(createWalletAccounts).toHaveBeenCalledTimes(1);
        const callArgs = (createWalletAccounts as any).mock.calls[0][0];
        expect(callArgs.organizationId).toBe('missing_assertion');
        expect(callArgs.walletId).toBe('w1');
        expect(callArgs.accounts).toHaveLength(1);
        expect(callArgs.accounts[0].curve).toBe('CURVE_ED25519');
        expect(callArgs.accounts[0].path).toBe("m/44'/501'/0'/0'");
      });

      test('repairs a missing did-update account in place', async () => {
        const createWalletAccounts = mock(() => Promise.resolve({ accounts: [] }));
        const client = createMockClient({
          getSubOrgIds: mock(() => Promise.resolve({ organizationIds: ['missing_update'] })),
          getWalletAccounts: mock(() =>
            Promise.resolve({
              accounts: [
                { curve: 'CURVE_SECP256K1', path: "m/44'/0'/0'/0/0" },
                { curve: 'CURVE_ED25519', path: "m/44'/501'/0'/0'" },
              ],
            })
          ),
          createWalletAccounts,
        });

        await getOrCreateTurnkeySubOrg('user@example.com', client);

        expect(createWalletAccounts).toHaveBeenCalledTimes(1);
        const callArgs = (createWalletAccounts as any).mock.calls[0][0];
        expect(callArgs.accounts).toHaveLength(1);
        expect(callArgs.accounts[0].path).toBe("m/44'/501'/1'/0'");
      });

      test('repairs every missing role (including a totally missing bitcoin-auth account) in one call', async () => {
        const createWalletAccounts = mock(() => Promise.resolve({ accounts: [] }));
        const client = createMockClient({
          getSubOrgIds: mock(() => Promise.resolve({ organizationIds: ['missing_all'] })),
          getWalletAccounts: mock(() => Promise.resolve({ accounts: [] })),
          createWalletAccounts,
        });

        await getOrCreateTurnkeySubOrg('user@example.com', client);

        expect(createWalletAccounts).toHaveBeenCalledTimes(1);
        const callArgs = (createWalletAccounts as any).mock.calls[0][0];
        expect(callArgs.accounts).toHaveLength(3);
      });

      test('a role satisfied in a second wallet counts as present sub-org-wide, so no repair happens', async () => {
        // A role split across two wallets is still complete overall - the
        // repair must not duplicate it into wallets[0] just because that
        // one wallet alone doesn't have every role.
        const createWalletAccounts = mock(() => Promise.resolve({ accounts: [] }));
        const getWalletAccounts = mock((params: { walletId: string }) =>
          Promise.resolve({
            accounts:
              params.walletId === 'w_first'
                ? [
                    { curve: 'CURVE_SECP256K1', path: "m/44'/0'/0'/0/0" },
                    { curve: 'CURVE_ED25519', path: "m/44'/501'/0'/0'" },
                  ]
                : [{ curve: 'CURVE_ED25519', path: "m/44'/501'/1'/0'" }],
          })
        );
        const client = createMockClient({
          getSubOrgIds: mock(() => Promise.resolve({ organizationIds: ['split_roles'] })),
          getWallets: mock(() =>
            Promise.resolve({ wallets: [{ walletId: 'w_first' }, { walletId: 'w_second' }] })
          ),
          getWalletAccounts,
          createWalletAccounts,
        });

        const result = await getOrCreateTurnkeySubOrg('user@example.com', client);

        expect(result).toBe('split_roles');
        expect(getWalletAccounts).toHaveBeenCalledTimes(2);
        expect(createWalletAccounts).not.toHaveBeenCalled();
      });

      test('fails soft (returns the existing sub-org, does not repair) when checking wallet accounts fails', async () => {
        const createWalletAccounts = mock(() => Promise.resolve({ accounts: [] }));
        const client = createMockClient({
          getSubOrgIds: mock(() => Promise.resolve({ organizationIds: ['accounts_check_fails'] })),
          getWalletAccounts: mock(() => Promise.reject(new Error('getWalletAccounts exploded'))),
          createWalletAccounts,
        });

        const result = await getOrCreateTurnkeySubOrg('user@example.com', client);

        expect(result).toBe('accounts_check_fails');
        expect(createWalletAccounts).not.toHaveBeenCalled();
      });

      test('fails soft when a LATER wallet in a multi-wallet sub-org fails enumeration', async () => {
        const createWalletAccounts = mock(() => Promise.resolve({ accounts: [] }));
        const getWalletAccounts = mock((params: { walletId: string }) =>
          params.walletId === 'w_first'
            ? Promise.resolve({ accounts: [] })
            : Promise.reject(new Error('second wallet exploded'))
        );
        const client = createMockClient({
          getSubOrgIds: mock(() => Promise.resolve({ organizationIds: ['second_wallet_fails'] })),
          getWallets: mock(() =>
            Promise.resolve({ wallets: [{ walletId: 'w_first' }, { walletId: 'w_second' }] })
          ),
          getWalletAccounts,
          createWalletAccounts,
        });

        const result = await getOrCreateTurnkeySubOrg('user@example.com', client);

        expect(result).toBe('second_wallet_fails');
        expect(createWalletAccounts).not.toHaveBeenCalled();
      });

      test('propagates a repair-write failure instead of minting a new sub-org', async () => {
        const createSubOrganization = mock(() => Promise.resolve({}));
        const client = createMockClient({
          getSubOrgIds: mock(() => Promise.resolve({ organizationIds: ['repair_write_fails'] })),
          getWalletAccounts: mock(() => Promise.resolve({ accounts: [] })),
          createWalletAccounts: mock(() =>
            Promise.reject(new Error('createWalletAccounts exploded'))
          ),
          createSubOrganization,
        });

        await expect(getOrCreateTurnkeySubOrg('user@example.com', client)).rejects.toThrow(
          'createWalletAccounts exploded'
        );
        expect(createSubOrganization).not.toHaveBeenCalled();
      });

      test('does not fail the login when a repair-write race is lost to a concurrent repair that already succeeded', async () => {
        // Two instances can both observe the same missing role and both
        // attempt to repair it (the lookup-then-repair sequence is only
        // serialized within one process). If this instance's write loses
        // that race, the role is still present afterward - failing the
        // login here would be wrong.
        let getWalletAccountsCalls = 0;
        const getWalletAccounts = mock(() => {
          getWalletAccountsCalls += 1;
          // First call: initial inventory, missing did-assertion. Second
          // call: post-failure re-check, now complete because the other
          // instance's write won the race.
          return Promise.resolve({
            accounts: getWalletAccountsCalls === 1 ? [COMPLETE_ACCOUNTS[0], COMPLETE_ACCOUNTS[2]] : COMPLETE_ACCOUNTS,
          });
        });
        const createWalletAccounts = mock(() =>
          Promise.reject(new Error('duplicate account for this curve/path'))
        );
        const createSubOrganization = mock(() => Promise.resolve({}));
        const client = createMockClient({
          getSubOrgIds: mock(() => Promise.resolve({ organizationIds: ['raced_repair'] })),
          getWalletAccounts,
          createWalletAccounts,
          createSubOrganization,
        });

        const result = await getOrCreateTurnkeySubOrg('user@example.com', client);

        expect(result).toBe('raced_repair');
        expect(createWalletAccounts).toHaveBeenCalledTimes(1);
        expect(getWalletAccounts).toHaveBeenCalledTimes(2);
        expect(createSubOrganization).not.toHaveBeenCalled();
      });

      test('propagates the repair-write failure when the post-failure re-check shows the role is still missing', async () => {
        const getWalletAccounts = mock(() =>
          Promise.resolve({ accounts: [COMPLETE_ACCOUNTS[0], COMPLETE_ACCOUNTS[2]] })
        );
        const createWalletAccounts = mock(() =>
          Promise.reject(new Error('transient write failure, not a race'))
        );
        const client = createMockClient({
          getSubOrgIds: mock(() => Promise.resolve({ organizationIds: ['real_write_failure'] })),
          getWalletAccounts,
          createWalletAccounts,
        });

        await expect(getOrCreateTurnkeySubOrg('user@example.com', client)).rejects.toThrow(
          'transient write failure, not a race'
        );
      });

      test('propagates the original repair-write failure when the post-failure re-check itself fails', async () => {
        let getWalletAccountsCalls = 0;
        const getWalletAccounts = mock(() => {
          getWalletAccountsCalls += 1;
          if (getWalletAccountsCalls === 1) {
            return Promise.resolve({ accounts: [COMPLETE_ACCOUNTS[0], COMPLETE_ACCOUNTS[2]] });
          }
          return Promise.reject(new Error('re-check also failed'));
        });
        const createWalletAccounts = mock(() =>
          Promise.reject(new Error('original write failure'))
        );
        const client = createMockClient({
          getSubOrgIds: mock(() => Promise.resolve({ organizationIds: ['recheck_fails'] })),
          getWalletAccounts,
          createWalletAccounts,
        });

        await expect(getOrCreateTurnkeySubOrg('user@example.com', client)).rejects.toThrow(
          'original write failure'
        );
      });
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

    test('rethrows a message-only "not found" transport error instead of creating a duplicate', async () => {
      // A generic transport/routing error unrelated to Turnkey's own
      // NOT_FOUND response (no numeric `code`) must never be treated as
      // "no existing sub-org" just because its message happens to contain
      // "not found" - that mints a duplicate identity for an existing user.
      const transportError = new Error('404 Not Found: no such route on this host');
      const createSubOrganization = mock(() => Promise.resolve({}));
      const client = createMockClient({
        getSubOrgIds: mock(() => Promise.reject(transportError)),
        createSubOrganization,
      });

      await expect(getOrCreateTurnkeySubOrg('existing-user@example.com', client)).rejects.toThrow(
        'Failed to look up existing Turnkey sub-organization'
      );
      expect(createSubOrganization).not.toHaveBeenCalled();
    });

    test('rethrows a message-only "does not exist" error wrapped in a cause chain', async () => {
      const transportError = new Error('upstream service does not exist in this region');
      const wrapped = new Error('lookup failed', { cause: transportError });
      const createSubOrganization = mock(() => Promise.resolve({}));
      const client = createMockClient({
        getSubOrgIds: mock(() => Promise.reject(wrapped)),
        createSubOrganization,
      });

      await expect(getOrCreateTurnkeySubOrg('user@example.com', client)).rejects.toThrow(
        'Failed to look up existing Turnkey sub-organization'
      );
      expect(createSubOrganization).not.toHaveBeenCalled();
    });

    test('detects a definitive not-found wrapped in a cause chain', async () => {
      const notFound = Object.assign(new Error('resource not found'), { code: 5 });
      const wrapped = new Error('lookup failed', { cause: notFound });
      const createSubOrganization = mock(() =>
        Promise.resolve({
          activity: {
            result: {
              createSubOrganizationResultV7: { subOrganizationId: 'created_after_wrapped_404' },
            },
          },
        })
      );
      const client = createMockClient({
        getSubOrgIds: mock(() => Promise.reject(wrapped)),
        createSubOrganization,
      });

      const result = await getOrCreateTurnkeySubOrg('user@example.com', client);
      expect(result).toBe('created_after_wrapped_404');
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

    describe('concurrency (TOCTOU race, #728)', () => {
      test('two concurrent calls for the same brand-new email create only one sub-org and resolve to the same ID', async () => {
        // Reproduces the race from #728: both calls must observe an
        // initially-empty lookup, yet only one createSubOrganization call may
        // happen, and both callers must resolve to the same sub-org ID.
        //
        // The mock backend is stateful (like the real Turnkey API): once a
        // sub-org is created, a subsequent lookup for the same email finds
        // it. Without serializing the lookup-then-create sequence, both
        // calls would independently observe an empty lookup (as in the
        // real #728 race) and both would create; with serialization, the
        // second call's lookup runs only after the first call's create has
        // taken effect.
        let createCalls = 0;
        let persistedSubOrgIds: string[] = [];
        const getSubOrgIds = mock(() => Promise.resolve({ organizationIds: persistedSubOrgIds }));
        const getWallets = mock(() => Promise.resolve({ wallets: [{ walletId: 'w1' }] }));
        const createSubOrganization = mock(async () => {
          // Yield so an unserialized second call would have a chance to
          // start its own lookup/create before this one finishes.
          await new Promise((resolve) => setTimeout(resolve, 5));
          createCalls++;
          const id = `sub-org-${createCalls}`;
          persistedSubOrgIds = [id];
          return {
            activity: {
              result: { createSubOrganizationResultV7: { subOrganizationId: id } },
            },
          };
        });
        const client = createMockClient({
          getSubOrgIds,
          getWallets,
          createSubOrganization,
        });

        const [a, b] = await Promise.all([
          getOrCreateTurnkeySubOrg('race-new-user@example.com', client),
          getOrCreateTurnkeySubOrg('race-new-user@example.com', client),
        ]);

        expect(createCalls).toBe(1);
        expect(a).toBe(b);
        expect(a).toBe('sub-org-1');
      });

      test('does not serialize concurrent calls for unrelated emails', async () => {
        // Record start/end events instead of asserting on wall-clock elapsed
        // time (flaky under CI scheduling delays): a correct implementation
        // must start BOTH lookups before EITHER finishes.
        const events: string[] = [];
        const client = createMockClient({
          getSubOrgIds: mock(async (params: any) => {
            events.push(`start:${params.filterValue}`);
            await new Promise((resolve) => setTimeout(resolve, 15));
            events.push(`end:${params.filterValue}`);
            return { organizationIds: ['existing'] };
          }),
        });

        await Promise.all([
          getOrCreateTurnkeySubOrg('alice-unrelated@example.com', client),
          getOrCreateTurnkeySubOrg('bob-unrelated@example.com', client),
        ]);

        const startEvents = events.filter((e) => e.startsWith('start:'));
        const endEvents = events.filter((e) => e.startsWith('end:'));
        // If the lock serialized unrelated keys, bob's start would come
        // after alice's end (events: start:alice, end:alice, start:bob,
        // end:bob). Concurrent execution interleaves both starts first.
        expect(startEvents).toEqual(['start:alice-unrelated@example.com', 'start:bob-unrelated@example.com']);
        expect(events.indexOf(startEvents[1])).toBeLessThan(events.indexOf(endEvents[0]));
      });

      test('releases the lock after a failed call so a later call for the same email proceeds', async () => {
        const failingClient = createMockClient({
          getSubOrgIds: mock(() => Promise.reject(new Error('lookup exploded'))),
        });
        await expect(
          getOrCreateTurnkeySubOrg('retry-after-failure@example.com', failingClient)
        ).rejects.toThrow('lookup exploded');

        const recoveredClient = createMockClient({
          getSubOrgIds: mock(() => Promise.resolve({ organizationIds: ['recovered_org'] })),
        });
        const result = await getOrCreateTurnkeySubOrg(
          'retry-after-failure@example.com',
          recoveredClient
        );
        expect(result).toBe('recovered_org');
      });
    });

    describe('createInProcessSubOrgLock', () => {
      test('serializes calls for the same key', async () => {
        const lock = createInProcessSubOrgLock();
        const order: string[] = [];

        const first = lock.withLock('key-a', async () => {
          order.push('first-start');
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push('first-end');
          return 1;
        });
        const second = lock.withLock('key-a', async () => {
          order.push('second-start');
          return 2;
        });

        expect(await Promise.all([first, second])).toEqual([1, 2]);
        expect(order).toEqual(['first-start', 'first-end', 'second-start']);
      });

      test('does not serialize calls for different keys', async () => {
        const lock = createInProcessSubOrgLock();
        const order: string[] = [];

        const first = lock.withLock('key-a', async () => {
          order.push('a-start');
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push('a-end');
        });
        const second = lock.withLock('key-b', async () => {
          order.push('b-start');
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push('b-end');
        });

        await Promise.all([first, second]);
        // Both should have started before either finished.
        expect(order.slice(0, 2).sort()).toEqual(['a-start', 'b-start']);
      });

      test('releases the lock even when the guarded function throws', async () => {
        const lock = createInProcessSubOrgLock();

        await expect(
          lock.withLock('key-a', async () => {
            throw new Error('boom');
          })
        ).rejects.toThrow('boom');

        // A subsequent call for the same key must not be blocked forever.
        const result = await lock.withLock('key-a', async () => 'ok');
        expect(result).toBe('ok');
      });
    });
  });
});
