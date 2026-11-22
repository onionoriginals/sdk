// The SDK's did:og writer and anchoring command pieces (plan 051): key files, the author
// did:webvh, previews and body modes (P9.30), the local-copy check (P9.18), the disclosure
// (P9.18, T9-083) and the commit/reveal chain (P14.12).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDIDFromLog } from 'didwebvh-ts';
import * as btc from '@scure/btc-signer';
import { parseJsonLines } from '@originals/vh/json';
import { parseTransaction, readInscription, envelopesInWitness } from '@originals/vh/og';
import { generateKeyFile, readKeyFile } from '../../../src/og/keys.js';
import { checkAuthorLog, createAuthorDid, webvhLocation } from '../../../src/og/author-did.js';
import { anchoringPublication, checkLocalCopy, choosePreview, createAnchoringEntry, createGenesis, describeTransferCheck, disclosure, type AuthorRef } from '../../../src/og/original.js';
import { checkAddress, fundingAddress, plan, scureNetwork, signChain } from '../../../src/og/inscribe.js';

const dir = () => mkdtempSync(join(tmpdir(), 'og-sdk-'));

async function author(name = 'brian'): Promise<{ ref: AuthorRef; url: string }> {
  const d = dir();
  const keys = generateKeyFile(join(d, 'k.json'));
  const a = await createAuthorDid(keys, { path: ['authors', name], now: new Date('2026-11-21T00:00:00Z') });
  rmSync(d, { recursive: true });
  return { ref: { did: a.did, verificationMethod: a.verificationMethod, versionId: a.versionId, log: a.log, signer: keys.assertion }, url: a.url };
}

describe('author key file', () => {
  test('generated with mode 0600, never overwritten, two different keys', () => {
    const d = dir();
    const p = join(d, 'keys.json');
    const k = generateKeyFile(p);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(() => generateKeyFile(p)).toThrow(/refusing to overwrite/);
    const r = readKeyFile(p);
    expect(r.keys.assertion.publicKeyMultibase).toBe(k.assertion.publicKeyMultibase);
    expect(r.keys.update.publicKeyMultibase).not.toBe(r.keys.assertion.publicKeyMultibase);
    expect(r.warning).toBeUndefined();
    chmodSync(p, 0o644);
    expect(readKeyFile(p).warning).toMatch(/chmod 600/);
    writeFileSync(join(d, 'bad.json'), '{"type":"other"}');
    expect(() => readKeyFile(join(d, 'bad.json'))).toThrow();
    rmSync(d, { recursive: true });
  });
});

describe('author did:webvh on originals.build', () => {
  test('did:webvh:<SCID>:originals.build:authors:<name>, served at https://originals.build/authors/<name>/did.jsonl', async () => {
    const { ref, url } = await author('brian');
    expect(ref.did).toMatch(/^did:webvh:Qm[1-9A-HJ-NP-Za-km-z]{44}:originals\.build:authors:brian$/);
    expect(url).toBe('https://originals.build/authors/brian/did.jsonl');
    expect((await checkAuthorLog(ref.did, ref.log)).ok).toBe(true);
  });

  test('the log verifies under didwebvh-ts, an independent did:webvh implementation, and the signing key is not an updateKey (P5.3)', async () => {
    const { ref } = await author('indep');
    const r = await resolveDIDFromLog(parseJsonLines(ref.log) as never);
    expect(r.didResolutionMetadata?.error).toBeUndefined();
    expect(r.didDocument?.id).toBe(ref.did);
    const entry = parseJsonLines(ref.log)[0] as { parameters: { updateKeys: string[] }; state: { verificationMethod: Array<{ publicKeyMultibase: string }> } };
    expect(entry.parameters.updateKeys).not.toContain(entry.state.verificationMethod[0].publicKeyMultibase);
  });

  test('the domain is a parameter; a port is percent-encoded; bad segments are refused', () => {
    expect(webvhLocation('example.com', ['authors', 'a'])).toBe('example.com:authors:a');
    expect(webvhLocation('test.localhost:8080', [])).toBe('test.localhost%3A8080');
    expect(() => webvhLocation('example.com', ['..'])).toThrow();
    expect(() => webvhLocation('example.com', ['a/b'])).toThrow();
  });
});

describe('previews and body modes (P9.30)', () => {
  test('T9-089: a version that is not an image, with no preview supplied, names none and signs body none', async () => {
    expect(await choosePreview({ bytes: new TextEncoder().encode('# x'), mediaType: 'text/markdown' })).toMatchObject({ body: 'none' });
    expect(await choosePreview({ bytes: new TextEncoder().encode('# x'), mediaType: 'text/markdown', body: 'full' })).toMatchObject({ body: 'full' });
  });

  test('T9-094: an author-supplied preview of a non-image is named; one over 8,192 bytes is refused', async () => {
    const p = await choosePreview({ bytes: new TextEncoder().encode('# x'), mediaType: 'text/markdown', preview: { bytes: new TextEncoder().encode('thumb'), mediaType: 'text/plain' } });
    expect(p).toMatchObject({ body: 'preview', preview: { descriptor: { mediaType: 'text/plain', size: 5 } } });
    await expect(choosePreview({ bytes: new Uint8Array(1), mediaType: 'text/plain', preview: { bytes: new Uint8Array(8193), mediaType: 'text/plain' } })).rejects.toThrow(/8,192/);
  });

  test('T9-091: an image the writer cannot decode names no preview, and says so', async () => {
    const p = await choosePreview({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' });
    expect(p.body).toBe('none');
    expect(p.message).toMatch(/no preview/);
  });
});

describe('the anchoring entry, the local copy and the disclosure (P9.10, P9.18)', () => {
  test('T9-039, T9-040: the local copy verifies through the anchoring entry, and is never current', async () => {
    const { ref } = await author('local');
    const bytes = new TextEncoder().encode('# Notes\n');
    const g = await createGenesis({ name: 'Notes', bytes, mediaType: 'text/markdown', network: 'regtest', author: ref });
    const a = await createAnchoringEntry(g, { sat: 123n, network: 'regtest', body: 'full', author: ref });
    expect((a.state.asset as { aliases: string[] }).aliases).toEqual(['did:btco:reg:123']);
    const c = await checkLocalCopy([g, a], ref, bytes);
    expect(c.problems).toEqual([]);
    expect(c.ok).toBe(true);
    expect((c.report.axes as { state: string }).state).not.toBe('current');
    expect(c.report.reason).toMatch(/local copy/);
  });

  test('T9-038: when the identity evidence does not verify, the local copy fails and the SDK refuses', async () => {
    const { ref } = await author('refuse');
    const other = await author('other');
    const bytes = new TextEncoder().encode('# Notes\n');
    const g = await createGenesis({ name: 'Notes', bytes, mediaType: 'text/markdown', network: 'regtest', author: ref });
    const a = await createAnchoringEntry(g, { sat: 123n, network: 'regtest', body: 'none', author: ref });
    const c = await checkLocalCopy([g, a], { ...ref, log: other.ref.log }, bytes);
    expect(c.ok).toBe(false);
  });

  test('T9-083: before inscribing, the author is told the body mode, what is public and permanent, what Bitcoin will not hold and the cost', () => {
    const d = disclosure({ name: 'Harbor', mediaType: 'image/png', bytes: 2_000_000, body: 'preview', previewMessage: 'a 512x384 WebP preview', parts: 1, feeSats: 2500n, feeRate: 1, network: 'mainnet', author: 'did:webvh:x' });
    const text = d.lines.join('\n');
    expect(text).toMatch(/Body: a preview/);
    expect(text).toMatch(/permanent on Bitcoin mainnet/);
    expect(text).toMatch(/will NOT hold the version/);
    expect(text).toMatch(/2500 sats/);
    expect(disclosure({ name: 'x', mediaType: 'image/svg+xml', bytes: 10, body: 'full', previewMessage: '', parts: 1, feeSats: 1n, feeRate: 1, network: 'mainnet', author: 'a' }).lines.join()).toMatch(/active content/);
  });
});

describe('commit and reveal (P14.12, P9.32)', () => {
  test('the chain carries the funding output\'s first sat at input 0 and offset 0 to the holder; envelopes in the reveal tapscripts', async () => {
    const { ref } = await author('chain');
    const bytes = new TextEncoder().encode('x'.repeat(300));
    const g = await createGenesis({ name: 'Big', bytes, mediaType: 'text/plain', network: 'regtest', author: ref });
    const a = await createAnchoringEntry(g, { sat: 5n, network: 'regtest', body: 'full', author: ref });
    const parts = anchoringPublication([g, a], ref, bytes);
    const secret = new Uint8Array(32).fill(9);
    const holder = btc.p2tr(new Uint8Array(32).fill(2), undefined, scureNetwork('regtest')).address!;
    const p = plan({ secret, network: 'regtest', envelopes: parts.map((x) => x.envelope), holder, feeRate: 2, postage: 1000n });
    const signed = signChain({ secret, network: 'regtest', envelopes: parts.map((x) => x.envelope), holder, feeRate: 2, funding: { txid: 'ab'.repeat(32), vout: 1, amount: p.fundingAmount } });
    expect(signed.postage).toBe(1000n);
    const txs = signed.hex.map((h) => parseTransaction(h));
    expect(txs[0].inputs[0]).toMatchObject({ txid: 'ab'.repeat(32), vout: 1 });
    for (let k = 1; k < txs.length; k++) {
      expect(txs[k].inputs[0]).toMatchObject({ txid: txs[k - 1].txid, vout: 0 });
      expect(txs[k].inputs).toHaveLength(1);
      const [env] = envelopesInWitness(txs[k].inputs[0].witness);
      expect(readInscription(env).kind).toBe('originals');
    }
    expect(txs.map((t) => t.txid)).toEqual(signed.txids);
    expect(btc.Address(scureNetwork('regtest')).encode(btc.OutScript.decode(txs.at(-1)!.outputs[0].script))).toBe(holder);
    expect(fundingAddress(secret, 'regtest').address).toMatch(/^bcrt1p/);
  });

  test('a holder address of another network is refused', () => {
    expect(() => checkAddress('bc1pqgmca7tc3vrl9mg2p309yc55ee4lpnvwja33jt9dmxjcptr7skgq4z35uq', 'regtest')).toThrow(/regtest/);
  });
});

describe('describing the transfer check (P7.22, T7-074)', () => {
  const report = (diagnostics: Array<{ code: string; item: { kind: string; id: string } }>) => ({
    type: 'OriginalsVerificationReport', profile: 'og:1.0-draft.1', original: 'did:og:x', checkpoint: '2-x', evidence: { inputs: [], network: 'regtest', tip: { height: 120, hash: 'h' }, depth: 1 },
    axes: { outcome: 'verified', binding: 'bound', history: 'valid', identity: 'complete', authority: 'current', state: 'current', availability: 'complete', offline: 'self-contained', bitcoin: 'anchored' },
    entries: [], signers: [], diagnostics: diagnostics.map((d) => ({ ...d, rule: 'P7.22', reason: '' })),
    bitcoin: { sat: 'did:btco:reg:5', holder: { address: 'bcrt1pnew', uniqueness: 'provisional' }, conflictingAnchors: [], unverifiable: [], waiting: [] },
  }) as never;

  test('it is a check on the publication history, never 6 confirmations of the transfer', () => {
    const text = describeTransferCheck(report([]));
    expect(text).toMatch(/^Transfer check on the Original's publication history/);
    expect(text).toMatch(/passes/);
    expect(text).toMatch(/does not check how deep the transaction that last moved the sat is/);
    expect(text).not.toMatch(/confirmations of the transfer|transfer has \d+ confirmations|\(6 confirmations\)/i);
  });

  test('a shallow publication fails it and is named', () => {
    const text = describeTransferCheck(report([{ code: 'insufficient-depth', item: { kind: 'inscription', id: 'abci0' } }]));
    expect(text).toMatch(/fails: 1 publication\(s\) of the history are fewer than 6 blocks deep \(abci0\)/);
  });
});
