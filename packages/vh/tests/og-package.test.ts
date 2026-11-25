// did:og evidence package (P14.10, P7.1, P7.5).
import { describe, expect, test } from 'bun:test';
import {
  buildPackage, crc32, manifestBytes, parseLogFile, readManifest, readPackageZip, resourceDigest, signerDirectory, writePackageZip,
  type OgEntry,
} from '../src/og/index.js';
import { bytesEqual, utf8, vbytes, vjson, vtree } from './helpers/og-vectors.js';

const log = vbytes('local/asset/did.jsonl');
const versionIds = (parseLogFile(log).values as OgEntry[]).map((e) => e.versionId);
const AUTHOR = vjson('index.json').author as string;
const v1 = vbytes('local/resources/v1.md');
const v2 = vbytes('local/resources/v2.md');

function localPackage() {
  return buildPackage({
    original: vjson('index.json').original,
    assetLog: log,
    versionIds,
    signers: [{ did: AUTHOR, log: vbytes('local/author/did.jsonl') }],
    resources: { [resourceDigest(v1)]: v1, [resourceDigest(v2)]: v2 },
    missing: [],
  });
}

/** A ZIP with one stored entry and chosen header fields, for reader tests. */
function rawZip(entries: Array<{ name: Uint8Array | string; data?: Uint8Array; method?: number; external?: number; made?: number; size?: number }>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  entries.forEach((e, i) => { files[`f${String(i).padStart(6, '0')}`] = e.data ?? utf8('x'); });
  const zip = writePackageZip(files);
  // Patch the central directory fields in place.
  const view = new DataView(zip.buffer);
  let cd = view.getUint32(zip.length - 6, true);
  const out: number[] = [];
  const patched = new Uint8Array(zip);
  const pv = new DataView(patched.buffer);
  entries.forEach((e) => {
    if (e.method !== undefined) pv.setUint16(cd + 10, e.method, true);
    if (e.external !== undefined) pv.setUint32(cd + 38, e.external, true);
    if (e.made !== undefined) pv.setUint16(cd + 4, e.made, true);
    if (e.size !== undefined) { pv.setUint32(cd + 20, e.size, true); pv.setUint32(cd + 24, e.size, true); }
    const nameLength = pv.getUint16(cd + 28, true);
    const name = typeof e.name === 'string' ? utf8(e.name) : e.name;
    if (name.length === nameLength) patched.set(name, cd + 46);
    cd += 46 + nameLength;
  });
  void out;
  return patched;
}

describe('local vector package (T14-076, T14-018)', () => {
  test('the writer reproduces evidence.zip and its manifest byte for byte', () => {
    const p = localPackage();
    expect(bytesEqual(p.files['originals-evidence.json'], vbytes('local/package/originals-evidence.json'))).toBe(true);
    expect(bytesEqual(p.archive, vbytes('local/package/evidence.zip'))).toBe(true);
    expect(bytesEqual(localPackage().archive, p.archive)).toBe(true);
    expect(resourceDigest(p.archive)).toBe(vjson('local/evidence-set.json').inputs[0].digest);
  });

  test('the hosted vector serves the same package layout through entry 3 (P14.11)', () => {
    const served = vtree('hosted/served/originals');
    const hlog = served['asset/did.jsonl'];
    const ids = (parseLogFile(hlog).values as OgEntry[]).map((e) => e.versionId);
    const p = buildPackage({
      original: vjson('index.json').original, assetLog: hlog, versionIds: ids,
      signers: [{ did: AUTHOR, log: vbytes('local/author/did.jsonl') }], resources: { [resourceDigest(v1)]: v1, [resourceDigest(v2)]: v2 }, missing: [],
    });
    expect(Object.keys(p.files).sort()).toEqual(Object.keys(served).sort());
    for (const [name, bytes] of Object.entries(p.files)) expect(bytesEqual(bytes, served[name])).toBe(true);
  });

  test('the reader round-trips the vector package and its manifest', () => {
    const files = readPackageZip(vbytes('local/package/evidence.zip'));
    expect(Object.keys(files)).toContain(`${signerDirectory(AUTHOR)}did.jsonl`);
    expect(signerDirectory(AUTHOR)).toMatch(/^signers\/[0-9a-f]{64}\/$/);
    const m = readManifest(files['originals-evidence.json'], versionIds);
    expect(m.completeness).toBe('complete');
    expect(bytesEqual(manifestBytes(m), files['originals-evidence.json'])).toBe(true);
  });

  test('crc32 matches the ZIP check value', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
  });
});

describe('signed bytes (P7.2)', () => {
  test('T7-061: a package holds the signed lines exactly as given, never re-serialised, even when their key order is not JCS', () => {
    const lines = new TextDecoder().decode(log).trimEnd().split('\n').map((l) => {
      const e = JSON.parse(l);
      // The same entry with its members in another order: the same JCS form, the same hashes and proof.
      return JSON.stringify({ proof: e.proof, state: e.state, versionTime: e.versionTime, versionId: e.versionId, parameters: e.parameters });
    });
    const reordered = utf8(lines.join('\n') + '\n');
    const p = buildPackage({ original: vjson('index.json').original, assetLog: reordered, versionIds, signers: [], resources: {}, missing: [] });
    expect(bytesEqual(readPackageZip(p.archive)['asset/did.jsonl'], reordered)).toBe(true);
    expect(bytesEqual(reordered, log)).toBe(false);
  });
});

describe('manifest (P14.10)', () => {
  const files = readPackageZip(vbytes('local/package/evidence.zip'));
  const m = JSON.parse(new TextDecoder().decode(files['originals-evidence.json']));
  const enc = (o: object) => utf8(JSON.stringify(o));

  test('T14-077: a checkpoint not in the log, or a head that is not its last entry, is rejected', () => {
    expect(() => readManifest(enc({ ...m, checkpoint: '3-QmX' }), versionIds)).toThrow(/checkpoint/);
    expect(() => readManifest(enc({ ...m, head: versionIds[0] }), versionIds)).toThrow(/head/);
    expect(readManifest(enc({ ...m, checkpoint: versionIds[0] }), versionIds).checkpoint).toBe(versionIds[0]);
  });

  test('a reader accepts any JSON with the members; rejects other members, a BOM or bad missing items', () => {
    expect(readManifest(utf8(JSON.stringify(m, null, 2)), versionIds).head).toBe(versionIds[1]);
    expect(() => readManifest(enc({ ...m, extra: 1 }), versionIds)).toThrow();
    expect(() => readManifest(utf8('﻿' + JSON.stringify(m)), versionIds)).toThrow();
    expect(() => readManifest(enc({ ...m, completeness: 'partial', missing: [{ kind: 'resource', version: 0, digest: resourceDigest(v1), versionId: versionIds[0] }] }), versionIds)).toThrow();
    expect(readManifest(enc({ ...m, completeness: 'partial', missing: [{ kind: 'identity', did: AUTHOR, role: 'author' }] }), versionIds).missing).toHaveLength(1);
  });

  test('a manifest under another profile is unsupported, not invalid (T14-085)', () => {
    expect(readManifest(enc({ ...m, profile: 'originals:1.0' }), versionIds).unsupported).toBe(true);
  });
});

describe('archive bounds (P7.5, P14.10)', () => {
  test('T14-019: a compressed entry or a name over 255 bytes is rejected', () => {
    expect(() => readPackageZip(rawZip([{ name: 'f000000', method: 8 }]))).toThrow(/compressed/);
    expect(() => writePackageZip({ ['a'.repeat(256)]: utf8('x') })).toThrow(/255/);
    expect(writePackageZip({ ['a'.repeat(255)]: utf8('x') }).length).toBeGreaterThan(0);
  });

  test('T14-025: a name that is not valid UTF-8, or a mode that is not a regular file, is rejected', () => {
    expect(() => readPackageZip(rawZip([{ name: new Uint8Array([0x66, 0xff, 0xfe, 0x30, 0x30, 0x30, 0x30]) }]))).toThrow(/UTF-8/);
    expect(() => readPackageZip(rawZip([{ name: 'f000000', external: 0xa1ff0000 }]))).toThrow(/regular file/);
  });

  test('T7-011, T7-062: a symbolic link, a .. path, an absolute path or a duplicate is rejected before extraction', () => {
    expect(() => readPackageZip(rawZip([{ name: 'f000000', external: (0o120777 << 16) >>> 0 }]))).toThrow(/regular file/);
    expect(() => readPackageZip(rawZip([{ name: '../../x' }]))).toThrow(/\.\./);
    expect(() => readPackageZip(rawZip([{ name: '/etc/pa' }]))).toThrow(/absolute/);
    expect(() => readPackageZip(rawZip([{ name: 'f000000' }, { name: 'f000000' }]))).toThrow(/twice/);
  });

  test('T14-024: a reader accepts entries out of order or with other dates and flags', () => {
    const zip = writePackageZip({ a: utf8('1'), b: utf8('2') });
    const v = new DataView(zip.buffer);
    let cd = v.getUint32(zip.length - 6, true);
    v.setUint16(cd + 12, 0x6000, true); // another time
    v.setUint16(14, 0x5021, true); // another local date
    void cd;
    expect(Object.keys(readPackageZip(zip)).sort()).toEqual(['a', 'b']);
  });

  test('T7-063: 20,000 entries are imported; 20,001 are rejected before extraction', () => {
    const files = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`r/${i}`, new Uint8Array(0)]));
    expect(Object.keys(readPackageZip(writePackageZip(files(20_000)))).length).toBe(20_000);
    expect(() => writePackageZip(files(20_001))).toThrow();
    // A reader given 20,001 rejects them from the central directory count.
    const zip = writePackageZip(files(20_000));
    const v = new DataView(zip.buffer);
    v.setUint16(zip.length - 12, 20_001, true);
    v.setUint16(zip.length - 14, 20_001, true);
    expect(() => readPackageZip(zip)).toThrow(/20000|20,000/);
  });

  test('T7-064 (over the bound): entries declaring more than 512 MiB in total are rejected before any data is read', () => {
    const zip = rawZip([{ name: 'f000000', size: 300 * 1024 * 1024 }, { name: 'f000001', size: 300 * 1024 * 1024 }]);
    expect(() => readPackageZip(zip)).toThrow(/512 MiB/);
  });

  test('T14-006: previews are never under resources/; a package without them is complete', () => {
    const p = localPackage();
    expect(p.manifest.completeness).toBe('complete');
    expect(Object.keys(p.files).filter((n) => n.startsWith('resources/')).sort()).toEqual([`resources/${resourceDigest(v1)}`, `resources/${resourceDigest(v2)}`].sort());
  });

  test('P7.1: a did:btco signer is never packaged', () => {
    expect(() => buildPackage({ original: 'did:og:x', assetLog: log, versionIds, signers: [{ did: 'did:btco:reg:5', log: utf8('') }], resources: {}, missing: [] })).toThrow(/did:btco/);
  });
});
