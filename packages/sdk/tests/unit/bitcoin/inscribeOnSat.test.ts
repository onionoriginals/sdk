import { describe, it, expect, mock } from 'bun:test';
import { inscribeOnSat } from '../../../src/bitcoin/inscribe-on-sat';
import { sampleUtxo, sampleChangeAddress } from '../../fixtures/bitcoin';

function providerDouble(overrides: any = {}) {
  return {
    getFirstSatOfOutput: async () => '1250000000',
    broadcastTransaction: async () => 'cc'.repeat(32),
    getInscriptionById: async (id: string) => ({ inscriptionId: id, satoshi: '1250000000' }),
    ...overrides
  } as any;
}
const signer = { signCommitPsbt: async (p: string) => p, getFundingAddress: () => sampleChangeAddress };
const buildContent = async (sat: string) => ({ content: Buffer.from(`doc for ${sat}`), contentType: 'application/did+json' });

describe('inscribeOnSat', () => {
  it('derives the sat from the provider and returns it as the DID sat', async () => {
    const res = await inscribeOnSat({
      buildContent, fundingUtxo: sampleUtxo, satSigner: signer,
      changeAddress: sampleChangeAddress, feeRate: 2, network: 'regtest', provider: providerDouble()
    });
    expect(res.satoshi).toBe('1250000000');
    expect(res.inscriptionId).toMatch(/i0$/);
  });

  it('fails closed with SAT_MISMATCH when the landed sat differs from the derived sat', async () => {
    const provider = providerDouble({ getInscriptionById: async (id: string) => ({ inscriptionId: id, satoshi: '9999' }) });
    await expect(inscribeOnSat({
      buildContent, fundingUtxo: sampleUtxo, satSigner: signer,
      changeAddress: sampleChangeAddress, feeRate: 2, network: 'regtest', provider
    })).rejects.toThrow(/SAT_MISMATCH/);
  });

  it('throws SAT_INDEX_UNSUPPORTED when the provider lacks getFirstSatOfOutput', async () => {
    const provider = providerDouble({ getFirstSatOfOutput: undefined });
    await expect(inscribeOnSat({
      buildContent, fundingUtxo: sampleUtxo, satSigner: signer,
      changeAddress: sampleChangeAddress, feeRate: 2, network: 'regtest', provider
    })).rejects.toThrow(/SAT_INDEX_UNSUPPORTED/);
  });

  it('calls the signer with the COMMIT psbt, not the reveal', async () => {
    const signCommitPsbt = mock(async (p: string) => p);
    await inscribeOnSat({
      buildContent, fundingUtxo: sampleUtxo, satSigner: { signCommitPsbt, getFundingAddress: () => sampleChangeAddress },
      changeAddress: sampleChangeAddress, feeRate: 2, network: 'regtest', provider: providerDouble()
    });
    expect(signCommitPsbt).toHaveBeenCalledTimes(1);
  });
});
