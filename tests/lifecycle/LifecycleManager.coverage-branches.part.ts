import { LifecycleManager } from '../../src/lifecycle/LifecycleManager';
import { DIDManager } from '../../src/did/DIDManager';
import { CredentialManager } from '../../src/vc/CredentialManager';

describe('LifecycleManager additional branch coverage', () => {
  const lm = new LifecycleManager({ network: 'mainnet' } as any, new DIDManager({} as any), new CredentialManager({} as any));

  test('publishToWeb throws when migrate not a function', async () => {
    const asset: any = { currentLayer: 'did:peer' };
    await expect(lm.publishToWeb(asset, 'example.com')).rejects.toThrow('Not implemented');
  });
});

