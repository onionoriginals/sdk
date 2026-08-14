import { describe, test, expect } from 'bun:test';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { computeDigestMultibase } from '../../../src/cel/hash';
import { canonicalizeEntryForChain } from '../../../src/cel/canonicalize';
import type { DataIntegrityProof } from '../../../src/cel/types';
import { createRealCelSigner } from '../../fixtures/celSigner';

const realSigner = createRealCelSigner();
const signedPayloads: unknown[] = [];
// Records what was handed to the signer, then signs it for real.
const signer = async (data: unknown): Promise<DataIntegrityProof> => {
  signedPayloads.push(data);
  return realSigner.signer(data);
};

describe('appendEvent', () => {
  test('appends a typed event with correct chain link and signed payload', async () => {
    const log = await createEventLog({ name: 'A' }, { signer, verificationMethod: realSigner.verificationMethod });
    const out = await appendEvent(log, 'migrate', { sourceDid: 'a', targetDid: 'b', layer: 'webvh', migratedAt: 'x' }, { signer, verificationMethod: realSigner.verificationMethod });
    const evt = out.events[1];
    expect(evt.type).toBe('migrate');
    expect(evt.previousEvent).toBe(computeDigestMultibase(canonicalizeEntryForChain(log.events[0])));
    // signer received exactly { type, data, previousEvent } — what verifyEventLog reconstructs
    expect(signedPayloads.at(-1)).toEqual({ type: 'migrate', data: evt.data, previousEvent: evt.previousEvent });
    expect(log.events.length).toBe(1); // input not mutated
  });

  test('rejects empty logs and create type', async () => {
    await expect(appendEvent({ events: [] }, 'update', {}, { signer, verificationMethod: 'x' })).rejects.toThrow(/empty/i);
    // @ts-expect-error create is excluded at the type level; runtime guard too
    await expect(appendEvent({ events: [{ type: 'create', data: {}, proof: [] }] }, 'create', {}, { signer, verificationMethod: 'x' })).rejects.toThrow(/create/i);
  });
});
