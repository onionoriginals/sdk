import { DIDManager } from '../../src/did/DIDManager';

describe('DIDManager.validateDIDDocument false branch', () => {
  test('returns false when context missing', () => {
    const dm = new DIDManager({} as any);
    const res = dm.validateDIDDocument({ id: 'did:peer:xyz' } as any);
    expect(res).toBe(false);
  });
});

