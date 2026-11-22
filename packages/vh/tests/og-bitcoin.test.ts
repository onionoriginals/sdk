// did:og on Bitcoin (P9.10–P9.36, P14.12): the bitcoin and prior-format vectors.
import { describe, expect, test } from 'bun:test';
import { decodeCbor } from '../src/originals/cbor.js';
import { encodeEnvelope, encodeMetadata, parseTransaction, readInscription, verifyOriginal } from '../src/og/index.js';
import { bitcoinEvidence, bytesEqual, pjson, priorEvidence, vbytes, vjson } from './helpers/og-vectors.js';

describe('bitcoin vector (T14-075, T9-030, P9.18)', () => {
  test('the expected report from exactly the P9.18 evidence set', async () => {
    const r = await verifyOriginal(bitcoinEvidence());
    expect(r).toEqual(vjson('bitcoin/expected-report.json'));
  });
});

describe('inscription bytes (T14-076, T14-078, F1)', () => {
  for (const k of [1, 2]) {
    test(`part ${k}: the codec reproduces the metadata and envelope from the vector's key order; JCS order differs (F1)`, () => {
      const meta = vbytes(`bitcoin/inscriptions/part-${k}.metadata.cbor`);
      const env = vbytes(`bitcoin/inscriptions/part-${k}.envelope.bin`);
      const decoded = decodeCbor(meta, { shortest: false }) as never;
      const asWritten = encodeMetadata(decoded, { keepOrder: true });
      expect(bytesEqual(asWritten, meta)).toBe(true);
      const r = readInscription(env);
      if (r.kind !== 'originals') throw new Error(r.kind);
      expect(bytesEqual(encodeEnvelope({ contentType: r.contentType, metadata: asWritten, body: r.body }), env)).toBe(true);
      // P14.12's writer order (JCS member order) gives other bytes but the same entries.
      const jcs = encodeMetadata(decoded);
      expect(bytesEqual(jcs, meta)).toBe(false);
      expect(decodeCbor(jcs, { shortest: false })).toEqual(decodeCbor(meta, { shortest: false }));
    });
  }
});

describe('prior-format fixture (T14-085)', () => {
  test('the mainnet acceptance Original of 1 November 2026 is unsupported: the whole report (P14.25, P14.26)', async () => {
    const r = await verifyOriginal(priorEvidence());
    expect(r).toEqual(pjson('expected-report.json'));
  });

  test('each transaction\'s txid is recomputed from its bytes', () => {
    for (const x of pjson('chain.json').inscriptions) {
      expect(parseTransaction(priorEvidence().inputs.find((i) => i.source.endsWith(x.revealTxid))!.bytes).txid).toBe(x.revealTxid);
    }
  });
});
