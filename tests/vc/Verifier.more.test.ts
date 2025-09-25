import { Verifier } from '../../src/vc/Verifier';
import { DIDManager } from '../../src/did/DIDManager';

describe('Verifier branches', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential returns error on invalid vc', async () => {
    const res = await verifier.verifyCredential({} as any);
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation returns error on invalid vp', async () => {
    const res = await verifier.verifyPresentation({} as any);
    expect(res.verified).toBe(false);
  });
});

