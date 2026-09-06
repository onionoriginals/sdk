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
 * A handle to the session key. `signDer` takes the exact request body and
 * returns a DER-encoded hex signature — the encoding Turnkey's attested stamp
 * carries. The caller can never obtain the private key, because a
 * non-extractable CryptoKey has none to give.
 */
export interface SessionKeySigner {
  /** Compressed P-256 public key hex. */
  publicKeyHex: string;
  signDer(payload: string): Promise<string>;
}

/** The Bitcoin-signing + account surface the rest of Track B consumes. */
export interface TurnkeyBitcoinClient {
  signTransaction(params: {
    signWith: string;
    unsignedTransaction: string;
    type: 'TRANSACTION_TYPE_BITCOIN';
  }): Promise<{ signedTransaction: string }>;
  /**
   * Raw byte signing — the Ed25519 half of this client, used to author CEL
   * events (see ../sdk/turnkey-cel-signer). Optional because the pure test
   * doubles for the Bitcoin paths have no reason to implement it; anything
   * that needs it checks first and says so rather than throwing at sign time.
   */
  signRawPayload?(params: {
    organizationId: string;
    signWith: string;
    payload: string;
    encoding: 'PAYLOAD_ENCODING_HEXADECIMAL';
    // Ed25519 only. NO_OP is rejected by Turnkey for this curve.
    hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE';
  }): Promise<unknown>;
  createWalletAccounts(params: {
    walletId: string;
    organizationId: string;
    accounts: Array<{
      curve: 'CURVE_SECP256K1' | 'CURVE_ED25519';
      pathFormat: 'PATH_FORMAT_BIP32';
      path: string;
      addressFormat:
        | 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH'
        | 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH'
        | 'ADDRESS_FORMAT_SOLANA';
    }>;
  }): Promise<{ addresses: string[] }>;
  /**
   * Wallet METADATA only. Turnkey's `v1Wallet` carries no accounts — listing
   * them is a separate call, and assuming otherwise is what made the funding
   * account re-create itself on every sign-in.
   */
  getWallets(params: { organizationId: string }): Promise<{
    wallets: Array<{ walletId: string }>;
  }>;
  /** The accounts themselves. `walletId` is optional; omitted = the whole org. */
  getWalletAccounts(params: { organizationId: string; walletId?: string }): Promise<{
    accounts: Array<{ address: string; path: string; addressFormat?: string }>;
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
 * Turnkey's ATTESTED stamp: how a request is authenticated for an org that
 * holds no credential yet.
 *
 * This is the crux of the whole bootstrap. Straight after verify-otp the
 * sub-org has NO registered key — the browser's key is exactly what login is
 * about to install. So the request cannot be stamped the ordinary way: signing
 * it with the browser key makes Turnkey answer
 * `PUBLIC_KEY_NOT_FOUND` ("could not find public key in organization"), which
 * is precisely what it did. The credential does not exist yet; that is the
 * point of logging in.
 *
 * The attested stamp resolves the circularity by presenting the verification
 * token — which Turnkey itself issued and signed at verify-otp — as the
 * attestation, alongside a signature proving the caller holds the key that
 * token was bound to.
 *
 * Mirrors `AttestedStamper` in @turnkey/core exactly, which is unpublished as
 * a standalone package. Reproduced rather than depended on because
 * @turnkey/core pulls ethers, viem and WalletConnect into a landing bundle.
 */
export const ATTESTED_STAMP_HEADER = 'X-Stamp-Attested';
export const ATTESTED_SCHEME_VERIFICATION_TOKEN = 'STAMP_ATTESTED_SCHEME_P256_VERIFICATION_TOKEN';

/** Turnkey's own endpoint and activity for exchanging that stamp for a session. */
export const TURNKEY_API_BASE_URL = 'https://api.turnkey.com';
export const STAMP_LOGIN_PATH = '/public/v1/submit/stamp_login';
export const STAMP_LOGIN_ACTIVITY = 'ACTIVITY_TYPE_STAMP_LOGIN';

/**
 * String → base64url. Mirrors `stringToBase64urlString` in @turnkey/encoding:
 * `btoa` over the raw string, then URL-safe, then padding STRIPPED. Turnkey
 * verifies the stamp byte-for-byte, so each of those three steps matters.
 * `btoa` (not TextEncoder) is deliberate — it is what Turnkey calls, and the
 * stamp JSON is ASCII, so the two agree.
 */
export function encodeBase64Url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** The `X-Stamp-Attested` header value for a request body. */
export function attestedStampValue(opts: {
  verificationToken: string;
  publicKey: string;
  signature: string;
}): string {
  // Field order is Turnkey's. The value is a JSON blob it parses, not a
  // signature input, but keeping the order identical keeps the diff against
  // their implementation readable.
  return encodeBase64Url(
    JSON.stringify({
      publicKeyAttestation: opts.verificationToken,
      scheme: ATTESTED_SCHEME_VERIFICATION_TOKEN,
      publicKey: opts.publicKey,
      signature: opts.signature,
    })
  );
}

/**
 * The STAMP_LOGIN request body, as the exact string that is BOTH signed and
 * sent. Re-serialising it after signing would risk a different byte sequence
 * and an invalid stamp, so callers must send this string verbatim.
 */
export function stampLoginBody(opts: {
  subOrgId: string;
  publicKey: string;
  expirationSeconds: number;
  timestampMs: number;
}): string {
  return JSON.stringify({
    type: STAMP_LOGIN_ACTIVITY,
    timestampMs: String(opts.timestampMs),
    organizationId: opts.subOrgId,
    parameters: {
      publicKey: opts.publicKey,
      expirationSeconds: String(opts.expirationSeconds),
    },
  });
}

/** What Turnkey answers with. Only the completed shape carries a session. */
interface StampLoginResponse {
  activity?: {
    status?: string;
    result?: { stampLoginResult?: { session?: string } };
  };
  message?: string;
}

/**
 * Exchange the verification token for a signing session (STAMP_LOGIN).
 *
 * This is the flow @turnkey/core runs for a credential-less sub-org: configure
 * an attested stamper from the verification token, then call stamp_login. It
 * does NOT call the otp_login activity, and neither do we — an ordinary stamp
 * there is unauthenticatable for the reason described above.
 *
 * Returns the metadata the reload path needs to know the session is alive —
 * never the key.
 */
export async function stampLoginToSession(deps: {
  verificationToken: string;
  subOrgId: string;
  signer: SessionKeySigner;
  expirationSeconds?: number;
  now?: () => number;
  fetchFn?: typeof fetch;
  apiBaseUrl?: string;
}): Promise<{ session: string; meta: SigningSessionMeta }> {
  const { public_key: boundPublicKey } = decodeVerificationToken(deps.verificationToken);
  // The token's bound key IS the browser's key (verify-otp bound it to exactly
  // that), and it is the key the stamp attests to. Prefer the token's copy:
  // Turnkey checks the stamp against the token, not against our belief.
  const publicKey = boundPublicKey || deps.signer.publicKeyHex;
  const expirationSeconds = deps.expirationSeconds ?? SESSION_EXPIRATION_SECONDS;
  const requestedAt = (deps.now ?? Date.now)();

  const body = stampLoginBody({
    subOrgId: deps.subOrgId,
    publicKey,
    expirationSeconds,
    timestampMs: requestedAt,
  });
  const signature = await deps.signer.signDer(body);
  const stamp = attestedStampValue({ verificationToken: deps.verificationToken, publicKey, signature });

  const doFetch = deps.fetchFn ?? fetch;
  const res = await doFetch(`${deps.apiBaseUrl ?? TURNKEY_API_BASE_URL}${STAMP_LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [ATTESTED_STAMP_HEADER]: stamp },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as StampLoginResponse;
  if (!res.ok) {
    // Carry Turnkey's own words. The previous failure was legible only because
    // its message named the cause; a generic status code would not have been.
    throw new Error(`STAMP_LOGIN failed (${res.status}): ${json.message ?? 'no message'}`);
  }
  const status = json.activity?.status;
  if (status !== 'ACTIVITY_STATUS_COMPLETED') {
    throw new Error(`STAMP_LOGIN did not complete: ${status ?? 'no activity status'}`);
  }
  const session = json.activity?.result?.stampLoginResult?.session;
  if (!session) throw new Error('STAMP_LOGIN completed without returning a session');

  return {
    session,
    meta: {
      subOrgId: deps.subOrgId,
      publicKey,
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
 * return its bech32 address (tb1… on testnet4, bc1… on mainnet).
 *
 * Genuinely idempotent, which it previously only claimed to be. The lookup
 * used to read `wallet.accounts` off `getWallets`, and Turnkey's `v1Wallet`
 * has no such field — so it was always undefined, the account was never found,
 * and every sign-in after the first tried to create a path that already
 * existed and failed with `code 6: path already exists in wallet account`.
 * Accounts come from `getWalletAccounts`.
 *
 * The address is derived from a fixed BIP-32 path, so re-reading an existing
 * account always yields the same address a previous run created — which
 * matters, because a creator may already have BTC sitting at it.
 */
export async function ensureBitcoinFundingAccount(
  client: TurnkeyBitcoinClient,
  subOrgId: string,
  network: FundingNetwork = 'testnet4'
): Promise<string> {
  const account = P2WPKH_ACCOUNTS[network];

  const findExisting = async (): Promise<string | undefined> => {
    const { accounts } = await client.getWalletAccounts({ organizationId: subOrgId });
    return accounts?.find((a) => a.path === account.path)?.address;
  };

  const already = await findExisting();
  if (already) return verifyFundingAddress(already, account.prefix);

  const { wallets } = await client.getWallets({ organizationId: subOrgId });
  const wallet = wallets[0];
  if (!wallet) throw new Error('No Turnkey wallet found for the sub-organization.');

  let addresses: string[];
  try {
    ({ addresses } = await client.createWalletAccounts({
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
    }));
  } catch (err) {
    // Belt and braces: the read above should have found it, but a paginated
    // or eventually-consistent listing could miss one. Turnkey telling us the
    // path exists is itself proof the account is there, so re-read rather than
    // surfacing a failure for a thing that already succeeded.
    if (!/already exists/i.test(String((err as Error)?.message ?? err))) throw err;
    const recovered = await findExisting();
    if (!recovered) throw err;
    return verifyFundingAddress(recovered, account.prefix);
  }

  return verifyFundingAddress(addresses[0], account.prefix);
}

/**
 * A mainnet path must not hand back a testnet address, or vice versa. Applied
 * to a re-read account as well as a freshly created one: this is the last
 * checkpoint before a stranger is told where to send BTC.
 */
function verifyFundingAddress(address: string | undefined, prefix: string): string {
  if (!address || !address.startsWith(prefix)) {
    throw new Error(`Turnkey returned an unexpected funding address: ${String(address)}`);
  }
  return address;
}

/**
 * `turnkeySignBytes` expects the server SDK's shape (`client.apiClient()`),
 * while the browser's IndexedDB client exposes `signRawPayload` directly. Both
 * Ed25519 signers (CEL events, did:webvh) need this same wrap, so it lives here
 * with the client interface rather than being re-declared beside each of them.
 * Type-only import: erased at runtime, so this module stays dependency-free.
 */
export function asTurnkeyApiClient(client: TurnkeyBitcoinClient): import('@turnkey/sdk-server').Turnkey {
  return { apiClient: () => client } as unknown as import('@turnkey/sdk-server').Turnkey;
}

/* ——— The authorship account (Ed25519, Turnkey-held) ——————————————————— */

/**
 * The Turnkey account whose key signs an Original's CEL events.
 *
 * Ed25519 because CEL is Ed25519-only, and Turnkey-held rather than
 * browser-held because an Original that can only be finished in the browser
 * that started it is the gap this exists to close: a key in Turnkey comes back
 * with the session, on any device.
 *
 * Turnkey reports an Ed25519 account in Solana's address format, which IS the
 * raw 32-byte public key in base58 — see `authorshipPublicKeyMultibase`. The
 * path is fixed so re-reading always yields the same key: an Original's
 * controller identity must not move under it.
 */
export const AUTHORSHIP_ACCOUNT = {
  curve: 'CURVE_ED25519',
  pathFormat: 'PATH_FORMAT_BIP32',
  path: "m/44'/501'/0'/0'",
  addressFormat: 'ADDRESS_FORMAT_SOLANA',
} as const;

/**
 * The Turnkey account whose key signs the user's OWN did:webvh — a DIFFERENT
 * key from AUTHORSHIP_ACCOUNT, at its own path, on purpose. Identity update
 * authority (the DID's `updateKeys`) and per-Original authorship are separate
 * powers; one key holding both means rotating either one rewrites the other.
 */
export const IDENTITY_ACCOUNT = {
  curve: 'CURVE_ED25519',
  pathFormat: 'PATH_FORMAT_BIP32',
  path: "m/44'/501'/1'/0'",
  addressFormat: 'ADDRESS_FORMAT_SOLANA',
} as const;

/** The Ed25519 account specs this app provisions. */
export type Ed25519AccountSpec = typeof AUTHORSHIP_ACCOUNT | typeof IDENTITY_ACCOUNT;

/**
 * The sub-org's authorship account address, creating it if this wallet has
 * none. Mirrors `ensureBitcoinFundingAccount`: read by path first, create only
 * on a miss, and treat Turnkey's "already exists" as proof to re-read rather
 * than as a failure.
 */
export async function ensureAuthorshipAccount(
  client: TurnkeyBitcoinClient,
  subOrgId: string
): Promise<string> {
  return ensureEd25519Account(client, subOrgId, AUTHORSHIP_ACCOUNT);
}

/** The sub-org's identity account address — same contract, its own path. */
export async function ensureIdentityAccount(
  client: TurnkeyBitcoinClient,
  subOrgId: string
): Promise<string> {
  return ensureEd25519Account(client, subOrgId, IDENTITY_ACCOUNT);
}

async function ensureEd25519Account(
  client: TurnkeyBitcoinClient,
  subOrgId: string,
  spec: Ed25519AccountSpec
): Promise<string> {
  const findExisting = async (): Promise<string | undefined> => {
    const { accounts } = await client.getWalletAccounts({ organizationId: subOrgId });
    return accounts?.find((a) => a.path === spec.path)?.address;
  };

  const already = await findExisting();
  if (already) return already;

  const { wallets } = await client.getWallets({ organizationId: subOrgId });
  const wallet = wallets[0];
  if (!wallet) throw new Error('No Turnkey wallet found for the sub-organization.');

  let addresses: string[];
  try {
    ({ addresses } = await client.createWalletAccounts({
      walletId: wallet.walletId,
      organizationId: subOrgId,
      accounts: [{ ...spec }],
    }));
  } catch (err) {
    if (!/already exists/i.test(String((err as Error)?.message ?? err))) throw err;
    const recovered = await findExisting();
    if (!recovered) throw err;
    return recovered;
  }

  const address = addresses[0];
  if (!address) throw new Error(`Turnkey returned no address for account path ${spec.path}.`);
  return address;
}
