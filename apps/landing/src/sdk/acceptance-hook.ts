/**
 * The page's engine for the hosted acceptance driver (#976 B, G9;
 * scripts/acceptance/hosted/browser-client.mjs), as `window.__originalsDemo`.
 * Only a staging acceptance build exposes it (`acceptanceBuild`: the switch
 * set, not the production host, not mainnet). Production never does.
 */
import { acceptanceBuild } from './features';

type Env = Record<string, string | undefined>;

const buildEnv = (): Env => (import.meta as unknown as { env?: Env }).env ?? {};

export function exposeAcceptanceEngine(engine: unknown, env: Env = buildEnv()): void {
  if (acceptanceBuild(env)) (globalThis as Record<string, unknown>).__originalsDemo = engine;
}

export function clearAcceptanceEngine(): void {
  delete (globalThis as Record<string, unknown>).__originalsDemo;
}
