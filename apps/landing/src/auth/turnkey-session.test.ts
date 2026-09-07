import { describe, test, expect } from 'bun:test';
import {
  stampLoginToSession,
  attestedStampValue,
  ensureBitcoinFundingAccount,
  type TurnkeyBitcoinClient,
} from './turnkey-session';

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
  decodeVerificationToken,
  BoundKeyMismatchError,
  isBoundKeyMismatch,
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

describe('the Bitcoin funding account is found, not re-created', () => {
  /**
   * Models the REAL Turnkey API: getWallets returns wallet metadata with no
   * accounts field, and accounts come from getWalletAccounts.
   *
   * The previous fake returned `accounts` from getWallets — a field
   * `v1Wallet` does not have. That one invented field is why the suite showed
   * this function as idempotent while every live sign-in after the first
   * failed with "code 6: path already exists in wallet account".
   */
  function client(opts: {
    accounts?: Array<{ address: string; path: string }>;
    createAddress?: string;
    createThrows?: Error;
    onCreate?: (path: string, addressFormat: string) => void;
  }) {
    const accounts = [...(opts.accounts ?? [])];
    let creates = 0;
    const api: TurnkeyBitcoinClient = {
      async getWallets() {
        return { wallets: [{ walletId: 'w1' }] };
      },
      async getWalletAccounts() {
        return { accounts };
      },
      async createWalletAccounts(params) {
        creates += 1;
        opts.onCreate?.(params.accounts[0].path, params.accounts[0].addressFormat);
        if (opts.createThrows) throw opts.createThrows;
        const address = opts.createAddress ?? 'tb1qexampleuseraddr000000000000000000000000';
        accounts.push({ address, path: params.accounts[0].path });
        return { addresses: [address] };
      },
      async signTransaction() {
        throw new Error('not used here');
      },
    };
    return { api, creates: () => creates };
  }

  test('creates the account when the path is absent, and returns its address', async () => {
    const { api, creates } = client({});
    expect(await ensureBitcoinFundingAccount(api, 'sub-1')).toStartWith('tb1q');
    expect(creates()).toBe(1);
  });

  // The live failure: a second sign-in must find the account, not re-create it.
  test('a second call finds the existing account and never calls create again', async () => {
    const { api, creates } = client({});
    const first = await ensureBitcoinFundingAccount(api, 'sub-1');
    const second = await ensureBitcoinFundingAccount(api, 'sub-1');
    expect(second).toBe(first);
    expect(creates()).toBe(1);
  });

  test('an account created by an earlier session is reused, so funds stay reachable', async () => {
    const address = 'tb1qalreadytherefrombefore00000000000000000';
    const { api, creates } = client({ accounts: [{ address, path: "m/84'/1'/0'/0/0" }] });
    expect(await ensureBitcoinFundingAccount(api, 'sub-1')).toBe(address);
    expect(creates()).toBe(0);
  });

  test('mainnet uses its own path and format, and is not satisfied by the testnet account', async () => {
    const seen: Array<[string, string]> = [];
    const { api } = client({
      accounts: [{ address: 'tb1qtestnetaccount0000000000000000000000000', path: "m/84'/1'/0'/0/0" }],
      createAddress: 'bc1qexampleuseraddr000000000000000000000000',
      onCreate: (path, fmt) => seen.push([path, fmt]),
    });
    expect(await ensureBitcoinFundingAccount(api, 'sub-1', 'mainnet')).toStartWith('bc1q');
    expect(seen).toEqual([["m/84'/0'/0'/0/0", 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH']]);
  });

  // Turnkey saying the path exists is proof the account is there. Failing the
  // sign-in over it would block a user out of an account that already works.
  test('recovers when create reports the path already exists', async () => {
    const address = 'tb1qracedaccount000000000000000000000000000';
    const accounts: Array<{ address: string; path: string }> = [];
    const api: TurnkeyBitcoinClient = {
      async getWallets() {
        return { wallets: [{ walletId: 'w1' }] };
      },
      async getWalletAccounts() {
        // Empty on the first read, populated by the time we re-read.
        const snapshot = [...accounts];
        accounts.push({ address, path: "m/84'/1'/0'/0/0" });
        return { accounts: snapshot };
      },
      async createWalletAccounts() {
        throw new Error('path already exists in wallet account 0728c0a2-a504-44f2-ba5c-79d3db14f0c4');
      },
      async signTransaction() {
        throw new Error('not used here');
      },
    };
    expect(await ensureBitcoinFundingAccount(api, 'sub-1')).toBe(address);
  });

  test('an unrelated create failure is not swallowed', async () => {
    const { api } = client({ createThrows: new Error('insufficient permissions') });
    await expect(ensureBitcoinFundingAccount(api, 'sub-1')).rejects.toThrow('insufficient permissions');
  });

  test('rejects a testnet address returned for the mainnet path', async () => {
    const { api } = client({ createAddress: 'tb1qwrongnetwork00000000000000000000000000' });
    await expect(ensureBitcoinFundingAccount(api, 'sub-1', 'mainnet')).rejects.toThrow(
      'unexpected funding address'
    );
  });

  // The prefix check used to run only on a freshly created address.
  test('rejects a wrong-network address even when it comes from an existing account', async () => {
    const { api } = client({
      accounts: [{ address: 'tb1qwrongnetwork00000000000000000000000000', path: "m/84'/0'/0'/0/0" }],
    });
    await expect(ensureBitcoinFundingAccount(api, 'sub-1', 'mainnet')).rejects.toThrow(
      'unexpected funding address'
    );
  });
});

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

describe('U1: STAMP_LOGIN authenticates with Turnkey\u2019s attested stamp', () => {
  const tokenId = 'tok-123';
  const sessionPublicKey = '02'.padEnd(66, 'b');
  const verificationToken = fakeVerificationToken({ id: tokenId, public_key: sessionPublicKey });
  // The attested stamp carries a DER signature, per Turnkey's AttestedStamper.
  const derSignature = '3044' + 'cd'.repeat(68);

  function signer(signature: string = derSignature): SessionKeySigner & { signed: string[] } {
    const signed: string[] = [];
    return {
      publicKeyHex: sessionPublicKey,
      signed,
      // A non-extractable WebCrypto key can only be asked to sign a payload;
      // it can never hand over the private scalar. That is the whole point.
      async signDer(payload: string) {
        signed.push(payload);
        return signature;
      },
    };
  }

  function completed(session = 'session-jwt-xyz') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        activity: { status: 'ACTIVITY_STATUS_COMPLETED', result: { stampLoginResult: { session } } },
      }),
    } as unknown as Response;
  }

  test('decodeVerificationToken reads the bound public key and token id', () => {
    expect(decodeVerificationToken(verificationToken)).toEqual({ id: tokenId, public_key: sessionPublicKey });
  });

  // Turnkey verifies the stamp byte-for-byte, so base64url has to match
  // @turnkey/encoding exactly: URL-safe alphabet AND stripped padding.
  test('the stamp is base64url with padding stripped, and decodes to Turnkey\u2019s shape', () => {
    const value = attestedStampValue({
      verificationToken,
      publicKey: sessionPublicKey,
      signature: derSignature,
    });
    expect(value).not.toContain('=');
    expect(value).not.toContain('+');
    expect(value).not.toContain('/');
    const decoded = JSON.parse(
      atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='))
    );
    expect(decoded).toEqual({
      publicKeyAttestation: verificationToken,
      scheme: 'STAMP_ATTESTED_SCHEME_P256_VERIFICATION_TOKEN',
      publicKey: sessionPublicKey,
      signature: derSignature,
    });
  });

  test('the signed payload is byte-identical to the body sent', async () => {
    let sentBody: string | undefined;
    const key = signer();
    await stampLoginToSession({
      subOrgId: 'sub-1',
      verificationToken,
      signer: key,
      now: () => 1_700_000_000_000,
      fetchFn: (async (_url: string, init: RequestInit) => {
        sentBody = init.body as string;
        return completed();
      }) as unknown as typeof fetch,
    });
    // Re-serialising between signing and sending would invalidate the stamp.
    expect(key.signed).toHaveLength(1);
    expect(sentBody).toBe(key.signed[0]);
    expect(JSON.parse(sentBody!)).toEqual({
      type: 'ACTIVITY_TYPE_STAMP_LOGIN',
      timestampMs: '1700000000000',
      organizationId: 'sub-1',
      parameters: { publicKey: sessionPublicKey, expirationSeconds: String(SESSION_EXPIRATION_SECONDS) },
    });
  });

  test('sends the attested stamp header and returns the session plus its expiry', async () => {
    let headers: Record<string, string> | undefined;
    const t0 = 1_700_000_000_000;
    const { session, meta } = await stampLoginToSession({
      subOrgId: 'sub-1',
      verificationToken,
      signer: signer(),
      now: () => t0,
      fetchFn: (async (url: string, init: RequestInit) => {
        expect(url).toContain('/public/v1/submit/stamp_login');
        headers = init.headers as Record<string, string>;
        return completed();
      }) as unknown as typeof fetch,
    });
    expect(headers?.['X-Stamp-Attested']).toBeTruthy();
    expect(session).toBe('session-jwt-xyz');
    expect(meta).toEqual({
      subOrgId: 'sub-1',
      publicKey: sessionPublicKey,
      expiresAt: t0 + SESSION_EXPIRATION_SECONDS * 1000,
    });
  });

  // The failure that started this: Turnkey answered PUBLIC_KEY_NOT_FOUND and
  // the only reason it was diagnosable is that its own words survived.
  test('a rejection carries Turnkey\u2019s own message, not just a status code', async () => {
    await expect(
      stampLoginToSession({
        subOrgId: 'sub-1',
        verificationToken,
        signer: signer(),
        fetchFn: (async () => ({
          ok: false,
          status: 401,
          json: async () => ({ message: 'could not find public key in organization' }),
        })) as unknown as typeof fetch,
      })
    ).rejects.toThrow(/could not find public key/);
  });

  test('an activity that did not complete is not mistaken for a session', async () => {
    await expect(
      stampLoginToSession({
        subOrgId: 'sub-1',
        verificationToken,
        signer: signer(),
        fetchFn: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ activity: { status: 'ACTIVITY_STATUS_PENDING' } }),
        })) as unknown as typeof fetch,
      })
    ).rejects.toThrow(/did not complete/);
  });
});

/**
 * #494 — the verification token comes back through OUR server. Its `public_key`
 * claim used to be taken verbatim as the session public key, so a server (or
 * an edge before TLS terminates) that drove verify-otp with its own key could
 * have that key installed as this browser's 12-hour session credential. The
 * browser holds the ground truth and must compare.
 */
describe('#494: the verification token must be bound to the key THIS browser holds', () => {
  const browserKey = '02'.padEnd(66, 'b');
  const foreignKey = '03'.padEnd(66, 'f');

  function signer(publicKeyHex: string): SessionKeySigner & { signed: string[] } {
    const signed: string[] = [];
    return {
      publicKeyHex,
      signed,
      async signDer(payload: string) {
        signed.push(payload);
        return '3044' + 'cd'.repeat(68);
      },
    };
  }

  function turnkey() {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          activity: { status: 'ACTIVITY_STATUS_COMPLETED', result: { stampLoginResult: { session: 's' } } },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  test('a token bound to a foreign key is refused before anything is signed or sent to Turnkey', async () => {
    const key = signer(browserKey);
    const { fetchFn, calls } = turnkey();
    await expect(
      stampLoginToSession({
        subOrgId: 'sub-1',
        verificationToken: fakeVerificationToken({ id: 'tok', public_key: foreignKey }),
        signer: key,
        fetchFn,
      })
    ).rejects.toThrow('Verification token is bound to a key this browser does not hold');
    // Fail closed means no signature over the login body and no request:
    // the attacker's token never gets a stamp from this browser's key.
    expect(key.signed).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('the refusal is a named error the caller can tell apart from a Turnkey outage', async () => {
    let caught: unknown;
    try {
      await stampLoginToSession({
        subOrgId: 'sub-1',
        verificationToken: fakeVerificationToken({ id: 'tok', public_key: foreignKey }),
        signer: signer(browserKey),
        fetchFn: turnkey().fetchFn,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BoundKeyMismatchError);
    expect(isBoundKeyMismatch(caught)).toBe(true);
    expect(isBoundKeyMismatch(new Error('STAMP_LOGIN failed (503): no message'))).toBe(false);
  });

  test('a token bound to this browser’s key proceeds, and the session key IS the browser’s key', async () => {
    const key = signer(browserKey);
    const { fetchFn, calls } = turnkey();
    const { meta } = await stampLoginToSession({
      subOrgId: 'sub-1',
      verificationToken: fakeVerificationToken({ id: 'tok', public_key: browserKey }),
      signer: key,
      fetchFn,
    });
    expect(calls).toHaveLength(1);
    expect(meta.publicKey).toBe(browserKey);
    expect(JSON.parse(key.signed[0]!).parameters.publicKey).toBe(browserKey);
  });

  // The ticket asks that an absent bound key fall through to the browser's
  // key. A token with no `public_key` cannot attest to anything under the
  // P256_VERIFICATION_TOKEN scheme, so the decoder's existing rejection is the
  // safer answer: refuse, and do it before a byte reaches Turnkey.
  test('a token with no bound key is refused rather than silently treated as the browser’s', async () => {
    const key = signer(browserKey);
    const { fetchFn, calls } = turnkey();
    const b64 = btoa(JSON.stringify({ id: 'tok' })).replace(/=+$/, '');
    await expect(
      stampLoginToSession({
        subOrgId: 'sub-1',
        verificationToken: `eyJhbGciOiJFUzI1NiJ9.${b64}.c2ln`,
        signer: key,
        fetchFn,
      })
    ).rejects.toThrow(/missing id or public_key/);
    expect(key.signed).toEqual([]);
    expect(calls).toEqual([]);
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
