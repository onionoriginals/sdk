/**
 * The concrete browser Turnkey client for Track B signing. Isolated from
 * ./turnkey-session (which stays pure/testable) because @turnkey/sdk-browser
 * pulls a browser-only dependency graph that must not load under `bun test`.
 *
 * The stamper reuses the SAME P-256 keypair the OTP flow generated, so no new
 * credential is minted — OTP_LOGIN already installed that key on the sub-org.
 */
import { ApiKeyStamper } from '@turnkey/api-key-stamper';
import { TurnkeyBrowserClient } from '@turnkey/sdk-browser';
import type { TurnkeyBitcoinClient } from './turnkey-session';

export function buildBrowserSigningClient(opts: {
  subOrgId: string;
  p256PublicKey: string;
  p256PrivateKey: string;
  apiBaseUrl?: string;
}): TurnkeyBitcoinClient {
  const stamper = new ApiKeyStamper({
    apiPublicKey: opts.p256PublicKey,
    apiPrivateKey: opts.p256PrivateKey,
  });
  const client = new TurnkeyBrowserClient({
    stamper,
    apiBaseUrl: opts.apiBaseUrl ?? 'https://api.turnkey.com',
    organizationId: opts.subOrgId,
  } as unknown as ConstructorParameters<typeof TurnkeyBrowserClient>[0]);
  // TurnkeyBrowserClient exposes signTransaction / createWalletAccounts /
  // getWallets / otpLogin with these shapes; the cast pins the narrow surface.
  return client as unknown as TurnkeyBitcoinClient;
}
