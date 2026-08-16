// @aviarytech/did-peer ships no types; only the legacy did:peer:4 read path
// in verifyEventLog loads it (lazily), so shim just what that path calls.
declare module '@aviarytech/did-peer' {
  export function resolve(did: string, repository?: Record<string, unknown>): Promise<Record<string, unknown>>;
}
