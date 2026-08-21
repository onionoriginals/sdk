/**
 * Turnkey session helpers for Track B (real-network Bitcoin signing).
 *
 * After OTP verify, the sub-org is credential-less: the parent Turnkey key
 * can't sign for it and there is no passkey. OTP_LOGIN installs the browser's
 * P-256 key as the session credential, after which the user's Bitcoin signing
 * (signTransaction) is silent within the session window.
 *
 * The session key is a NON-EXTRACTABLE WebCrypto CryptoKey held in IndexedDB
 * (see ./turnkey-browser-client): this module never sees a private scalar, only
 * a `SessionKeySigner` it can ask for a signature. That is what lets the
 * credential outlive a reload without ever being readable by page script.
 * These helpers stay pure (no @turnkey/sdk-browser import) so they run under
 * `bun test`; the concrete browser client lives in ./turnkey-browser-client.
 */

/**
 * How long the signing session lives. Turnkey documents NO ceiling — "The
 * expiration of session keys can be specified to any amount of time using the
 * expirationSeconds parameter", default 900s
 * (https://docs.turnkey.com/authentication/sessions). 900s cannot survive a
 * Bitcoin confirmation wait (10–60+ minutes, unbounded during a fee spike), so
 * we take 12 hours: long enough that no realistic confirmation outlives it,
 * short enough that an abandoned browser stops being able to sign the same day.
 */
export const SESSION_EXPIRATION_SECONDS = 12 * 60 * 60;

/**
 * Report expiry this far early. A signature started at T-10s can land at
 * Turnkey after the window closes; refusing early keeps expiry a UI state
 * instead of a raw API error after the user has already sent BTC.
 */
export const SESSION_EXPIRY_MARGIN_MS = 60_000;

/** Where the browser holds the session's NON-SECRET metadata. */
export const SESSION_STORAGE_KEY = 'originals.signing-session';

/**
 * Everything persisted about a signing session. Deliberately three
 * non-secret fields: the key itself is a non-extractable CryptoKey in
 * IndexedDB and is never serialised here.
 */
export interface SigningSessionMeta {
  subOrgId: string;
  /** Compressed P-256 public key hex — the API key OTP_LOGIN installed. */
  publicKey: string;
  /** Epoch ms at which Turnkey stops honouring the session key. */
  expiresAt: number;
}

/**
 * 'none' — this browser holds no session key yet; signing in mints one.
 * 'expired' — it had one and the window closed; signing in refreshes it.
 * 'unavailable' — the bootstrap itself FAILED. Signing in again is what just
 *   failed, so telling the user to repeat it sends them round a loop that
 *   cannot terminate. Kept distinct for that reason alone.
 */
export type SigningStatus = 'none' | 'active' | 'expired' | 'unavailable';

/**
 * A handle to the session key. `sign` takes the message and returns a hex
 * signature; the caller can never obtain the private key, because a
 * non-extractable CryptoKey has none to give.
 */
export interface SessionKeySigner {
  /** Compressed P-256 public key hex. */
  publicKeyHex: string;
  sign(message: string): Promise<string>;
}

export interface ClientSignature {
  publicKey: string;
  scheme: 'CLIENT_SIGNATURE_SCHEME_API_P256';
  message: string;
  signature: string;
}

/** The single OTP_LOGIN activity the session bootstrap needs. */
export interface TurnkeySessionApi {
  otpLogin(params: {
    organizationId: string;
    verificationToken: string;
    publicKey: string;
    clientSignature: ClientSignature;
    expirationSeconds?: string;
  }): Promise<{ session: string }>;
}

/** The Bitcoin-signing + account surface the rest of Track B consumes. */
export interface TurnkeyBitcoinClient {
  signTransaction(params: {
    signWith: string;
    unsignedTransaction: string;
    type: 'TRANSACTION_TYPE_BITCOIN';
  }): Promise<{ signedTransaction: string }>;
  createWalletAccounts(params: {
    walletId: string;
    organizationId: string;
    accounts: Array<{
      curve: 'CURVE_SECP256K1';
      pathFormat: 'PATH_FORMAT_BIP32';
      path: string;
      addressFormat: 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH' | 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH';
    }>;
  }): Promise<{ addresses: string[] }>;
  getWallets(params: { organizationId: string }): Promise<{
    wallets: Array<{ walletId: string; accounts?: Array<{ address: string; path?: string }> }>;
  }>;
}

export type FundingNetwork = 'testnet4' | 'mainnet';

// ⚠️ A user's testnet path and mainnet path are DIFFERENT accounts on the same
// Turnkey wallet (BIP-84 coin type 1' vs 0'): anywhere a funding address is
// cached it must be keyed by network, never treated as "the" address.
const P2WPKH_ACCOUNTS: Record<FundingNetwork, {
  path: string;
  addressFormat: 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH' | 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH';
  prefix: string;
}> = {
  testnet4: { path: "m/84'/1'/0'/0/0", addressFormat: 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH', prefix: 'tb1' },
  mainnet: { path: "m/84'/0'/0'/0/0", addressFormat: 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH', prefix: 'bc1' },
};

/** Base64url → UTF-8, without pulling a codec dependency in. */
function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
}

/**
 * Read the Turnkey verification token's payload. It carries the token `id` and
 * the `public_key` it was bound to at verify-otp time — both are inputs to the
 * login signature, so the browser must be able to read them back.
 */
export function decodeVerificationToken(token: string): { id: string; public_key: string } {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('Invalid verification token: missing payload');
  const decoded = JSON.parse(decodeBase64Url(payload)) as { id?: string; public_key?: string };
  if (!decoded.id || !decoded.public_key) {
    throw new Error('Invalid verification token: missing id or public_key');
  }
  return { id: decoded.id, public_key: decoded.public_key };
}

/**
 * The exact message Turnkey verifies for OTP_LOGIN's clientSignature — field
 * order included, since the signature is over this JSON string. Mirrors
 * `getClientSignatureMessageForLogin` in @turnkey/core.
 */
export function loginClientSignatureMessage(tokenId: string, sessionPublicKey: string): string {
  return JSON.stringify({ login: { publicKey: sessionPublicKey }, tokenId, type: 'USAGE_TYPE_LOGIN' });
}

/**
 * Run OTP_LOGIN: sign the login message with the browser's non-extractable
 * P-256 key and exchange it for a session credential valid for
 * `expirationSeconds`. Returns the metadata the reload path needs to know the
 * session is still alive — never the key.
 *
 * NOTE: the message construction is taken from Turnkey's own SDK, but has not
 * been exercised against the live API from here; it stays a manual-smoke
 * verification point.
 */
export async function otpLoginToSession(deps: {
  turnkey: TurnkeySessionApi;
  subOrgId: string;
  verificationToken: string;
  signer: SessionKeySigner;
  expirationSeconds?: number;
  now?: () => number;
}): Promise<{ session: string; meta: SigningSessionMeta }> {
  const { id: tokenId, public_key: boundPublicKey } = decodeVerificationToken(deps.verificationToken);
  const sessionPublicKey = boundPublicKey || deps.signer.publicKeyHex;
  const message = loginClientSignatureMessage(tokenId, sessionPublicKey);
  const expirationSeconds = deps.expirationSeconds ?? SESSION_EXPIRATION_SECONDS;
  const clientSignature: ClientSignature = {
    publicKey: sessionPublicKey,
    scheme: 'CLIENT_SIGNATURE_SCHEME_API_P256',
    message,
    signature: await deps.signer.sign(message),
  };
  const requestedAt = (deps.now ?? Date.now)();
  const { session } = await deps.turnkey.otpLogin({
    organizationId: deps.subOrgId,
    verificationToken: deps.verificationToken,
    publicKey: sessionPublicKey,
    clientSignature,
    expirationSeconds: String(expirationSeconds),
  });
  return {
    session,
    meta: {
      subOrgId: deps.subOrgId,
      publicKey: sessionPublicKey,
      expiresAt: requestedAt + expirationSeconds * 1000,
    },
  };
}

/** Is this session still safe to sign with? Fail-closed on anything unknown. */
export function signingStatus(meta: SigningSessionMeta | null, now: number = Date.now()): SigningStatus {
  if (!meta) return 'none';
  return meta.expiresAt - SESSION_EXPIRY_MARGIN_MS > now ? 'active' : 'expired';
}

/**
 * What a page load should do with what it found. Split out from the React
 * provider so the reload path — the one that used to leave a user
 * authenticated-but-unable-to-sign — is testable on its own.
 *
 * `browserPublicKey` is the key this browser actually holds in IndexedDB.
 * A mismatch means the stored session belongs to a credential this browser no
 * longer has, so it is not restorable: fail closed rather than hand the user a
 * signing client that Turnkey will reject.
 */
export type RestoreDecision = 'restore' | 'expired' | 'none';

export function restoreDecision(
  meta: SigningSessionMeta | null,
  browserPublicKey: string | null,
  now: number = Date.now()
): RestoreDecision {
  const status = signingStatus(meta, now);
  if (status !== 'active' || !meta) return status === 'expired' ? 'expired' : 'none';
  return browserPublicKey === meta.publicKey ? 'restore' : 'none';
}

/** Persist the session's non-secret metadata so a reload can tell it is alive. */
export function writeSessionMeta(storage: Storage, meta: SigningSessionMeta): void {
  const { subOrgId, publicKey, expiresAt } = meta;
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ subOrgId, publicKey, expiresAt }));
}

/**
 * Read back a session for `subOrgId`. Anything malformed, or belonging to
 * another account, reads as absent — a reload must never throw its way out of
 * restoring, and must never hand one account another's credential.
 */
export function readSessionMeta(storage: Storage, subOrgId: string): SigningSessionMeta | null {
  const raw = storage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SigningSessionMeta>;
    if (parsed.subOrgId !== subOrgId) return null;
    if (typeof parsed.publicKey !== 'string' || typeof parsed.expiresAt !== 'number') return null;
    return { subOrgId, publicKey: parsed.publicKey, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export function clearSessionMeta(storage: Storage): void {
  storage.removeItem(SESSION_STORAGE_KEY);
}

/** The Turnkey surface sign-out needs to revoke the installed session key. */
export interface TurnkeyRevocationApi {
  getWhoami(params: { organizationId: string }): Promise<{ userId: string }>;
  getApiKeys(params: { organizationId: string; userId: string }): Promise<{
    apiKeys: Array<{ apiKeyId: string; credential?: { publicKey?: string } }>;
  }>;
  deleteApiKeys(params: {
    organizationId: string;
    userId: string;
    apiKeyIds: string[];
  }): Promise<unknown>;
}

export type RevocationOutcome = 'revoked' | 'not-found' | 'revoke-failed';

/**
 * Delete the expiring API key OTP_LOGIN installed, so sign-out ends signing at
 * Turnkey and not just in this tab. Never throws: the caller must erase the
 * local key either way, and a failure is a named state the UI can show.
 */
export async function revokeSessionKey(
  api: TurnkeyRevocationApi,
  meta: SigningSessionMeta
): Promise<RevocationOutcome> {
  try {
    const { userId } = await api.getWhoami({ organizationId: meta.subOrgId });
    const { apiKeys } = await api.getApiKeys({ organizationId: meta.subOrgId, userId });
    const match = apiKeys.find((k) => k.credential?.publicKey === meta.publicKey);
    if (!match) return 'not-found';
    await api.deleteApiKeys({ organizationId: meta.subOrgId, userId, apiKeyIds: [match.apiKeyId] });
    return 'revoked';
  } catch {
    return 'revoke-failed';
  }
}

/**
 * Ensure the user's wallet has a P2WPKH account for the given network and
 * return its bech32 address (tb1… on testnet4, bc1… on mainnet). Idempotent:
 * if the path already exists, the cached address wins — re-creating would
 * waste an activity and could error on a duplicate path.
 */
export async function ensureBitcoinFundingAccount(
  client: TurnkeyBitcoinClient,
  subOrgId: string,
  network: FundingNetwork = 'testnet4'
): Promise<string> {
  const account = P2WPKH_ACCOUNTS[network];
  const { wallets } = await client.getWallets({ organizationId: subOrgId });
  const wallet = wallets[0];
  if (!wallet) throw new Error('No Turnkey wallet found for the sub-organization.');
  const existing = wallet.accounts?.find((a) => a.path === account.path);
  if (existing?.address) return existing.address;
  const { addresses } = await client.createWalletAccounts({
    walletId: wallet.walletId,
    organizationId: subOrgId,
    accounts: [
      {
        curve: 'CURVE_SECP256K1',
        pathFormat: 'PATH_FORMAT_BIP32',
        path: account.path,
        addressFormat: account.addressFormat,
      },
    ],
  });
  const address = addresses[0];
  if (!address || !address.startsWith(account.prefix)) {
    throw new Error(`Turnkey returned an unexpected funding address: ${String(address)}`);
  }
  return address;
}
