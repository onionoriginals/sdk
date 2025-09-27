import { LifecycleManager } from '../../src/lifecycle/LifecycleManager';
import { DIDManager } from '../../src/did/DIDManager';
import { CredentialManager } from '../../src/vc/CredentialManager';

const dummyConfig: any = {};
const didManager = new DIDManager(dummyConfig as any);
const credentialManager = new CredentialManager(dummyConfig as any);
const lm = new LifecycleManager(dummyConfig as any, didManager, credentialManager);

describe('LifecycleManager additional branches', () => {
  test('publishToWeb throws when currentLayer is not did:peer', async () => {
    const asset: any = { currentLayer: 'did:webvh', migrate: async () => {} };
    await expect(lm.publishToWeb(asset, 'example.com')).rejects.toThrow();
  });

  test('inscribeOnBitcoin throws for invalid layer', async () => {
    const asset: any = { currentLayer: 'did:wrong', migrate: async () => {} };
    await expect(lm.inscribeOnBitcoin(asset)).rejects.toThrow('Not implemented');
  });
});

