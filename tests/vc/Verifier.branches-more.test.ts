import { Verifier } from '../../src/vc/Verifier';
import { DIDManager } from '../../src/did/DIDManager';

describe('Verifier additional error branches', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential invalid input missing type', async () => {
    const res = await verifier.verifyCredential({ '@context': ['x'], proof: {} } as any);
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation invalid input missing type', async () => {
    const res = await verifier.verifyPresentation({ '@context': ['x'], proof: {} } as any);
    expect(res.verified).toBe(false);
  });
});

