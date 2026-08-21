import { describe, test, expect } from 'bun:test';
import {
  otpLoginToSession,
  ensureBitcoinFundingAccount,
  type TurnkeyBitcoinClient,
  type TurnkeySessionApi,
} from './turnkey-session';

describe('turnkey-session helpers', () => {
  test('ensureBitcoinFundingAccount adds a testnet P2WPKH account and returns its tb1 address (idempotent)', async () => {
    let existing: Array<{ address: string; path: string }> = [];
    const client: TurnkeyBitcoinClient = {
      async getWallets() {
        return { wallets: [{ walletId: 'w1', accounts: existing }] };
      },
      async createWalletAccounts(params) {
        const address = 'tb1qexampleuseraddr000000000000000000000000';
        existing = [{ address, path: params.accounts[0].path }];
        return { addresses: [address] };
      },
      async signTransaction() {
        throw new Error('not used here');
      },
    };
    const addr = await ensureBitcoinFundingAccount(client, 'sub-1');
    expect(addr.startsWith('tb1q')).toBe(true);
    // Second call must NOT create a duplicate account — returns the cached one.
    const addr2 = await ensureBitcoinFundingAccount(client, 'sub-1');
    expect(addr2).toBe(addr);
  });

  test('ensureBitcoinFundingAccount(mainnet) uses the mainnet path/format and expects bc1', async () => {
    const created: Array<{ path: string; addressFormat: string }> = [];
    const client: TurnkeyBitcoinClient = {
      async getWallets() {
        return { wallets: [{ walletId: 'w1', accounts: [] }] };
      },
      async createWalletAccounts(params) {
        created.push(params.accounts[0]);
        return { addresses: ['bc1qexampleuseraddr000000000000000000000000'] };
      },
      async signTransaction() {
        throw new Error('not used here');
      },
    };
    const addr = await ensureBitcoinFundingAccount(client, 'sub-1', 'mainnet');
    expect(addr.startsWith('bc1')).toBe(true);
    // BIP-84 mainnet coin type 0' — a DIFFERENT account than the testnet path.
    expect(created[0].path).toBe("m/84'/0'/0'/0/0");
    expect(created[0].addressFormat).toBe('ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH');
  });

  test('ensureBitcoinFundingAccount(mainnet) rejects a tb1 address from Turnkey', async () => {
    const client: TurnkeyBitcoinClient = {
      async getWallets() {
        return { wallets: [{ walletId: 'w1', accounts: [] }] };
      },
      async createWalletAccounts() {
        return { addresses: ['tb1qwrongnetworkaddr00000000000000000000000'] };
      },
      async signTransaction() {
        throw new Error('not used here');
      },
    };
    await expect(ensureBitcoinFundingAccount(client, 'sub-1', 'mainnet')).rejects.toThrow('unexpected funding address');
  });
});

/**
 * U1 — the two defects the plan calls out, each proved before it is fixed:
 * the 15-minute expiry that dies inside a Bitcoin confirmation wait, and the
 * reload that silently strips signing capability.
 */
import {
  SESSION_EXPIRATION_SECONDS,
  SESSION_STORAGE_KEY,
  signingStatus,
  readSessionMeta,
  writeSessionMeta,
  clearSessionMeta,
  revokeSessionKey,
  restoreDecision,
  loginClientSignatureMessage,
  decodeVerificationToken,
  type SigningSessionMeta,
  type SessionKeySigner,
  type TurnkeyRevocationApi,
} from './turnkey-session';

/** A minimal in-memory Storage stand-in (bun test has no localStorage). */
function memoryStorage(): Storage & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  } as Storage & { dump(): Record<string, string> };
}

/** Build a Turnkey-shaped verification token: `<header>.<payloadB64url>.<sig>`. */
function fakeVerificationToken(payload: { id: string; public_key: string }): string {
  const b64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJFUzI1NiJ9.${b64}.c2ln`;
}

const MINUTES = 60_000;

describe('U1: session lifetime survives a Bitcoin confirmation wait', () => {
  test('the configured expiry is far longer than the 15-minute Turnkey default', () => {
    expect(SESSION_EXPIRATION_SECONDS).toBeGreaterThan(900);
    // A mainnet confirmation is 10–60+ minutes and unbounded during a fee spike.
    expect(SESSION_EXPIRATION_SECONDS).toBeGreaterThanOrEqual(6 * 60 * 60);
  });

  test('a session created with the extended expiry is still active after 45 minutes', () => {
    const t0 = 1_700_000_000_000;
    const meta: SigningSessionMeta = {
      subOrgId: 'sub-1',
      publicKey: '02'.padEnd(66, 'a'),
      expiresAt: t0 + SESSION_EXPIRATION_SECONDS * 1000,
    };
    // The old 15-minute window would already be dead here.
    expect(signingStatus(meta, t0 + 16 * MINUTES)).toBe('active');
    expect(signingStatus(meta, t0 + 45 * MINUTES)).toBe('active');
    expect(signingStatus(meta, t0 + 4 * 60 * MINUTES)).toBe('active');
  });

  test('a session past its expiry is reported expired, and a missing one is none', () => {
    const t0 = 1_700_000_000_000;
    const meta: SigningSessionMeta = { subOrgId: 'sub-1', publicKey: 'pk', expiresAt: t0 + 60_000 };
    expect(signingStatus(meta, t0 + 10 * MINUTES)).toBe('expired');
    expect(signingStatus(null, t0)).toBe('none');
  });

  test('expiry is reported a little early, so a signature is never started against a dead window', () => {
    const t0 = 1_700_000_000_000;
    const meta: SigningSessionMeta = { subOrgId: 'sub-1', publicKey: 'pk', expiresAt: t0 + 30_000 };
    // Turnkey would still accept at t0+29s; we refuse, because the round-trip
    // could land after the window closes.
    expect(signingStatus(meta, t0 + 29_000)).toBe('expired');
  });
});

describe('U1: signing capability survives a reload', () => {
  test('session metadata round-trips through browser storage', () => {
    const storage = memoryStorage();
    const meta: SigningSessionMeta = { subOrgId: 'sub-1', publicKey: '02abc', expiresAt: 123 };
    writeSessionMeta(storage, meta);
    expect(readSessionMeta(storage, 'sub-1')).toEqual(meta);
  });

  test('what is persisted is metadata only — never key material', () => {
    const storage = memoryStorage();
    writeSessionMeta(storage, { subOrgId: 'sub-1', publicKey: '02abc', expiresAt: 123 });
    const blob = JSON.stringify(storage.dump());
    expect(blob).not.toContain('privateKey');
    expect(blob).not.toContain('apiPrivateKey');
    // The persisted record has exactly three fields and none of them is secret.
    const stored = JSON.parse(storage.getItem(SESSION_STORAGE_KEY)!);
    expect(Object.keys(stored).sort()).toEqual(['expiresAt', 'publicKey', 'subOrgId']);
  });

  test('a session belonging to another sub-org is not restored', () => {
    const storage = memoryStorage();
    writeSessionMeta(storage, { subOrgId: 'sub-1', publicKey: '02abc', expiresAt: 123 });
    expect(readSessionMeta(storage, 'sub-2')).toBeNull();
  });

  test('malformed storage is ignored rather than thrown from the reload path', () => {
    const storage = memoryStorage();
    storage.setItem(SESSION_STORAGE_KEY, '{not json');
    expect(readSessionMeta(storage, 'sub-1')).toBeNull();
  });

  test('sign-out erases the record: nothing signing-related is left in storage', () => {
    const storage = memoryStorage();
    writeSessionMeta(storage, { subOrgId: 'sub-1', publicKey: '02abc', expiresAt: 123 });
    clearSessionMeta(storage);
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(Object.keys(storage.dump())).toEqual([]);
    expect(readSessionMeta(storage, 'sub-1')).toBeNull();
  });
});

describe('U1: OTP_LOGIN runs off a non-extractable key', () => {
  const tokenId = 'tok-123';
  const sessionPublicKey = '02'.padEnd(66, 'b');
  const verificationToken = fakeVerificationToken({ id: tokenId, public_key: sessionPublicKey });

  function signer(): SessionKeySigner & { signed: string[] } {
    const signed: string[] = [];
    return {
      publicKeyHex: sessionPublicKey,
      signed,
      // A non-extractable WebCrypto key can only be asked to sign a message;
      // it can never hand over the private scalar. That is the whole point.
      async sign(message: string) {
        signed.push(message);
        return 'deadbeef';
      },
    };
  }

  test('decodeVerificationToken reads the bound public key and token id', () => {
    expect(decodeVerificationToken(verificationToken)).toEqual({ id: tokenId, public_key: sessionPublicKey });
  });

  test('the login message is Turnkey’s USAGE_TYPE_LOGIN payload over tokenId + session public key', () => {
    expect(loginClientSignatureMessage(tokenId, sessionPublicKey)).toBe(
      JSON.stringify({ login: { publicKey: sessionPublicKey }, tokenId, type: 'USAGE_TYPE_LOGIN' })
    );
  });

  test('otpLoginToSession signs with the injected key and sends the clientSignature object', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const turnkey: TurnkeySessionApi = {
      async otpLogin(params) {
        calls.push(params as unknown as Record<string, unknown>);
        return { session: 'session-jwt-xyz' };
      },
    };
    const key = signer();
    const t0 = 1_700_000_000_000;
    const { session, meta } = await otpLoginToSession({
      turnkey,
      subOrgId: 'sub-1',
      verificationToken,
      signer: key,
      now: () => t0,
    });
    expect(session).toBe('session-jwt-xyz');
    // The key signed the login message itself — no private scalar was read.
    expect(key.signed).toEqual([loginClientSignatureMessage(tokenId, sessionPublicKey)]);
    expect(calls[0].clientSignature).toEqual({
      publicKey: sessionPublicKey,
      scheme: 'CLIENT_SIGNATURE_SCHEME_API_P256',
      message: loginClientSignatureMessage(tokenId, sessionPublicKey),
      signature: 'deadbeef',
    });
    // Defaults to the extended window, and reports back when it dies.
    expect(calls[0].expirationSeconds).toBe(String(SESSION_EXPIRATION_SECONDS));
    expect(meta).toEqual({
      subOrgId: 'sub-1',
      publicKey: sessionPublicKey,
      expiresAt: t0 + SESSION_EXPIRATION_SECONDS * 1000,
    });
  });
});

describe('U1: sign-out revokes the signing credential at Turnkey', () => {
  const meta: SigningSessionMeta = { subOrgId: 'sub-1', publicKey: '02abc', expiresAt: 1 };

  test('deletes the API key whose public key is this session’s', async () => {
    const deleted: string[][] = [];
    const api: TurnkeyRevocationApi = {
      async getWhoami() {
        return { userId: 'user-1' };
      },
      async getApiKeys() {
        return {
          apiKeys: [
            { apiKeyId: 'other', credential: { publicKey: '02zzz' } },
            { apiKeyId: 'session', credential: { publicKey: '02abc' } },
          ],
        };
      },
      async deleteApiKeys(params) {
        deleted.push(params.apiKeyIds);
        return {};
      },
    };
    expect(await revokeSessionKey(api, meta)).toBe('revoked');
    expect(deleted).toEqual([['session']]);
  });

  test('a Turnkey failure is a named state, not a throw — the local erase still has to happen', async () => {
    const api: TurnkeyRevocationApi = {
      async getWhoami() {
        throw new Error('network down');
      },
      async getApiKeys() {
        return { apiKeys: [] };
      },
      async deleteApiKeys() {
        return {};
      },
    };
    expect(await revokeSessionKey(api, meta)).toBe('revoke-failed');
  });
});

describe('U1: what a page load does with what it found', () => {
  const t0 = 1_700_000_000_000;
  const live: SigningSessionMeta = { subOrgId: 'sub-1', publicKey: '02abc', expiresAt: t0 + 60 * 60_000 };

  test('a live session whose key this browser still holds is restored — signing capability comes back', () => {
    expect(restoreDecision(live, '02abc', t0)).toBe('restore');
  });

  test('a live session whose key this browser no longer holds is NOT restored', () => {
    // Fail closed: a signing client stamped by the wrong key would only fail
    // at Turnkey, and it would fail after the user committed funds.
    expect(restoreDecision(live, '02different', t0)).toBe('none');
    expect(restoreDecision(live, null, t0)).toBe('none');
  });

  test('a session past its window reports expired, so the UI can offer re-authentication', () => {
    expect(restoreDecision({ ...live, expiresAt: t0 - 1 }, '02abc', t0)).toBe('expired');
  });

  test('after sign-out, a reload finds nothing and the inscribe path reports re-auth needed', () => {
    const storage = memoryStorage();
    writeSessionMeta(storage, live);
    clearSessionMeta(storage);
    const afterReload = readSessionMeta(storage, 'sub-1');
    expect(afterReload).toBeNull();
    expect(restoreDecision(afterReload, '02abc', t0)).toBe('none');
    expect(signingStatus(afterReload, t0)).toBe('none');
  });
});
