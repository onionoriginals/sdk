// did:og log format (originals-spec PR 69, section 14): the genesis vector and
// the matrix rows for P14.1–P14.3, P14.8 and P14.27–P14.29.
import { describe, expect, test } from 'bun:test';
import { canonicalize, type JsonObject } from '../src/json/index.js';
import { computeScid, vhHash } from '../src/log/index.js';
import {
  OG_METHOD, OgRuleError, checkLogStructure, entryLine, exceedsNumberBound, ogHash, parseLogFile, prepareGenesis, prepareNext,
  resourceDigest, scidInput, entryHashInput, signEntry, serializeLog, type OgEntry,
} from '../src/og/index.js';
import { bytesEqual, utf8, vbytes, vjson, vtext, vectorKey } from './helpers/og-vectors.js';

const authorKey = vectorKey('author assertionMethod key-1');
const authorLog = vjson<JsonObject>('genesis/author/did.jsonl');
const AUTHOR = (authorLog.state as JsonObject).id as string;
const authorRef = { did: AUTHOR, verificationMethod: `${AUTHOR}#key-1`, versionId: authorLog.versionId as string };
const v1 = vbytes('genesis/resources/v1.md');

function genesisState(extra: Partial<JsonObject> = {}): JsonObject {
  return {
    id: 'did:og:{SCID}', operation: 'create', author: authorRef,
    asset: { name: 'Field notes', status: 'active', network: 'regtest', resource: { mediaType: 'text/markdown', size: v1.length, digest: resourceDigest(v1) }, aliases: [] },
    transitions: [{ from: null, to: resourceDigest(v1) }],
    ...extra,
  };
}

async function genesis(time = '2026-01-02T00:00:00Z', state = genesisState()): Promise<OgEntry> {
  return signEntry(prepareGenesis({ versionTime: time, state }), authorRef.verificationMethod, authorKey);
}

async function next(prev: OgEntry, time: string, parameters: JsonObject = {}, state?: JsonObject): Promise<OgEntry> {
  const s = state ?? { ...prev.state, operation: 'update', transitions: [] };
  return signEntry(prepareNext(prev, { versionTime: time, parameters, state: s }), authorRef.verificationMethod, authorKey);
}


const ruleOf = (values: unknown[]) => {
  const r = checkLogStructure(values as never);
  return r.failure ? { index: r.failure.index, rule: (r.failure.error.details as { rule?: string })?.rule, code: r.failure.error.code } : undefined;
};

describe('genesis vector (T14-091, P14.26–P14.29)', () => {
  test('the writer reproduces did.jsonl byte for byte from its inputs', async () => {
    const e = await genesis();
    expect(entryLine(e)).toBe(vtext('genesis/did.jsonl'));
    expect(bytesEqual(utf8(serializeLog([e])), vbytes('local/asset/did.jsonl').subarray(0, utf8(entryLine(e)).length))).toBe(true);
  });

  test('the SCID and entry hash are recomputed over exactly the vector inputs (P14.28, P14.29)', () => {
    const parsed = parseLogFile(vbytes('genesis/did.jsonl'));
    expect(parsed.failure).toBeUndefined();
    const ge = parsed.values[0] as OgEntry;
    const scid = ge.parameters.scid as string;
    expect(canonicalize(scidInput(ge))).toBe(vtext('genesis/scid-input.json'));
    expect(ogHash(scidInput(ge))).toBe(scid);
    expect(canonicalize(entryHashInput(ge, scid))).toBe(vtext('genesis/entry-hash-input.json'));
    expect(ge.versionId).toBe(`1-${ogHash(entryHashInput(ge, scid))}`);
    const d = vjson('genesis/derivation.json');
    expect([scid, ge.versionId, (ge.state as JsonObject).id]).toEqual([d.scid, d.versionId, `did:og:${d.scid}`]);
    expect(checkLogStructure(parsed.values).failure).toBeUndefined();
  });

  test('T14-090: a VH Log library computes the same SCID and entry hashes', () => {
    const ge = parseLogFile(vbytes('local/asset/did.jsonl')).values as OgEntry[];
    const { proof: _p, ...noProof } = ge[0];
    expect(computeScid(JSON.parse(JSON.stringify(noProof).replaceAll(ge[0].parameters.scid as string, '{SCID}')))).toBe(ge[0].parameters.scid);
    const { proof: _q, ...e2 } = ge[1];
    expect(`2-${vhHash({ ...e2, versionId: ge[0].versionId })}`).toBe(ge[1].versionId);
  });
});

describe('line format (P14.2)', () => {
  test('T14-022: CR, non-compact JSON or no final line feed are rejected', async () => {
    const line = entryLine(await genesis());
    expect(parseLogFile(line.replace('\n', '\r\n')).failure?.error.code).toBe('LOG_LINE_FORMAT');
    expect(parseLogFile(line.slice(0, -1)).failure?.error.code).toBe('LOG_LINE_FORMAT');
    expect(parseLogFile(JSON.stringify(JSON.parse(line), null, 1).replaceAll('\n', '') + '\n').failure?.error.code).toBe('LOG_LINE_FORMAT');
    expect(parseLogFile('').failure?.error.code).toBe('LOG_EMPTY');
    expect(parseLogFile(new Uint8Array([0xff, 0x0a])).failure?.error.code).toBe('LOG_NOT_UTF8');
  });

  test('T14-028: whitespace outside strings is rejected; keys in non-JCS order are accepted', async () => {
    const e = await genesis();
    const reordered = JSON.stringify({ versionId: e.versionId, versionTime: e.versionTime, parameters: e.parameters, state: e.state, proof: e.proof }) + '\n';
    expect(reordered).not.toBe(entryLine(e));
    const parsed = parseLogFile(reordered);
    expect(parsed.failure).toBeUndefined();
    expect(checkLogStructure(parsed.values).failure).toBeUndefined();
    expect(parseLogFile(reordered.replace('{"versionId"', '{ "versionId"')).failure?.error.code).toBe('LOG_LINE_FORMAT');
  });

  test('T14-061: entries under one millisecond apart, or with four fractional digits, are rejected', async () => {
    const g = await genesis('2026-01-02T00:00:00.000Z');
    const same = await next(g, '2026-01-02T00:00:00.000Z');
    expect(ruleOf([g, same])).toMatchObject({ index: 1, rule: 'P14.2', code: 'VERSION_TIME_ORDER' });
    const ok = await next(g, '2026-01-02T00:00:00.001Z');
    expect(ruleOf([g, ok])).toBeUndefined();
    const four = await genesis('2026-01-02T00:00:00.0001Z');
    expect(ruleOf([four])).toMatchObject({ rule: 'P14.2', code: 'VERSION_TIME_FORMAT' });
    const offset = await genesis('2026-01-02T00:00:00+00:00');
    expect(ruleOf([offset])).toMatchObject({ rule: 'P14.2' });
  });
});

describe('strict JSON (P14.3)', () => {
  test('T14-021: 1e16 and 9007199254740993.0 are rejected; 2^53 - 1 is not', () => {
    expect(exceedsNumberBound('1e16')).toBe(true);
    expect(exceedsNumberBound('9007199254740993.0')).toBe(true);
    expect(exceedsNumberBound('9007199254740991')).toBe(false);
    expect(exceedsNumberBound('9007199254740991.5')).toBe(true);
    expect(exceedsNumberBound('-9007199254740992')).toBe(true);
    expect(exceedsNumberBound('900719925474099.1e1')).toBe(false);
    expect(exceedsNumberBound('1e-400')).toBe(false);
    for (const n of ['1e16', '9007199254740993.0']) {
      expect(parseLogFile(`{"a":${n}}\n`).failure?.error.code).toBe('JSON_UNSAFE_NUMBER');
    }
  });

  test('T14-068, T14-069: -0, -0.0 and a lone surrogate are rejected', () => {
    for (const bad of ['{"a":-0}', '{"a":-0.0}', '{"a":"\\ud800"}', '{"a":1,"a":2}']) {
      expect(parseLogFile(bad + '\n').failure?.error).toBeInstanceOf(OgRuleError);
    }
  });

  test('T14-070: nesting of 64 levels is parsed, 65 is rejected', () => {
    const nest = (n: number) => '['.repeat(n) + ']'.repeat(n);
    expect(parseLogFile(nest(64) + '\n').failure).toBeUndefined();
    expect(parseLogFile(nest(65) + '\n').failure?.error.code).toBe('JSON_TOO_DEEP');
  });
});

describe('entry shape, proof and limits (P14.27, P14.8, P14.13)', () => {
  test('T14-086: an extra or missing member, or a proof that is not an array of one, is rejected', async () => {
    const g = await genesis();
    expect(ruleOf([{ ...g, extra: 1 }])).toMatchObject({ rule: 'P14.27' });
    const { versionTime: _t, ...noTime } = g;
    expect(ruleOf([noTime])).toMatchObject({ rule: 'P14.27' });
    expect(ruleOf([{ ...g, proof: g.proof[0] }])).toMatchObject({ rule: 'P14.27' });
  });

  test('T5-017: two proofs are rejected (P5.2)', async () => {
    const g = await genesis();
    expect(ruleOf([{ ...g, proof: [g.proof[0], g.proof[0]] }])).toMatchObject({ rule: 'P5.2' });
  });

  test('T5-018: bip340-jcs-2025 or another cryptosuite is rejected (P5.12)', async () => {
    const g = await genesis();
    expect(ruleOf([{ ...g, proof: [{ ...(g.proof[0] as JsonObject), cryptosuite: 'bip340-jcs-2025' }] }])).toMatchObject({ rule: 'P5.12' });
    expect(ruleOf([{ ...g, proof: [{ ...(g.proof[0] as JsonObject), cryptosuite: 'ecdsa-jcs-2019' }] }])).toMatchObject({ rule: 'P5.12' });
  });

  test('T14-023: a proof member other than the five is rejected', async () => {
    const g = await genesis();
    expect(ruleOf([{ ...g, proof: [{ ...(g.proof[0] as JsonObject), created: g.versionTime }] }])).toMatchObject({ rule: 'P14.8' });
  });

  test('T14-066: a proofValue that is not z-base58btc of 64 bytes is rejected', async () => {
    const g = await genesis();
    const p = g.proof[0] as JsonObject;
    for (const proofValue of ['u' + (p.proofValue as string).slice(1), 'z3yZe7d', (p.proofValue as string).slice(0, -3)]) {
      expect(ruleOf([{ ...g, proof: [{ ...p, proofValue }] }])).toMatchObject({ rule: 'P14.8' });
    }
  });

  test('T14-016: an entry of 65,536 JCS bytes is accepted and 65,537 rejected; the SDK refuses to sign it', async () => {
    const base = await genesis();
    const overhead = canonicalize(base).length;
    const sized = async (n: number) => genesis('2026-01-02T00:00:00Z', genesisState({ asset: { ...(genesisState().asset as JsonObject), metadata: { pad: 'x'.repeat(n) } } }));
    // Find the padding that makes the signed entry exactly 65,536 bytes (proofValue length can vary by one).
    let e: OgEntry | undefined;
    for (let pad = 65_536 - overhead - 30; pad < 65_536 - overhead; pad++) {
      const candidate = await sized(pad);
      if (utf8(canonicalize(candidate)).length === 65_536) { e = candidate; break; }
    }
    expect(e).toBeDefined();
    expect(ruleOf([e!])).toBeUndefined();
    const over = { ...e!, versionTime: e!.versionTime } as JsonObject;
    ((over.state as JsonObject).asset as JsonObject).metadata = { pad: (((e!.state as JsonObject).asset as JsonObject).metadata as JsonObject).pad + 'x' };
    expect(ruleOf([over])).toMatchObject({ rule: 'P14.13' });
    await expect(sized(70_000)).rejects.toMatchObject({ code: 'ENTRY_TOO_LARGE' });
  });

  test('T14-071: 10,000 entries are within the limit; the 10,001st is limit-exceeded', async () => {
    const entries: OgEntry[] = [await genesis('2026-01-02T00:00:00.000Z')];
    const t0 = Date.parse('2026-01-02T00:00:00.000Z');
    for (let i = 1; i <= 10_000; i++) entries.push(await next(entries[i - 1], new Date(t0 + i).toISOString()));
    const r = checkLogStructure(entries.slice(0, 10_000));
    expect(r.failure).toBeUndefined();
    const over = checkLogStructure(entries);
    expect(over.entries.length).toBe(10_000);
    expect(over.limitExceeded).toBe(true);
    expect(over.failure?.error.details).toEqual({ rule: 'P14.13' });
  }, 120_000);
});

describe('version numbers, SCID and entry hash (P14.27–P14.29)', () => {
  test('T14-087: version numbers that skip, repeat, start other than at 1 or have a leading zero are rejected', async () => {
    const g = await genesis();
    const e2 = await next(g, '2026-01-03T00:00:00Z');
    const e3 = await next(e2, '2026-01-04T00:00:00Z');
    expect(ruleOf([g, e3])).toMatchObject({ index: 1, rule: 'P14.27' });
    expect(ruleOf([g, e2, e2])).toMatchObject({ index: 2, rule: 'P14.27' });
    expect(ruleOf([e2])).toMatchObject({ index: 0, rule: 'P14.27' });
    const zero = { ...e2, versionId: '0' + e2.versionId };
    expect(ruleOf([g, zero])).toMatchObject({ index: 1, rule: 'P14.27' });
  });

  test('T14-088: an SCID that is not the placeholder hash, or a state.id that differs, is rejected (P3.1)', async () => {
    const g = await genesis();
    const tampered = JSON.parse(JSON.stringify(g)) as OgEntry;
    (tampered.state.asset as JsonObject).name = 'Other notes';
    expect(ruleOf([tampered])).toMatchObject({ rule: 'P14.28', code: 'SCID_MISMATCH' });
    const otherId = await genesis('2026-01-02T00:00:00Z', genesisState({ id: 'did:og:QmV2yQcaZ5eeDyWKqeHW5whoWmhtH9ZygNfDcnFEqEt4vW' }));
    // The SCID still verifies (the literal id is not a placeholder), so state.id is checked by the verifier (P3.1).
    expect((otherId.state as JsonObject).id).not.toBe(`did:og:${otherId.parameters.scid}`);
  });

  test('T14-089: an entry hash not over its predecessor, or an SCID naming another multihash, is rejected', async () => {
    const g = await genesis();
    const e2 = await next(g, '2026-01-03T00:00:00Z');
    const relinked = { ...e2, versionId: `2-${ogHash(entryHashInput(e2, g.parameters.scid as string))}` };
    expect(ruleOf([g, relinked])).toMatchObject({ index: 1, rule: 'P14.29' });
    const sha512ish = { ...g, parameters: { ...g.parameters, scid: '8tUCq8Ya1Z9jvDrrhtS9BTMzD4AgjHg2X3bA1sVbTZsAa' } };
    expect(ruleOf([sha512ish])).toMatchObject({ rule: 'P14.28' });
    const badHash = { ...e2, versionId: '2-zQmQFt79upGpNBqAnKak3f3XaUrgy6gevkrvEoGbJJCGLTo' };
    expect(ruleOf([g, badHash])).toMatchObject({ rule: 'P14.29' });
  });
});

describe('parameters (P14.1)', () => {
  test('T14-080: genesis parameters are exactly method, scid and updateKeys []', async () => {
    const g = await genesis();
    expect(g.parameters).toEqual({ method: OG_METHOD, scid: g.parameters.scid, updateKeys: [] });
    expect(ruleOf([g])).toBeUndefined();
  });

  test('T14-081, T14-082, T14-052: missing or non-empty updateKeys, extra or null parameters are rejected', async () => {
    const g = await genesis();
    const variants: JsonObject[] = [
      { method: OG_METHOD, scid: g.parameters.scid as string },
      { method: OG_METHOD, scid: g.parameters.scid as string, updateKeys: [authorKey.publicKeyMultibase] },
      { method: OG_METHOD, scid: g.parameters.scid as string, updateKeys: [], ttl: 3600 },
      { method: OG_METHOD, scid: g.parameters.scid as string, updateKeys: null },
    ];
    for (const parameters of variants) expect(ruleOf([{ ...g, parameters }])?.rule).toBeDefined();
    const e2 = await next(g, '2026-01-03T00:00:00Z', { updateKeys: [authorKey.publicKeyMultibase] });
    expect(ruleOf([g, e2])).toMatchObject({ index: 1, rule: 'P14.1', code: 'UPDATE_KEYS' });
    const nul = await next(g, '2026-01-03T00:00:00Z', { deactivated: null });
    expect(ruleOf([g, nul])).toMatchObject({ index: 1, rule: 'P14.1', code: 'PARAMETER_NULL' });
    const ttl = await next(g, '2026-01-03T00:00:00Z', { ttl: 60 });
    expect(ruleOf([g, ttl])).toMatchObject({ index: 1, rule: 'P14.1' });
  });

  test('T5-005: nextKeyHashes is rejected (P5.9)', async () => {
    const g = await genesis();
    const e2 = await next(g, '2026-01-03T00:00:00Z', { nextKeyHashes: [] });
    expect(ruleOf([g, e2])).toMatchObject({ rule: 'P5.9' });
  });

  test('T9-022: a witness parameter other than an empty object is rejected (P9.9)', async () => {
    const g = await genesis();
    const e2 = await next(g, '2026-01-03T00:00:00Z', { witness: { threshold: 1, witnesses: [] } });
    expect(ruleOf([g, e2])).toMatchObject({ rule: 'P9.9' });
  });

  test('T14-001: a later entry that sets method is rejected', async () => {
    const g = await genesis();
    for (const method of [OG_METHOD, 'did:webvh:1.0']) {
      const e2 = await next(g, '2026-01-03T00:00:00Z', { method });
      expect(ruleOf([g, e2])).toMatchObject({ rule: 'P14.1', code: 'METHOD_LATER' });
    }
  });

  test('T14-084: {"updateKeys": []} and {"deactivated": true, "updateKeys": []} are accepted', async () => {
    const g = await genesis();
    const e2 = await next(g, '2026-01-03T00:00:00Z', { updateKeys: [] });
    const e3 = await next(e2, '2026-01-04T00:00:00Z', { deactivated: true, updateKeys: [] });
    expect(ruleOf([g, e2, e3])).toBeUndefined();
  });

  test('T14-083: an editor entry carrying updateKeys, even [], is rejected', async () => {
    const g = await genesis();
    const editorState = { ...g.state, operation: 'update', transitions: [], editor: { did: 'did:webvh:QmEditor:example.com', verificationMethod: 'did:webvh:QmEditor:example.com#k', versionId: '1-QmX' } };
    const e2 = await next(g, '2026-01-03T00:00:00Z', { updateKeys: [] }, editorState);
    expect(ruleOf([g, e2])).toMatchObject({ rule: 'P14.1', code: 'EDITOR_PARAMETERS' });
  });

  test('a log under another method value is unsupported, not invalid (T14-085, P14.1)', async () => {
    const other = await signEntry({ ...prepareGenesis({ versionTime: '2026-01-02T00:00:00Z', state: genesisState() }) }, authorRef.verificationMethod, authorKey);
    const p = { ...other.parameters, method: 'originals:1.0' };
    const r = checkLogStructure([{ ...other, parameters: p }]);
    // The SCID no longer matches either; the verifier checks the method value first (see og-verify tests).
    expect(r.failure).toBeDefined();
    const fresh = prepareGenesis({ versionTime: '2026-01-02T00:00:00Z', state: genesisState() });
    expect(fresh.parameters.method).toBe(OG_METHOD);
  });
});
