import { describe, test, expect } from 'bun:test';
import { OrdNodeProvider } from '../../../src/bitcoin/providers/OrdNodeProvider';
import { StructuredError } from '../../../src/utils/telemetry';

/**
 * Pre-release blocker (#318 checkbox 3): OrdNodeProvider used to silently
 * fabricate resolution results — getSatInfo always returned
 * { inscription_ids: [] }, resolveInscription returned sat:0/text-plain,
 * getOutputDetails returned value:0 with no inscriptions — so every did:btco
 * looked like it had no inscriptions while the provider reported success.
 *
 * Every method is a stub with no real node integration, so every method must
 * fail loudly with a StructuredError whose code ends in NOT_IMPLEMENTED
 * (mirroring the OrdinalsClient hardening for #248) instead of returning
 * placeholder data.
 */
describe('OrdNodeProvider fails loudly instead of fabricating resolution data (#318)', () => {
  const provider = new OrdNodeProvider({ nodeUrl: 'http://node', timeout: 1234, network: 'signet' });

  async function expectNotImplemented(promise: Promise<unknown>): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StructuredError);
    const err = caught as StructuredError;
    expect(err.code).toMatch(/NOT_IMPLEMENTED$/);
    expect(err.message).toMatch(/not implemented/i);
  }

  test('constructs (configuration alone is allowed)', () => {
    expect(() => new OrdNodeProvider({ nodeUrl: 'https://ord.example' })).not.toThrow();
  });

  test('resolve throws NOT_IMPLEMENTED instead of returning a fabricated resource', async () => {
    await expectNotImplemented(provider.resolve('abc'));
  });

  test('resolveInscription throws NOT_IMPLEMENTED instead of returning sat:0/text-plain', async () => {
    await expectNotImplemented(provider.resolveInscription('ins-1'));
  });

  test('resolveInfo throws NOT_IMPLEMENTED instead of fabricating timestamps', async () => {
    await expectNotImplemented(provider.resolveInfo('rid'));
  });

  test('resolveCollection throws NOT_IMPLEMENTED instead of reporting an empty collection', async () => {
    await expectNotImplemented(provider.resolveCollection('did:btco:1', {}));
  });

  test('getSatInfo throws NOT_IMPLEMENTED instead of reporting no inscriptions', async () => {
    await expectNotImplemented(provider.getSatInfo('123456789'));
  });

  test('getMetadata throws NOT_IMPLEMENTED instead of returning null', async () => {
    await expectNotImplemented(provider.getMetadata('ins-1'));
  });

  test('getAllResources throws NOT_IMPLEMENTED on first iteration instead of yielding nothing', async () => {
    const gen = provider.getAllResources();
    await expectNotImplemented(gen.next());
  });

  test('getAllResourcesChronological throws NOT_IMPLEMENTED on first iteration', async () => {
    const gen = provider.getAllResourcesChronological();
    await expectNotImplemented(gen.next());
  });

  test('getInscriptionLocationsByAddress throws NOT_IMPLEMENTED instead of returning []', async () => {
    await expectNotImplemented(provider.getInscriptionLocationsByAddress('addr'));
  });

  test('getInscriptionByNumber throws NOT_IMPLEMENTED instead of returning inscription id 0', async () => {
    await expectNotImplemented(provider.getInscriptionByNumber(0));
  });

  test('getAddressOutputs throws NOT_IMPLEMENTED instead of returning []', async () => {
    await expectNotImplemented(provider.getAddressOutputs('addr'));
  });

  test('getOutputDetails throws NOT_IMPLEMENTED instead of returning value:0 with no inscriptions', async () => {
    await expectNotImplemented(provider.getOutputDetails('txid:0'));
  });
});
