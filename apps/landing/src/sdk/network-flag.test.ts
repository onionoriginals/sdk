import { describe, test, expect } from 'bun:test';
import { btcNetwork, btcRealEnabled } from './network-flag';

// import.meta.env is not writable per-test under bun, so these tests assert
// the UNSET default (this test env sets neither VITE_BTC_NETWORK nor the
// legacy VITE_BTC_TESTNET): the flag must resolve to 'off' / mock.
describe('network flag', () => {
  test('defaults to off (mock) when no env is set', () => {
    expect(btcNetwork()).toBe('off');
    expect(btcRealEnabled()).toBe(false);
  });
});
