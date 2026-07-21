/**
 * Track B enablement flag — a standalone, dependency-free module so components
 * (e.g. Demo.tsx) can read it WITHOUT statically importing the heavy engine
 * module, which would defeat the engine chunk's lazy-loading (first-paint perf).
 *
 * Enabled only when the deploy sets VITE_BTC_TESTNET=1 (server has
 * QUICKNODE_ENDPOINT + a faucet Turnkey wallet). Absent → the inscribe step is
 * the self-contained OrdMockProvider mock.
 */
export function btcTestnetEnabled(): boolean {
  return (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_BTC_TESTNET === '1';
}
