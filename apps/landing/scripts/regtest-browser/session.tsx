/** Runner-only Vite alias. This module is never reachable from a production build.
 * Custody and an already-authenticated session are disposable local fixtures;
 * creator components, engine, SDK, signing adapters and HTTP routes remain real.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { TurnkeyBitcoinClient } from '../../src/auth/turnkey-session';

interface Session { subOrgId: string; email: string; fundingAddress: string; authorshipAddress: string; }
let session: Session;
let bitcoin: { fundingAddress: string; signingClient: TurnkeyBitcoinClient };
let user: { subOrgId: string; email: string };
async function fixture<T>(operation: string, params?: unknown): Promise<T> {
  const response = await fetch(`/__regtest/${operation}`, {
    credentials: 'same-origin',
    ...(params === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }),
  });
  if (!response.ok) throw new Error(`Local regtest fixture ${operation}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
const client: TurnkeyBitcoinClient = {
  signTransaction: params => fixture('sign-transaction', params),
  signRawPayload: params => fixture('sign-payload', params),
  async getWalletAccounts() {
    return { accounts: [{ address: session.authorshipAddress, path: "m/44'/501'/0'/0'" }] };
  },
  async getWallets() { return { wallets: [{ walletId: 'disposable-local-wallet' }] }; },
  async createWalletAccounts() { throw new Error('All fixture accounts must already exist'); },
};
export async function openSessionKey(subOrgId: string) {
  if (session?.subOrgId !== subOrgId) throw new Error('Local fixture account mismatch');
  return { client };
}
const Context = createContext(false);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => { void fixture<Session>('session').then(value => {
    session = value;
    bitcoin = { fundingAddress: value.fundingAddress, signingClient: client };
    user = { subOrgId: value.subOrgId, email: value.email };
    setReady(true);
  }); }, []);
  return <Context.Provider value={ready}>{children}</Context.Provider>;
}
const unsupported = async (): Promise<never> => { throw new Error('OTP and production custody are outside the disposable regtest fixture'); };
export function useAuth() {
  const ready = useContext(Context);
  return {
    user: ready ? user : null,
    isAuthenticated: ready, isLoading: !ready, sessionId: null,
    bitcoin: ready ? bitcoin : null,
    signing: ready ? 'active' as const : 'none' as const,
    reauth: { active: false, fromSubOrgId: null }, signOutNotice: null, signingNotice: null,
    startOtp: unsupported, verify: unsupported, createIdentity: unsupported,
    loadIdentity: async () => null, signOut: unsupported, beginReauth: unsupported,
    cancelReauth() {},
  };
}
