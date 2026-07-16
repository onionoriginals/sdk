import { describe, it, expect } from 'bun:test';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';

describe('OrdMockProvider.getFirstSatOfOutput', () => {
  it('returns a deterministic, valid sat number for an outpoint', async () => {
    const p = new OrdMockProvider();
    const a = await p.getFirstSatOfOutput({ txid: 'aa'.repeat(32), vout: 0 });
    const b = await p.getFirstSatOfOutput({ txid: 'aa'.repeat(32), vout: 0 });
    expect(a).toBe(b);                       // deterministic
    expect(/^[0-9]+$/.test(a)).toBe(true);   // integer sat string
  });

  it('gives different outputs different sats', async () => {
    const p = new OrdMockProvider();
    const a = await p.getFirstSatOfOutput({ txid: 'aa'.repeat(32), vout: 0 });
    const b = await p.getFirstSatOfOutput({ txid: 'aa'.repeat(32), vout: 1 });
    expect(a).not.toBe(b);
  });
});
