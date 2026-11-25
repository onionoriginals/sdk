// Carried logs for did:og (P7.11–P7.16, P14.14–P14.17): a resource version that carries its
// Original's log in a trailer, a text block or a JSON member, verified under did:og.
import { describe, expect, test } from 'bun:test';
import { textBlockRefusal } from '../src/originals/carried-syntax.js';
import {
  carrierFor, carriedOgDisclosure, readCarriedFile, removeCarrier, resourceDigest, serializeLog, writeCarriedOgFile, type OgEntry,
} from '../src/og/index.js';
import { axes, descOf, enc, webvhSigner, World, type Signer } from './helpers/og-world.js';

const MAGIC = Uint8Array.of(0x89, 0x4f, 0x52, 0x49, 0x47, 0x49, 0x4e, 0x41, 0x4c, 0x4c, 0x4f, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const concat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };
const footer = (n: number) => { const f = new Uint8Array(24); new DataView(f.buffer).setUint32(4, n); f.set(MAGIC, 8); return f; };
const trailerOf = (log: Uint8Array) => concat(log, footer(log.length));

async function original(bytes: Uint8Array, mediaType: string, author?: Signer) {
  const w = await World.create(author, { resource: descOf(bytes, mediaType) }, bytes);
  await w.entry((s) => { s.asset.name = 'Carried'; });
  return w;
}
const write = (bytes: Uint8Array, w: World) => writeCarriedOgFile(bytes, w.entries, { disclosed: carriedOgDisclosure(w.entries) });
const history = (w: World) => [{ did: w.author.did, log: w.author.log(), source: 'retained', obtained: '2026-11-22T00:00:00Z' }];
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4);

describe('carriers by media type (P14.14)', () => {
  test('T14-029: image/PNG takes a trailer; application/javascript, application/pdf and application/vc+json take none', () => {
    expect(carrierFor('image/PNG')).toEqual({ kind: 'trailer' });
    for (const t of ['application/javascript', 'application/pdf', 'application/vc+json']) expect(carrierFor(t)).toBeNull();
  });

  test('T7-026: a carried log whose last entry names a media type with another carrier is not a carried version', async () => {
    const w = await original(png, 'image/png');
    const file = await write(png, w);
    // The same log appended as a text block to plain text: the carrier is not the one image/png has.
    const block = enc(`\n=====BEGIN ORIGINAL=====\n${serializeLog(w.entries)}=====END ORIGINAL=====\n`);
    const r = await readCarriedFile(concat(enc('notes'), block), { histories: history(w) });
    expect(r.carrierStatus).toBe('mismatch');
    expect(r.overall).toEqual({ status: 'failed', reason: 'carrier-not-for-media-type' });
    expect((await readCarriedFile(file, { histories: history(w) })).overall.status).toBe('verified');
  });

  test('T14-053: a wrong or missing file name extension is only a hint; the other carriers are tried', async () => {
    const w = await original(png, 'image/png');
    const file = await write(png, w);
    for (const hint of ['notes.md', 'data.json', '', 'x']) expect((await readCarriedFile(file, { hint, histories: history(w) })).carrierStatus).toBe('found');
  });
});

describe('reading a carried file (P7.12–P7.14)', () => {
  test('T7-021, T7-031: bytes that are the version, signer resolved: log verified, version verified, valid-as-of, never current; never an evidence package', async () => {
    const w = await original(png, 'image/png');
    const r = await readCarriedFile(await write(png, w), { histories: history(w) });
    expect(r).toMatchObject({ kind: 'carried-file', completeness: 'no-claim', carrierStatus: 'found', bytes: 'match', overall: { status: 'verified', reason: null } });
    expect(axes(r.report!)).toMatchObject({ state: 'valid-as-of', outcome: 'verified' });
    expect(r.checkpoint).toBe(w.head.versionId);
  });

  test('T7-022: one byte different, or changed line endings: not a version; the file fails with file-digest-mismatch, whatever the proofs gave', async () => {
    const w = await original(png, 'image/png');
    const file = await write(png, w);
    const changed = file.slice();
    changed[9] ^= 1;
    const r = await readCarriedFile(changed, { histories: history(w) });
    expect(r.overall).toEqual({ status: 'failed', reason: 'file-digest-mismatch' });
    expect(r.statements.join(' ')).toMatch(/not a version of that Original/);
    const text = enc('# Notes\nline\n');
    const t = await original(text, 'text/markdown');
    const crlf = new TextDecoder().decode(await write(text, t)).replace('# Notes\nline\n', '# Notes\r\nline\r\n');
    expect((await readCarriedFile(enc(crlf), { histories: history(t) })).overall.reason).toBe('file-digest-mismatch');
  });

  test('T7-023, T7-024, T7-041, T7-042, T7-043: no resolver request without this read\'s opt-in; offline, the entries are unchecked and nothing is verified', async () => {
    const w = await original(png, 'image/png');
    const file = await write(png, w);
    let asked = 0;
    const resolveSigners = async (did: string) => { asked++; return did === w.author.did ? history(w)[0] : undefined; };
    const opened = await readCarriedFile(file); // opened, previewed or imported: no opt-in
    expect(asked).toBe(0);
    expect(opened.overall).toEqual({ status: 'incomplete', reason: 'proofs-unchecked' });
    expect(axes(opened.report!)).toMatchObject({ identity: 'incomplete', outcome: 'incomplete' });
    expect(opened.report!.entries.every((e) => e.status === 'unchecked')).toBe(true);
    const withOptIn = await readCarriedFile(file, { resolveSigners });
    expect(asked).toBe(1);
    expect(withOptIn.overall.status).toBe('verified');
    await readCarriedFile(file); // the next read has no standing opt-in
    expect(asked).toBe(1);
    const offline = await readCarriedFile(file, { resolveSigners: async () => undefined });
    expect(offline.overall.status).toBe('incomplete');
    expect(offline.signers.unavailable).toEqual([w.author.did]);
  });

  test('T7-025: a forged log naming a real author DID, appended to bytes matching its last descriptor: proofs fail once resolved', async () => {
    const real = await original(png, 'image/png');
    const forger = await webvhSigner();
    const forged = await World.create({ ...forger, did: real.author.did, ref: () => real.author.ref() }, { resource: descOf(png, 'image/png') }, png);
    const file = trailerOf(enc(serializeLog(forged.entries)));
    const r = await readCarriedFile(concat(png, file), { histories: history(real) });
    expect(r.overall.status).toBe('failed');
    expect(axes(r.report!).identity).toBe('failed');
    expect((await readCarriedFile(concat(png, file))).overall.status).not.toBe('verified');
  });

  test('T7-027: an originalLog member that is not the root object\'s last: its log is verified and reported, the file is not verified as a version', async () => {
    const json = enc('{"a":1}');
    const w = await original(json, 'application/json');
    const written = new TextDecoder().decode(await write(json, w));
    const moved = JSON.parse(written);
    const reordered = enc(JSON.stringify({ originalLog: moved.originalLog, a: 1 }));
    const r = await readCarriedFile(reordered, { histories: history(w) });
    expect(r.carrierStatus).toBe('stray');
    expect(r.overall.reason).toBe('json-member-not-last');
    expect(axes(r.report!).identity).toBe('complete');
  });

  test('T7-036, T7-032: a carried log with no anchoring entry is valid-as-of its last entry; removing the carrier gives back the version, signing nothing', async () => {
    const w = await original(png, 'image/png');
    const file = await write(png, w);
    const r = await readCarriedFile(file, { histories: history(w) });
    expect(axes(r.report!)).toMatchObject({ state: 'valid-as-of', bitcoin: 'not-read' });
    expect(removeCarrier(file)).toEqual(png);
    expect(w.entries).toHaveLength(2);
  });

  test('T7-035, T7-044: the carried log of an anchored Original, read without the anchor: historical-checkpoint, missing-evidence, anchoring entry unchecked; a pre-anchor checkpoint is valid-as-of', async () => {
    const w = await original(png, 'image/png');
    const preAnchor = [...w.entries];
    const anchor = await w.entry((s) => { s.asset.aliases = ['did:btco:reg:9']; s.asset.body = 'none'; });
    const r = await readCarriedFile(await write(png, w), { histories: history(w) });
    expect(axes(r.report!)).toMatchObject({ state: 'historical-checkpoint', bitcoin: 'missing-evidence' });
    expect(r.report!.entries.find((e) => e.versionId === anchor.versionId)?.status).toBe('unchecked');
    expect(r.overall.status).toBe('incomplete');
    const before = await readCarriedFile(await writeCarriedOgFile(png, preAnchor, { disclosed: carriedOgDisclosure(preAnchor) }), { histories: history(w) });
    expect(axes(before.report!).state).toBe('valid-as-of');
    expect(before.overall.status).toBe('verified');
  });

  test('T7-037: a writer inscribing a carried file removes the carrier first: the body is the version\'s bytes', async () => {
    const w = await original(png, 'image/png');
    const body = removeCarrier(await write(png, w));
    expect(resourceDigest(body)).toBe((w.head.state.asset as { resource: { digest: string } }).resource.digest);
  });
});

describe('writing a carried file (P7.15, P7.16)', () => {
  test('T7-029, T7-013: refused for a draft, for bytes other than the last entry\'s version, and for a preview', async () => {
    const w = await original(png, 'image/png');
    const draft = w.entries.map((e) => ({ ...e, proof: [] })) as unknown as OgEntry[];
    await expect(writeCarriedOgFile(png, draft, { disclosed: carriedOgDisclosure(w.entries) })).rejects.toMatchObject({ code: 'CARRIER_NOT_ACCEPTED' });
    await expect(write(enc('other bytes'), w)).rejects.toMatchObject({ code: 'CARRIER_VERSION_MISMATCH' });
    const prv = enc('webp preview');
    await w.entry((s) => { s.asset.aliases = ['did:btco:reg:9']; s.asset.body = 'preview'; s.asset.preview = descOf(prv, 'image/webp'); });
    await expect(write(prv, w)).rejects.toMatchObject({ code: 'CARRIER_PREVIEW' });
  });

  test('T7-030: the user is told what the file discloses first; a JSON carrier says the data gains a member', async () => {
    const json = enc('{"a":1}');
    const w = await original(json, 'application/json');
    const d = carriedOgDisclosure(w.entries);
    expect(d.dataGainsMember).toBe(true);
    expect(d.text).toMatch(/history|discloses/i);
    await expect(writeCarriedOgFile(json, w.entries, { disclosed: undefined as never })).rejects.toMatchObject({ code: 'CARRIER_DISCLOSURE_REQUIRED' });
    expect(carriedOgDisclosure((await original(png, 'image/png')).entries).dataGainsMember).toBe(false);
  });

  test('T7-028: a JSON document whose root is an array, or that already has a root originalLog member, is refused', async () => {
    for (const doc of ['[1,2]', '{"originalLog":[],"a":1}']) {
      const bytes = enc(doc);
      const w = await original(bytes, 'application/json');
      await expect(write(bytes, w)).rejects.toMatchObject({ code: 'CARRIER_CANNOT_ADD' });
    }
  });

  test('T14-038, T14-043, T14-056, T14-057, T14-058, T14-059, T14-060: the text-block writer refuses where the appended block would not be a separate comment', async () => {
    const refuse = async (text: string | Uint8Array, mediaType: string) => {
      const bytes = typeof text === 'string' ? enc(text) : text;
      const w = await original(bytes, mediaType);
      return write(bytes, w).then(() => 'written', (e: { details?: { reason?: string } }) => e.details?.reason ?? 'refused');
    };
    expect(await refuse('key: |\n  text\n', 'application/yaml')).toBe('yaml-block-scalar');
    expect(await refuse('# T\n```\ncode\n', 'text/markdown')).toBe('unclosed-fence');
    expect(await refuse(new Uint8Array([0xff, 0xfe, 0x41]), 'text/plain')).toBe('not-utf8');
    for (const html of ['<p>x<script>', '<p>x<style>', '<p>x<textarea>']) expect(await refuse(html, 'text/html')).toBe('unclosed-element');
    expect(await refuse('<p>x<pre>code', 'text/html')).toBe('written');
    expect(await refuse('echo a \\\n', 'text/x-shellscript')).toBe('line-continuation');
    expect(await refuse('<p>x<a href="', 'text/html')).not.toBe('written');
    for (const html of ['<p><iframe>', '<p><noembed>', '<p><noframes>']) expect(await refuse(html, 'text/html')).toBe('unclosed-element');
    expect(await refuse('# Title\n\nDone.\n', 'text/markdown')).toBe('written');
    expect(textBlockRefusal('x', 'text/x-unlisted')).toBe('no-parser');
  });
});

describe('the trailer (P14.15)', () => {
  test('T14-030, T14-032: a length beyond the file less 24, an altered footer, or a 16–23-byte file ending in the magic: no trailer', async () => {
    const w = await original(png, 'image/png');
    const log = enc(serializeLog(w.entries));
    const tooLong = concat(png, log, footer(log.length + png.length + 1));
    expect((await readCarriedFile(tooLong)).carrierStatus).toBe('none');
    const eol = concat(png, log, footer(log.length));
    const altered = new TextDecoder('latin1').decode(eol).replace('\r\n\x1a', '\n\x1a');
    expect((await readCarriedFile(Uint8Array.from(altered, (c) => c.charCodeAt(0)))).carrierStatus).toBe('none');
    for (const n of [16, 20, 23]) expect((await readCarriedFile(concat(new Uint8Array(n - 16), MAGIC))).carrierStatus).toBe('none');
  });

  test('T14-031: a trailer length of 16,777,192 is a trailer; 16,777,193 is none', async () => {
    const at = async (length: number) => (await readCarriedFile(concat(new Uint8Array(length), footer(length)))).carrierStatus;
    expect(await at(16_777_192)).toBe('found');
    expect(await at(16_777_193)).toBe('none');
  }, 60_000);

  test('T14-033: a trailer entry line of 70,000 bytes whose JCS form is 60,000 is within the entry limit', async () => {
    const w = await World.create(undefined, { resource: descOf(png, 'image/png') }, png);
    const e = await w.entry((s) => { s.asset.metadata = { note: 'A'.repeat(59_000) }; });
    const line = JSON.stringify(e).replace(/A{2000}/, '\\u0041'.repeat(2000));
    const genesisLine = JSON.stringify(w.entries[0]);
    const log = enc(`${genesisLine}\n${line}\n`);
    expect(line.length).toBeGreaterThan(65_536);
    const r = await readCarriedFile(concat(png, trailerOf(log)), { histories: history(w) });
    expect(r.log?.status).toBe('parsed');
    expect(r.overall.status).toBe('verified');
  });

  test('T14-034: a trailer whose log breaks P14.2 is a trailer with an invalid log', async () => {
    const w = await original(png, 'image/png');
    const crlf = enc(serializeLog(w.entries).replaceAll('\n', '\r\n'));
    const r = await readCarriedFile(concat(png, trailerOf(crlf)));
    expect(r.carrierStatus).toBe('found');
    expect(r.overall).toEqual({ status: 'failed', reason: 'carried-log-invalid' });
  });
});

describe('the text block (P14.16)', () => {
  async function md(text = '# Notes\n\nBody.\n') {
    const bytes = enc(text);
    const w = await original(bytes, 'text/markdown');
    return { w, bytes, file: new TextDecoder().decode(await write(bytes, w)) };
  }

  test('T14-035, T14-040: a last line with no line end, or CR LF lines with trailing blank lines and spaces, is accepted', async () => {
    const { w, file } = await md();
    expect((await readCarriedFile(enc(file.replace(/\n$/, '')), { histories: history(w) })).overall.status).toBe('verified');
    const text = '# Notes\r\nBody.\r\n';
    const c = await original(enc(text), 'text/markdown');
    const written = new TextDecoder().decode(await write(enc(text), c));
    expect((await readCarriedFile(enc(written + '\r\n\r\n   '), { histories: history(c) })).overall.status).toBe('verified');
  });

  test('T14-036: a blank, unprefixed or non-JSON line between the markers makes a text block with an invalid log', async () => {
    const { file } = await md();
    const broken = file.replace('=====END ORIGINAL=====', 'not json\n=====END ORIGINAL=====');
    expect((await readCarriedFile(enc(broken))).overall.reason).toBe('carried-log-invalid');
  });

  test('T14-037: a text block at the very start of the file, with no line feed before it, is no carrier', async () => {
    const { w } = await md();
    const block = `=====BEGIN ORIGINAL=====\n${serializeLog(w.entries)}=====END ORIGINAL=====\n`;
    expect((await readCarriedFile(enc(block))).carrierStatus).toBe('none');
  });

  test('T14-039: an earlier text block followed by content is content, not a carrier', async () => {
    const { file } = await md();
    expect((await readCarriedFile(enc(file + 'More content.\n'))).carrierStatus).toBe('none');
  });

  test('T14-041: in a CR LF file, a separator of CR LF leaves the CR in the remaining bytes: digest mismatch', async () => {
    const text = '# Notes\r\nBody.\r\n';
    const c = await original(enc(text), 'text/markdown');
    const written = new TextDecoder().decode(await write(enc(text), c));
    const crlfSeparator = written.replace('Body.\r\n\n<!--', 'Body.\r\n\r\n<!--');
    expect((await readCarriedFile(enc(crlfSeparator), { histories: history(c) })).overall.reason).toBe('file-digest-mismatch');
  });

  test('T14-042: \\u escapes in entry lines are accepted; a raw non-ASCII character or a closer inside the block is no carrier', async () => {
    const { w, file } = await md();
    expect((await readCarriedFile(enc(file), { histories: history(w) })).overall.status).toBe('verified');
    const raw = file.replace('"Carried"', '"Carrïed"');
    expect((await readCarriedFile(enc(raw))).carrierStatus).not.toBe('found');
    const closer = file.replace('"Carried"', '"Car-->ried"');
    expect((await readCarriedFile(enc(closer))).carrierStatus).not.toBe('found');
  });

  test('T14-055: a closer not directly after the END marker, or a BEGIN marker not directly after the opener, is no carrier', async () => {
    const { file } = await md();
    expect((await readCarriedFile(enc(file.replace('=====END ORIGINAL=====\n-->', '=====END ORIGINAL=====\n\n-->')))).carrierStatus).not.toBe('found');
    expect((await readCarriedFile(enc(file.replace('<!--\n=====BEGIN', '<!--\n\n=====BEGIN')))).carrierStatus).not.toBe('found');
  });
});

describe('the JSON member (P14.17)', () => {
  async function json(doc = '{"a":1}') {
    const bytes = enc(doc);
    const w = await original(bytes, 'application/json');
    return { w, bytes, file: new TextDecoder().decode(await write(bytes, w)) };
  }

  test('T14-044: the root object\'s last member with entries reformatted and keys reordered is accepted, checked over their JCS form', async () => {
    const { w, file } = await json();
    const doc = JSON.parse(file);
    const reformatted = `{"a":1,"originalLog":${JSON.stringify(doc.originalLog.map((e: Record<string, unknown>) => Object.fromEntries(Object.entries(e).reverse())), null, 2)}}`;
    const r = await readCarriedFile(enc(reformatted), { histories: history(w) });
    expect(r.carrierStatus).toBe('found');
    expect(axes(r.report!).outcome).toBe('verified');
  });

  test('T14-045: two root members named originalLog, including one spelled with escapes: rejected, neither chosen', async () => {
    const { file } = await json();
    const doubled = file.replace('{"a":1,', '{"a":1,"origina\\u006cLog":[],');
    expect((await readCarriedFile(enc(doubled))).carrierStatus).toBe('rejected');
  });

  test('T14-046, T14-048: a member nested below the root is no JSON member; a root member whose value is 5 or [1] is an invalid log', async () => {
    expect((await readCarriedFile(enc('{"a":{"originalLog":[]}}'))).carrierStatus).toBe('none');
    for (const v of ['5', '[1]']) expect((await readCarriedFile(enc(`{"a":1,"originalLog":${v}}`))).overall.reason).toBe('carried-log-invalid');
  });

  test('T14-047: a 64-bit integer or a nested duplicate key outside the member does not stop the member being found', async () => {
    const { w, file } = await json('{"big":18446744073709551615,"n":{"k":1,"k":2}}');
    const r = await readCarriedFile(enc(file), { histories: history(w) });
    expect(r.carrierStatus).toBe('found');
    expect(r.overall.status).toBe('verified');
  });

  test('T14-049: {"originalLog":[…]} with a leading BOM, or as the only member: the version is the BOM and {}, or {}', async () => {
    for (const doc of ['﻿{}', '{}']) {
      const bytes = enc(doc);
      const w = await original(bytes, 'application/json');
      const file = await write(bytes, w);
      expect(removeCarrier(file)).toEqual(bytes);
      expect((await readCarriedFile(file, { histories: history(w) })).overall.status).toBe('verified');
    }
  });

  test('T14-050: a document nested 1,025 levels outside the entries has no JSON member', async () => {
    const deep = '{"a":' + '['.repeat(1024) + ']'.repeat(1024) + ',"originalLog":[]}';
    expect((await readCarriedFile(enc(deep))).carrierStatus).toBe('none');
  });
});
