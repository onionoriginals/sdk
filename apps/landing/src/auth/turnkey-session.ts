/**
 * Turnkey session helpers for Track B (testnet4 signing).
 *
 * After OTP verify, the sub-org is credential-less: the parent Turnkey key
 * can't sign for it and there is no passkey. OTP_LOGIN installs the browser's
 * P-256 key as the session credential, after which the user's Bitcoin signing
 * (signTransaction) is silent within the session window. These helpers are
 * pure (no @turnkey/sdk-browser import) so they run under `bun test`; the
 * concrete browser client lives in ./turnkey-browser-client.
 */
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';

/** The single OTP_LOGIN activity the session bootstrap needs. */
export interface TurnkeySessionApi {
  otpLogin(params: {
    organizationId: string;
    verificationToken: string;
    publicKey: string;
    clientSignature: string;
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
      addressFormat: 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH';
    }>;
  }): Promise<{ addresses: string[] }>;
  getWallets(params: { organizationId: string }): Promise<{
    wallets: Array<{ walletId: string; accounts?: Array<{ address: string; path?: string }> }>;
  }>;
}

const TESTNET_P2WPKH_PATH = "m/84'/1'/0'/0/0";

/**
 * Run OTP_LOGIN: sign the login challenge (the verificationToken) with the
 * browser P-256 key and exchange it for a session credential. We sign SHA-256
 * of the verificationToken bytes with the API-P256 scheme (low-S DER), the
 * encoding ApiKeyStamper uses. NOTE: the exact challenge Turnkey expects is a
 * manual-smoke verification point (Resolved fact #7); the automated test only
 * asserts a non-empty clientSignature is produced and passed through.
 */
export async function otpLoginToSession(deps: {
  turnkey: TurnkeySessionApi;
  subOrgId: string;
  verificationToken: string;
  p256PublicKey: string;
  p256PrivateKey: string;
  expirationSeconds?: number;
}): Promise<{ session: string }> {
  const challenge = sha256(new TextEncoder().encode(deps.verificationToken));
  const sig = p256.sign(challenge, hex.decode(deps.p256PrivateKey), { lowS: true, format: 'der' });
  const clientSignature = hex.encode(sig);
  const { session } = await deps.turnkey.otpLogin({
    organizationId: deps.subOrgId,
    verificationToken: deps.verificationToken,
    publicKey: deps.p256PublicKey,
    clientSignature,
    expirationSeconds: String(deps.expirationSeconds ?? 900),
  });
  return { session };
}

/**
 * Ensure the user's wallet has a testnet4 P2WPKH account and return its tb1
 * address. Idempotent: if the path already exists, the cached address wins —
 * re-creating would waste an activity and could error on a duplicate path.
 */
export async function ensureBitcoinFundingAccount(
  client: TurnkeyBitcoinClient,
  subOrgId: string
): Promise<string> {
  const { wallets } = await client.getWallets({ organizationId: subOrgId });
  const wallet = wallets[0];
  if (!wallet) throw new Error('No Turnkey wallet found for the sub-organization.');
  const existing = wallet.accounts?.find((a) => a.path === TESTNET_P2WPKH_PATH);
  if (existing?.address) return existing.address;
  const { addresses } = await client.createWalletAccounts({
    walletId: wallet.walletId,
    organizationId: subOrgId,
    accounts: [
      {
        curve: 'CURVE_SECP256K1',
        pathFormat: 'PATH_FORMAT_BIP32',
        path: TESTNET_P2WPKH_PATH,
        addressFormat: 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH',
      },
    ],
  });
  const address = addresses[0];
  if (!address || !address.startsWith('tb1')) {
    throw new Error(`Turnkey returned an unexpected funding address: ${String(address)}`);
  }
  return address;
}
