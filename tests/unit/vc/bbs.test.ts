/** Canonical test aggregator created by combine-tests script. */

/** Inlined from bbs.simple.part.ts */
import { describe, test, expect } from 'bun:test';
import { BbsSimple } from '../../../src';
import { bls12_381 as bls } from '@noble/curves/bls12-381';

describe('BbsSimple e2e', () => {
  test('sign/verify not implemented with header', async () => {
    const sk = bls.utils.randomPrivateKey();
    const pk = bls.getPublicKey(sk);
    const keypair = { privateKey: sk, publicKey: pk };
    const header = new Uint8Array([1, 2, 3]);
    const messages = [
      new TextEncoder().encode('msg1'),
      new TextEncoder().encode('msg2'),
      new TextEncoder().encode('msg3')
    ];

    await expect(BbsSimple.sign(messages, keypair, header)).rejects.toThrow(/not implemented/i);
    await expect(BbsSimple.verify(messages, new Uint8Array([0]), pk, header)).rejects.toThrow(/not implemented/i);
  });

  test('sign/verify not implemented with default header', async () => {
    const sk = bls.utils.randomPrivateKey();
    const pk = bls.getPublicKey(sk);
    const keypair = { privateKey: sk, publicKey: pk };
    const messages = [
      new TextEncoder().encode('a'),
      new TextEncoder().encode('b')
    ];
    await expect(BbsSimple.sign(messages, keypair)).rejects.toThrow(/not implemented/i);
    await expect(BbsSimple.verify(messages, new Uint8Array([1, 2]), pk)).rejects.toThrow(/not implemented/i);
  });
});




/** Inlined from bbs.utils.part.ts */
import { BBSCryptosuiteUtils } from '../../../src';
import * as cbor from 'cbor-js';

function u8(len: number, start: number = 0): Uint8Array {
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = (start + i) & 0xff;
  return a;
}

describe('BBSCryptosuiteUtils', () => {
  const bbsSignature = u8(96, 1);
  const bbsHeader = u8(64, 2);
  const publicKey = u8(96, 3);
  const hmacKey = u8(32, 4);
  const mandatoryPointers = ['/id', '/credentialSubject/id'];

  test('rejects non-u prefix for base/derived parsing', () => {
    expect(() => (BBSCryptosuiteUtils as any).parseBaseProofValue('xabc')).toThrow('multibase');
    expect(() => (BBSCryptosuiteUtils as any).parseDerivedProofValue('xabc')).toThrow('multibase');
  });

  test('serialize/parse base proof (baseline)', () => {
    const s = BBSCryptosuiteUtils.serializeBaseProofValue(
      bbsSignature,
      bbsHeader,
      publicKey,
      hmacKey,
      mandatoryPointers,
      'baseline'
    );
    expect(s.startsWith('u')).toBe(true);
    const p = (BBSCryptosuiteUtils as any).parseBaseProofValue(s);
    expect(Array.from(p.bbsSignature)).toEqual(Array.from(bbsSignature));
    expect(Array.from(p.bbsHeader)).toEqual(Array.from(bbsHeader));
    expect(Array.from(p.publicKey)).toEqual(Array.from(publicKey));
    expect(Array.from(p.hmacKey)).toEqual(Array.from(hmacKey));
    expect(p.mandatoryPointers).toEqual(mandatoryPointers);
    expect(p.featureOption).toBe('baseline');
  });

  test('serialize/parse base proof (anonymous_holder_binding)', () => {
    const signerBlind = u8(32, 7);
    const s = BBSCryptosuiteUtils.serializeBaseProofValue(
      bbsSignature,
      bbsHeader,
      publicKey,
      hmacKey,
      mandatoryPointers,
      'anonymous_holder_binding',
      undefined,
      signerBlind
    );
    const p = (BBSCryptosuiteUtils as any).parseBaseProofValue(s);
    expect(p.featureOption).toBe('anonymous_holder_binding');
    expect(Array.from(p.signerBlind)).toEqual(Array.from(signerBlind));
  });

  test('serialize/parse base proof (pseudonym_issuer_pid)', () => {
    const pid = u8(32, 9);
    const s = BBSCryptosuiteUtils.serializeBaseProofValue(
      bbsSignature,
      bbsHeader,
      publicKey,
      hmacKey,
      mandatoryPointers,
      'pseudonym_issuer_pid',
      pid
    );
    const p = (BBSCryptosuiteUtils as any).parseBaseProofValue(s);
    expect(p.featureOption).toBe('pseudonym_issuer_pid');
    expect(Array.from(p.pid)).toEqual(Array.from(pid));
  });

  test('serialize/parse base proof (pseudonym_hidden_pid)', () => {
    const signerBlind = u8(32, 11);
    const s = BBSCryptosuiteUtils.serializeBaseProofValue(
      bbsSignature,
      bbsHeader,
      publicKey,
      hmacKey,
      mandatoryPointers,
      'pseudonym_hidden_pid',
      undefined,
      signerBlind
    );
    const p = (BBSCryptosuiteUtils as any).parseBaseProofValue(s);
    expect(p.featureOption).toBe('pseudonym_hidden_pid');
    expect(Array.from(p.signerBlind)).toEqual(Array.from(signerBlind));
  });

  test('serialize/parse derived proof (baseline)', () => {
    const labelMap = { c14n1: 'b3', c14n10: 'b7' };
    const mandatoryIndexes = [0, 2, 5];
    const selectiveIndexes = [1, 4];
    const presentationHeader = u8(16, 33);
    const bbsProof = u8(80, 55);
    const s = BBSCryptosuiteUtils.serializeDerivedProofValue(
      bbsProof,
      labelMap,
      mandatoryIndexes,
      selectiveIndexes,
      presentationHeader,
      'baseline'
    );
    const p = (BBSCryptosuiteUtils as any).parseDerivedProofValue(s);
    expect(Array.from(p.bbsProof)).toEqual(Array.from(bbsProof));
    expect(p.labelMap).toEqual(labelMap);
    expect(p.mandatoryIndexes).toEqual(mandatoryIndexes);
    expect(p.selectiveIndexes).toEqual(selectiveIndexes);
    expect(Array.from(p.presentationHeader)).toEqual(Array.from(presentationHeader));
    expect(p.featureOption).toBe('baseline');
  });

  test('serialize/parse derived proof (anonymous_holder_binding)', () => {
    const labelMap = { c14n2: 'b5' };
    const presentationHeader = u8(8, 7);
    const bbsProof = u8(64, 8);
    const s = BBSCryptosuiteUtils.serializeDerivedProofValue(
      bbsProof,
      labelMap,
      [0],
      [1],
      presentationHeader,
      'anonymous_holder_binding',
      undefined,
      4
    );
    const p = (BBSCryptosuiteUtils as any).parseDerivedProofValue(s);
    expect(p.featureOption).toBe('anonymous_holder_binding');
    expect(p.lengthBBSMessages).toBe(4);
  });

  test('serialize/parse derived proof (pseudonym)', () => {
    const labelMap = { c14n3: 'b7' };
    const presentationHeader = u8(4, 90);
    const bbsProof = u8(64, 90);
    const s = BBSCryptosuiteUtils.serializeDerivedProofValue(
      bbsProof,
      labelMap,
      [0, 1],
      [1],
      presentationHeader,
      'pseudonym',
      'alice',
      5
    );
    const p = (BBSCryptosuiteUtils as any).parseDerivedProofValue(s);
    expect(p.featureOption).toBe('pseudonym');
    expect(p.pseudonym).toBe('alice');
    expect(p.lengthBBSMessages).toBe(5);
  });

  test('parse base proof with base_proof header', () => {
    const components = [bbsSignature, bbsHeader, publicKey, hmacKey, mandatoryPointers];
    const encoded = (cbor as any).encode(components) as Uint8Array | ArrayBuffer;
    const encBytes = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded as ArrayBuffer);
    const header = new Uint8Array([0xd9, 0x5d, 0x03]);
    const bytes = new Uint8Array(header.length + encBytes.length);
    bytes.set(header, 0);
    bytes.set(encBytes, header.length);
    const s = 'u' + Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const p = (BBSCryptosuiteUtils as any).parseBaseProofValue(s);
    expect(p.featureOption).toBe('base_proof');
  });

  test('serializeDerivedProofValue throws on missing length for anonymous_holder_binding', () => {
    expect(() => BBSCryptosuiteUtils.serializeDerivedProofValue(
      u8(8),
      { c14n1: 'b1' },
      [0],
      [0],
      u8(4),
      'anonymous_holder_binding'
    )).toThrow('lengthBBSMessages is required');
  });

  test('serializeDerivedProofValue throws on missing pseudonym/length for pseudonym', () => {
    expect(() => BBSCryptosuiteUtils.serializeDerivedProofValue(
      u8(8),
      { c14n1: 'b1' },
      [0],
      [0],
      u8(4),
      'pseudonym'
    )).toThrow('pseudonym and lengthBBSMessages');
  });

  test('serializeDerivedProofValue throws on unsupported feature', () => {
    expect(() => (BBSCryptosuiteUtils as any).serializeDerivedProofValue(
      u8(8),
      { c14n1: 'b1' },
      [0],
      [0],
      u8(4),
      'unsupported'
    )).toThrow('Unsupported feature option');
  });

  test('serializeBaseProofValue throws for missing signerBlind/pid and unsupported feature', () => {
    expect(() => BBSCryptosuiteUtils.serializeBaseProofValue(
      u8(8), u8(4), u8(8), u8(4), mandatoryPointers, 'anonymous_holder_binding'
    )).toThrow('signerBlind is required');
    expect(() => BBSCryptosuiteUtils.serializeBaseProofValue(
      u8(8), u8(4), u8(8), u8(4), mandatoryPointers, 'pseudonym_issuer_pid'
    )).toThrow('pid is required');
    expect(() => (BBSCryptosuiteUtils as any).serializeBaseProofValue(
      u8(8), u8(4), u8(8), u8(4), mandatoryPointers, 'unsupported'
    )).toThrow('Unsupported feature option');
  });

  test('serializeBaseProofValue throws when signerBlind missing for pseudonym_hidden_pid', () => {
    expect(() => BBSCryptosuiteUtils.serializeBaseProofValue(
      u8(8), u8(4), u8(8), u8(4), mandatoryPointers, 'pseudonym_hidden_pid'
    )).toThrow('signerBlind is required');
  });

  test('compareBytes length mismatch branch', () => {
    expect((BBSCryptosuiteUtils as any).compareBytes(new Uint8Array([1, 2]), [1, 2, 3])).toBe(false);
  });

  test('serializeDerivedProofValue throws on invalid labelMap entries', () => {
    expect(() => BBSCryptosuiteUtils.serializeDerivedProofValue(
      u8(4),
      { notC14n: 'b1' } as any,
      [0],
      [0],
      u8(2),
      'baseline'
    )).toThrow('Invalid label map entry');
  });

  test('parse errors on invalid base header', () => {
    // Construct invalid header 'u' + cbor of empty
    const bad = 'u' + 'AAAA';
    expect(() => (BBSCryptosuiteUtils as any).parseBaseProofValue(bad)).toThrow();
  });

  test('parse errors on invalid derived header', () => {
    const bad = 'u' + 'AAAA';
    expect(() => (BBSCryptosuiteUtils as any).parseDerivedProofValue(bad)).toThrow();
  });
});
