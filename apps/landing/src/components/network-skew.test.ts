/**
 * The config-skew guard. VITE_BTC_NETWORK is baked into the bundle at build
 * time; BTC_NETWORK is read by the server at runtime. Nothing but this check
 * couples them, and a skew is not cosmetic — it would print a mainnet deposit
 * address on a deploy whose server can never spend from it.
 */
import { describe, test, expect } from 'bun:test';
import { expectedServerNetwork, fetchServerNetwork, networkSkewDetected } from './Demo';

const respond = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('expectedServerNetwork', () => {
  test('maps the browser flag onto the server network it requires', () => {
    expect(expectedServerNetwork('mainnet')).toBe('mainnet');
    // The browser calls it 'testnet4'; the server calls the same chain 'testnet'.
    expect(expectedServerNetwork('testnet4')).toBe('testnet');
    expect(expectedServerNetwork('off')).toBe('off');
  });
});

describe('fetchServerNetwork', () => {
  test('reads the network the server reports', async () => {
    expect(await fetchServerNetwork(respond(200, { network: 'mainnet' }))).toBe('mainnet');
    expect(await fetchServerNetwork(respond(200, { network: 'testnet' }))).toBe('testnet');
  });

  test('a 404 means the Bitcoin routes are not mounted at all → off', async () => {
    expect(await fetchServerNetwork(respond(404, { error: 'Not found' }))).toBe('off');
  });

  test('fails closed to off when the server is unreachable or nonsensical', async () => {
    const boom = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await fetchServerNetwork(boom)).toBe('off');
    expect(await fetchServerNetwork(respond(200, { network: 'regtest' }))).toBe('off');
  });

  test('a build/runtime skew is detectable in both directions', async () => {
    // Client built for mainnet, server left on the testnet4 default: the
    // dangerous direction — real BTC to an address this deploy cannot spend.
    const server = await fetchServerNetwork(respond(200, { network: 'testnet' }));
    expect(server === expectedServerNetwork('mainnet')).toBe(false);
    // And the reverse.
    const server2 = await fetchServerNetwork(respond(200, { network: 'mainnet' }));
    expect(server2 === expectedServerNetwork('testnet4')).toBe(false);
    // Matching config is not flagged.
    expect(server2 === expectedServerNetwork('mainnet')).toBe(true);
  });
});

/**
 * U6 / R11 — the comparison is UNCONDITIONAL. It used to run only when the
 * browser already believed it was on a real network, which made the
 * client-off direction (a mainnet deploy serving a mock site) invisible — and
 * after U2 an anonymous visitor never reached it at all.
 */
describe('networkSkewDetected', () => {
  test('a matching pair is never a skew', () => {
    expect(networkSkewDetected('mainnet', 'mainnet')).toBe(false);
    expect(networkSkewDetected('testnet4', 'testnet')).toBe(false);
    expect(networkSkewDetected('off', 'off')).toBe(false);
  });

  test('the dangerous direction: a real build against another chain', () => {
    expect(networkSkewDetected('mainnet', 'testnet')).toBe(true);
    expect(networkSkewDetected('testnet4', 'mainnet')).toBe(true);
    // A real build whose server mounted no Bitcoin routes at all.
    expect(networkSkewDetected('mainnet', 'off')).toBe(true);
  });

  test('the silent direction: a build with the flag off against a real server', () => {
    expect(networkSkewDetected('off', 'mainnet')).toBe(true);
    expect(networkSkewDetected('off', 'testnet')).toBe(true);
  });

  test('an unresolved server network is not a mismatch', () => {
    expect(networkSkewDetected('mainnet', null)).toBe(false);
    expect(networkSkewDetected('off', null)).toBe(false);
  });
});
