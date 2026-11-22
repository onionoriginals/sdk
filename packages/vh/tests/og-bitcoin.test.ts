// did:og on Bitcoin (P9.10–P9.36, P14.12): the bitcoin and prior-format vectors.
import { describe, expect, test } from 'bun:test';
import { decodeCbor } from '../src/originals/cbor.js';
import { defaultCheck, encodeEnvelope, encodeMetadata, parseTransaction, readInscription, resourceDigest, sameReport, transferCheck, verifyOriginal } from '../src/og/index.js';
import { encodeCbor } from '../src/originals/cbor.js';
import { bitcoinEvidence, bytesEqual, pjson, priorEvidence, vbytes, vectorEvidence, vjson } from './helpers/og-vectors.js';

describe('bitcoin vector (T14-075, T9-030, P9.18)', () => {
  test('the expected report from exactly the P9.18 evidence set', async () => {
    const r = await verifyOriginal(bitcoinEvidence());
    const want = vjson('bitcoin/expected-report.json');
    expect(sameReport(r, want)).toBe(true);
    expect({ ...r, diagnostics: r.diagnostics.map(({ reason: _r, ...d }) => d) }).toEqual({ ...want, diagnostics: want.diagnostics.map(({ reason: _r, ...d }: any) => d) });
  });
});

describe('anchor-absent vector (T9-135, T14-075, P9.5)', () => {
  test('the whole expected report from a copy of the log, the history, both versions and the sat read in full with no inscription', async () => {
    const e = vectorEvidence('anchor-absent');
    const r = await verifyOriginal(e);
    const want = vjson('anchor-absent/expected-report.json');
    expect(sameReport(r, want)).toBe(true);
    expect(r).toEqual(want);
  });
});

describe('transfer depth (P7.22, P14.13)', () => {
  const at = async (height: number) => {
    const e = bitcoinEvidence();
    e.tip = { height, hash: e.tip!.hash };
    return verifyOriginal(e);
  };

  test('the bitcoin vector has 9 confirmations: no insufficient-depth, the transfer check passes', async () => {
    const r = await verifyOriginal(bitcoinEvidence());
    expect(r.diagnostics.some((d) => d.code === 'insufficient-depth')).toBe(false);
    expect(transferCheck(r)).toBe(true);
  });

  test('T7-071: 5 confirmations: one insufficient-depth naming the publication\'s first inscription; transfer fails, default passes', async () => {
    const r = await at(106);
    const first = vjson('bitcoin/chain.json').inscriptions[0].id;
    expect(r.diagnostics.filter((d) => d.code === 'insufficient-depth').map(({ reason: _r, ...d }) => d)).toEqual([{ code: 'insufficient-depth', rule: 'P7.22', item: { kind: 'inscription', id: first } }]);
    expect(transferCheck(r)).toBe(false);
    expect(defaultCheck(r)).toBe(true);
  });

  test('T7-072: exactly 6 confirmations: no insufficient-depth; the transfer check passes', async () => {
    const r = await at(107);
    expect(r.diagnostics.some((d) => d.code === 'insufficient-depth')).toBe(false);
    expect(transferCheck(r)).toBe(true);
  });
});

describe('metadata member order (P14.12, T14-097, T14-098)', () => {
  /** Re-encode a vector part's metadata with its maps in other orders, keeping the envelope's fields and body. */
  const reorder = (k: number, order: 'reverse' | 'jcs') => {
    const env = vbytes(`bitcoin/inscriptions/part-${k}.envelope.bin`);
    const r = readInscription(env);
    if (r.kind !== 'originals') throw new Error('part');
    const rev = (v: any): any => (Array.isArray(v) ? v.map(rev) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((x) => [x, rev(v[x])])) : v);
    const m = r.metadata as any;
    const value = order === 'reverse' ? { ...(m.part ? { part: m.part } : {}), ...(m.signers ? { signers: rev(m.signers) } : {}), entries: rev(m.entries) } : m;
    const metadata = order === 'reverse' ? encodeCbor(value) : encodeMetadata(m);
    return encodeEnvelope({ contentType: r.contentType, metadata, body: r.body });
  };

  for (const order of ['reverse', 'jcs'] as const) {
    test(`T14-097, T14-098: the bitcoin vector re-encoded with map members in ${order} order gives the same entries and the same report, apart from the input digests`, async () => {
      const e = bitcoinEvidence();
      const envs = [reorder(1, order), reorder(2, order)];
      expect(readInscription(envs[0])).toMatchObject({ kind: 'originals' });
      e.inputs = e.inputs.map((i, k) => ({ ...i, bytes: envs[k] }));
      e.sats = e.sats!.map((s) => ({ ...s, inscriptions: s.inscriptions.map((x, k) => ({ ...x, envelope: envs[k] })) }));
      const r = await verifyOriginal(e);
      const want = vjson('bitcoin/expected-report.json');
      want.evidence.inputs = want.evidence.inputs.map((i: any, k: number) => ({ ...i, digest: resourceDigest(envs[k]) }));
      expect(sameReport(r, want)).toBe(true);
    });
  }
});

describe('inscription bytes (T14-076, T14-078)', () => {
  for (const k of [1, 2]) {
    test(`part ${k}: the vector envelope is a read fixture: the codec reproduces it from its decoded key order, and other orders decode to the same values`, () => {
      const meta = vbytes(`bitcoin/inscriptions/part-${k}.metadata.cbor`);
      const env = vbytes(`bitcoin/inscriptions/part-${k}.envelope.bin`);
      const decoded = decodeCbor(meta, { shortest: false }) as never;
      const asWritten = encodeMetadata(decoded, { keepOrder: true });
      expect(bytesEqual(asWritten, meta)).toBe(true);
      const r = readInscription(env);
      if (r.kind !== 'originals') throw new Error(r.kind);
      expect(bytesEqual(encodeEnvelope({ contentType: r.contentType, metadata: asWritten, body: r.body }), env)).toBe(true);
      // Any member order conforms (P14.12, b4f3604): JCS member order gives other bytes, the same JSON values.
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
    expect(sameReport(r, pjson('expected-report.json'))).toBe(true);
  });

  test('each transaction\'s txid is recomputed from its bytes', () => {
    for (const x of pjson('chain.json').inscriptions) {
      expect(parseTransaction(priorEvidence().inputs.find((i) => i.source.endsWith(x.revealTxid))!.bytes).txid).toBe(x.revealTxid);
    }
  });
});
