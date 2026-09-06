import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createOrdinalsProviderFromEnv } from '../../../src/adapters/providers/OrdHttpProvider';
import { RegtestProvider } from '../../../src/adapters/providers/RegtestProvider';

const keys = ['BTC_NETWORK', 'REGTEST_RPC_URL', 'REGTEST_ORD_URL', 'REGTEST_RPC_AUTH', 'QUICKNODE_ENDPOINT'] as const;
let saved: Array<string | undefined>;
beforeEach(() => {
  saved = keys.map(key => process.env[key]);
  for (const key of keys) delete process.env[key];
});
afterEach(() => keys.forEach((key, index) => {
  if (saved[index] === undefined) delete process.env[key];
  else process.env[key] = saved[index];
}));
function configure() {
  process.env.BTC_NETWORK = 'regtest';
  process.env.REGTEST_RPC_URL = 'http://127.0.0.1:18443';
  process.env.REGTEST_ORD_URL = 'http://127.0.0.1:8080';
  process.env.REGTEST_RPC_AUTH = 'test:local';
}
test('the explicit regtest profile wins over a public provider setting', async () => {
  configure();
  process.env.QUICKNODE_ENDPOINT = 'https://example.com';
  expect(await createOrdinalsProviderFromEnv({ network: 'regtest' })).toBeInstanceOf(RegtestProvider);
});
test('incomplete regtest configuration cannot fall back to mock or public providers', async () => {
  process.env.BTC_NETWORK = 'regtest';
  await expect(createOrdinalsProviderFromEnv()).rejects.toThrow('Regtest requires');
  delete process.env.BTC_NETWORK;
  process.env.REGTEST_ORD_URL = 'http://127.0.0.1:8080';
  await expect(createOrdinalsProviderFromEnv()).rejects.toThrow('Regtest requires');
});
test('the local profile cannot be selected for a different SDK network', async () => {
  configure();
  await expect(createOrdinalsProviderFromEnv({ network: 'mainnet' })).rejects.toThrow('cannot serve another network');
});
