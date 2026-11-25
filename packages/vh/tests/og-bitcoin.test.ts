// did:og on Bitcoin (P9.10–P9.36, P14.12): the bitcoin and prior-format vectors.
import { describe, expect, test } from 'bun:test';
import { decodeCbor } from '../src/originals/cbor.js';
import { defaultCheck, encodeEnvelope, encodeMetadata, parseTransaction, readInscription, resourceDigest, sameReport, transferCheck, verifyOriginal } from '../src/og/index.js';
import { encodeCbor } from '../src/originals/cbor.js';
import { bitcoinEvidence, bytesEqual, pjson, priorEvidence, vbytes, vectorEvidence, vjson, withSatRead } from './helpers/og-vectors.js';

describe('bitcoin vector (T14-075, T9-030, T14-102, P9.18)', () => {
  test('the expected report from exactly the P9.18 evidence set, with the author log as resolved (D22)', async () => {
    const r = await verifyOriginal(bitcoinEvidence());
    const want = vjson('bitcoin/expected-report.json');
    expect({ ...r, diagnostics: r.diagnostics.map(({ reason: _r, ...d }) => d) }).toEqual({ ...want, diagnostics: want.diagnostics.map(({ reason: _r, ...d }: any) => d) });
    expect(sameReport(r, want)).toBe(true);
  });

  test('D22: without the resolved author log the anchor is undetermined, nothing accepted', async () => {
    const e = bitcoinEvidence();
    e.inputs = e.inputs.filter((i) => i.kind !== 'signer-history');
    e.signerHistories = [];
    const r = await verifyOriginal(e);
    expect(r.axes).toMatchObject({ bitcoin: 'undetermined', identity: 'incomplete', outcome: 'incomplete' });
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: 'signer-history-missing', rule: 'P5.6', item: { kind: 'signer', id: vjson('index.json').author } }));
    expect(r.entries.some((x) => x.status === 'accepted')).toBe(false);
  });

  test('D22: the vector inscriptions carry no signers member', () => {
    for (const k of [1, 2]) expect(Object.keys(decodeCbor(vbytes(`bitcoin/inscriptions/part-${k}.metadata.cbor`), { shortest: false }) as object)).not.toContain('signers');
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

describe('sat-read input (P14.25, P7.17)', () => {
  test('T14-099: confirmations that are not the tip height less the height, plus one: input-unusable; the sat is not read', async () => {
    const e = withSatRead(bitcoinEvidence(), (r) => { r.inscriptions[1].confirmations = 3; });
    const r = await verifyOriginal(e);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: 'input-unusable', rule: 'P7.17', item: { kind: 'input', id: 'bitcoin/sat-read.json' } }));
    expect((r.axes as any).bitcoin).not.toBe('anchored');
  });

  test('T14-099 (form): an extra member, a holder that is a string, or another network is input-unusable', async () => {
    for (const edit of [(r: any) => { r.note = 'x'; }, (r: any) => { r.holder = r.holder.address; }, (r: any) => { r.network = 'signet'; }]) {
      const r = await verifyOriginal(withSatRead(bitcoinEvidence(), edit));
      expect(r.diagnostics.map((d) => d.code)).toContain('input-unusable');
    }
  });

  test('T14-100: an inscription listed with no inscription input is unread: anchoring-sat-not-read, rule P9.17', async () => {
    const e = bitcoinEvidence();
    e.inputs = e.inputs.filter((i) => !(i.kind === 'inscription' && i.source.endsWith(vjson('bitcoin/chain.json').inscriptions[1].id)));
    const r = await verifyOriginal(e);
    expect(r.diagnostics.filter((d) => d.code === 'anchoring-sat-not-read').map(({ reason: _r, ...d }) => d)).toEqual([{ code: 'anchoring-sat-not-read', rule: 'P9.17', item: { kind: 'sat', id: 'did:btco:reg:1234567890' } }]);
    expect((r.axes as any).bitcoin).toBe('missing-evidence');
  });
});

describe('transfer depth (P7.22, P14.13)', () => {
  const at = async (height: number) => {
    // Another tip: the evidence set's tip and the sat-read's, with each inscription's confirmations recomputed.
    const e = withSatRead(bitcoinEvidence(), (r) => {
      r.tip.height = height;
      for (const x of r.inscriptions) x.confirmations = height - x.height + 1;
    });
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
    const value = order === 'reverse' ? { ...(m.part ? { part: m.part } : {}), entries: rev(m.entries) } : m;
    const metadata = order === 'reverse' ? encodeCbor(value) : encodeMetadata(m);
    return encodeEnvelope({ contentType: r.contentType, metadata, body: r.body });
  };

  for (const order of ['reverse', 'jcs'] as const) {
    test(`T14-097, T14-098: the bitcoin vector re-encoded with map members in ${order} order gives the same entries and the same report, apart from the input digests`, async () => {
      const e = bitcoinEvidence();
      const envs = [reorder(1, order), reorder(2, order)];
      expect(readInscription(envs[0])).toMatchObject({ kind: 'originals' });
      let k = 0;
      e.inputs = e.inputs.map((i) => (i.kind === 'inscription' ? { kind: i.kind, source: i.source, bytes: envs[k++] } : i));
      const r = await verifyOriginal(e);
      const want = vjson('bitcoin/expected-report.json');
      let j = 0;
      want.evidence.inputs = want.evidence.inputs.map((i: any) => (i.kind === 'inscription' ? { ...i, digest: resourceDigest(envs[j++]) } : i));
      expect(sameReport(r, want)).toBe(true);
    });
  }
});

describe('metadata members on the bitcoin vector (P14.12, T14-003, owner decision D)', () => {
  /** The vector with part 1's metadata given one more member, its other fields and body kept. */
  const withMember = (member: Record<string, unknown>) => {
    const e = bitcoinEvidence();
    const env = vbytes('bitcoin/inscriptions/part-1.envelope.bin');
    const r = readInscription(env);
    if (r.kind !== 'originals') throw new Error('part 1');
    const changed = encodeEnvelope({ contentType: r.contentType, metadata: encodeCbor({ ...(r.metadata as any), ...member }), body: r.body });
    let k = 0;
    e.inputs = e.inputs.map((i) => (i.kind === 'inscription' && k++ === 0 ? { kind: i.kind, source: i.source, bytes: changed } : i));
    return e;
  };

  test('T14-003: an unknown member makes the publication rejected: outcome invalid, as the reference checker gives', async () => {
    const r = await verifyOriginal(withMember({ extra: 1 }));
    expect(r.axes).toMatchObject({ outcome: 'invalid', history: 'invalid', bitcoin: 'not-anchored' });
    expect(r.entries.length).toBe(4);
    expect(r.entries.every((x) => x.status === 'rejected' && x.rule === 'P14.12')).toBe(true);
  });

  test('owner decision D: a signers member on regtest is an unknown member too: invalid', async () => {
    const r = await verifyOriginal(withMember({ signers: [{ did: vjson('index.json').author, log: [] }] }));
    expect(r.axes).toMatchObject({ outcome: 'invalid', bitcoin: 'not-anchored' });
  });
});

describe('inscription bytes (T14-076, T14-078)', () => {
  for (const k of [1, 2]) {
    test(`part ${k}: the vector envelope is a read fixture: the codec reproduces it from its decoded key order, and other orders decode to the same values`, () => {
      const meta = vbytes(`bitcoin/inscriptions/part-${k}.metadata.cbor`);
      const env = vbytes(`bitcoin/inscriptions/part-${k}.envelope.bin`);
      const decoded = decodeCbor(meta, { shortest: false }) as Record<string, unknown>;
      const asWritten = encodeMetadata(decoded as never, { keepOrder: true });
      expect(bytesEqual(asWritten, meta)).toBe(true);
      const r = readInscription(env);
      if (r.kind !== 'originals') throw new Error(r.kind);
      expect(bytesEqual(encodeEnvelope({ contentType: r.contentType, metadata: asWritten, body: r.body }), env)).toBe(true);
      // Any member order conforms (P14.12, b4f3604): JCS member order gives other bytes, the same JSON values.
      const jcs = encodeMetadata(decoded as never);
      expect(bytesEqual(jcs, meta)).toBe(false);
      expect(decodeCbor(jcs, { shortest: false })).toEqual(decoded as never);
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

describe('fixed diagnostic rules (P14.25, T14-101)', () => {
  const FIXED: Record<string, string[]> = {
    'target-missing': ['P3.2'], 'resource-missing': ['P7.4'], 'resource-mismatch': ['P7.4'], 'signer-history-missing': ['P5.6'],
    'signer-version-missing': ['P7.8'], 'proof-unchecked': ['P7.19'], 'anchoring-sat-not-read': ['P7.14', 'P9.17', 'P9.10'],
    'signer-sat-not-read': ['P9.35'], 'inscription-unverifiable': ['P9.15'], 'publication-waiting': ['P9.36'], 'input-unusable': ['P7.17'], 'insufficient-depth': ['P7.22'],
  };
  test('every diagnostic in every vector report, expected and computed, carries the rule P14.25 fixes for its code', async () => {
    const reports = [
      ...['genesis', 'local', 'missing-resource', 'bitcoin', 'anchor-absent'].map((d) => vjson(`${d}/expected-report.json`)),
      await verifyOriginal(vectorEvidence('missing-resource')),
      await verifyOriginal(bitcoinEvidence()),
      await verifyOriginal(withSatRead(bitcoinEvidence(), (r) => { r.inscriptions[0].confirmations = 1; })),
    ];
    let checked = 0;
    for (const r of reports) for (const d of r.diagnostics) {
      if (d.code !== 'entry-rejected') expect(FIXED[d.code]).toContain(d.rule);
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
  });
});
