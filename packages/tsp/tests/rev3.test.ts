import { describe, expect, test } from 'bun:test';
import rev3 from './fixtures/rev3.json';
import { cesrToBinary } from '../src/cesr/binary.js';
import { decodeEnvelope, decodePayload, CryptoType } from '../src/cesr/packet.js';
import { keysFromRev3Vid, openTspMessage } from '../src/message.js';
import { base64urlnopad as base64url } from '@scure/base';

type Rev3 = typeof rev3;

function vid(name: string) {
  const v = (rev3 as Rev3).vids[name as keyof Rev3['vids']];
  if (!v) throw new Error(`missing vid ${name}`);
  return keysFromRev3Vid(v);
}

describe('rev3 vectors', () => {
  const names = ['direct-hpke-base', 'direct-signed-only', 'control-rfi-direct'] as const;

  for (const name of names) {
    test(name, async () => {
      const vector = rev3.vectors.find((v) => v.name === name);
      expect(vector).toBeDefined();
      const wire = new TextEncoder().encode(vector!.message);
      const sender = vid(vector!.sender);
      const receiver = vid(vector!.receiver);

      if (vector!.expect.crypto === 'Plaintext') {
        const opened = await openTspMessage(wire, sender);
        expect(opened.crypto).toBe(CryptoType.Plaintext);
        expect(new TextDecoder().decode(opened.applicationData!)).toBe(vector!.expect.payload.content);
        return;
      }

      const opened = await openTspMessage(wire, sender, receiver);
      expect(opened.crypto).toBe(CryptoType.HpkeBase);

      if (name === 'control-rfi-direct') {
        expect(opened.payload.type).toBe('rfi');
        const expectedNonce = base64url.decode(vector!.nonce!);
        expect([...opened.payload.nonce]).toEqual([...expectedNonce]);
        expect(opened.payload.requestDigest.bytes.length).toBe(32);
        return;
      }

      expect(new TextDecoder().decode(opened.applicationData!)).toBe(vector!.expect.payload.content);
    });
  }

  test('payload plaintext segments decode', () => {
    const vector = rev3.vectors.find((v) => v.name === 'direct-hpke-base')!;
    const wire = new TextEncoder().encode(vector.message);
    const bin = cesrToBinary(wire);
    const env = decodeEnvelope(bin);
    expect(env.cryptoType).toBe(CryptoType.HpkeBase);
    const plain = new TextEncoder().encode(vector.payload_plaintext);
    const plainBin = cesrToBinary(plain);
    const decoded = decodePayload(plainBin);
    expect(decoded.payload.type).toBe('generic');
    if (decoded.payload.type === 'generic') {
      expect(new TextDecoder().decode(decoded.payload.data)).toBe('hello world');
    }
  });
});