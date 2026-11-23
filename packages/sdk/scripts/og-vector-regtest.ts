// T14-093 with the SDK as the second implementation: inscribe the spec's bitcoin vector on a
// real regtest chain with this SDK's commit/reveal builder (no pointer, both parts on one
// sat), read it back through ord 0.29.x with this SDK's reader, and compare the report this
// SDK computes with the vector's expected report, substituting only chain-dependent values.
// Part 1 is the vector's envelope with no signers member (D22: inscriptions carry no signer
// history; for a vector written before D22 the member is dropped and the rest keeps its bytes'
// member order, otherwise it is the vector's envelope byte for byte). The vector's sat is synthetic,
// so entry 4, the anchoring entry, is re-signed with the vector's test key for the real sat. The
// author's log is supplied to the verifier as resolved (P7.8, P7.17), not read from Bitcoin.
// Run: bun packages/sdk/scripts/og-vector-regtest.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { localSigner } from '@originals/vh/crypto';
import { encodeEnvelope, encodeMetadata, prepareNext, readInscription, resourceDigest, signEntry, verifyOriginal, type OgEntry } from '@originals/vh/og';
import { didWebvhLogUrl } from '@originals/vh/webvh';
import { readSatEvidence, withResolvedSigner } from '../src/og/evidence.js';
import { fundingAddress, plan, signChain } from '../src/og/inscribe.js';
import { startRegtest } from './og-regtest-harness.js';

const VEC = join(import.meta.dir, '..', '..', 'vh', 'tests', 'fixtures', 'og-vectors', 'og-1.0-draft.1');
const vread = (p: string) => new Uint8Array(readFileSync(join(VEC, p)));
const vjson = (p: string) => JSON.parse(readFileSync(join(VEC, p), 'utf8'));
const log = (...a: unknown[]) => console.log('[og-vector-regtest]', ...a);

async function main() {
  const rt = await startRegtest({ label: 'og-vector-regtest', keep: process.argv.includes('--keep') });
  try {
    log(rt.versions.bitcoind, '/', rt.versions.ord);
    const vectorEnv1 = vread('bitcoin/inscriptions/part-1.envelope.bin');
    const env1 = withoutSigners(vectorEnv1);
    const env2v = vread('bitcoin/inscriptions/part-2.envelope.bin');
    const r1 = readInscription(env1), r2 = readInscription(env2v);
    if (r1.kind !== 'originals' || r2.kind !== 'originals') throw new Error('vector envelopes do not read');
    const e3 = r1.metadata.entries.at(-1) as OgEntry;
    const e4v = r2.metadata.entries[0] as OgEntry;
    const v2 = vread('local/resources/v2.md');

    // Fund the key-path output whose first sat becomes the anchoring sat.
    const secret = new Uint8Array(randomBytes(32));
    const holder = await rt.wallet<string>('getnewaddress', ['', 'bech32m']);
    const p = plan({ secret, network: 'regtest', envelopes: [env1, env2v], holder, feeRate: 2, postage: 10_000n });
    const funding = fundingAddress(secret, 'regtest');
    const fundTxid = await rt.wallet<string>('sendtoaddress', [funding.address, Number(p.fundingAmount) / 1e8]);
    await rt.mine(1);
    await rt.ordSync();
    const utxo = (await rt.core.utxos(funding.address)).find((u) => u.txid === fundTxid)!;
    const sat = await rt.ord.firstSat(`${utxo.txid}:${utxo.vout}`);
    const BTCO = `did:btco:reg:${sat}`;
    log('sat', sat, 'funding', fundTxid);

    // Entry 4 for the real sat, signed with the vector's test key (its seed is published).
    const key = localSigner('Ed25519', sha256(new TextEncoder().encode('originals-spec test vector seed: author assertionMethod key-1')));
    const state = JSON.parse(JSON.stringify(e4v.state));
    state.asset.aliases = state.asset.aliases.map((a: string) => (a.startsWith('did:btco:') ? BTCO : a));
    const e4 = await signEntry(prepareNext(e3, { versionTime: e4v.versionTime, parameters: e4v.parameters, state }), (e3.state.author as { verificationMethod: string }).verificationMethod, key);
    const env2 = encodeEnvelope({ contentType: 'text/markdown', metadata: encodeMetadata({ entries: [e4], part: [2, 2] }), body: v2 });

    const signed = signChain({ secret, network: 'regtest', envelopes: [env1, env2], holder, feeRate: 2, funding: { txid: utxo.txid, vout: utxo.vout, amount: utxo.value } });
    for (const hex of signed.hex) await rt.core.broadcast(hex);
    await rt.mine(1);
    await rt.mine(8);
    await rt.ordSync();
    const read = await readSatEvidence({ original: vjson('index.json').original, network: 'regtest', sat, ord: rt.ord, chain: rt.core });
    // D22: the author's log, as a resolver would return it from its URL, supplied as a signer history.
    const authorDid = vjson('index.json').author as string;
    const authorUrl = didWebvhLogUrl(authorDid);
    const obtained = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const evidence = withResolvedSigner(read.evidence, { did: authorDid, url: authorUrl, log: new TextDecoder().decode(vread('local/author/did.jsonl')), obtained });
    const report = await verifyOriginal(evidence);

    // The expected report, with only chain-dependent values substituted.
    const expected = vjson('bitcoin/expected-report.json');
    const chain = vjson('bitcoin/chain.json');
    const vectorRead = vjson('bitcoin/sat-read.json');
    const [part1, part2] = read.inscriptions;
    let text = JSON.stringify(expected)
      .replaceAll(`did:btco:reg:${vectorRead.sat}`, BTCO)
      .replaceAll(e4v.versionId, e4.versionId)
      .replaceAll(chain.inscriptions[0].id, part1.id)
      .replaceAll(chain.inscriptions[1].id, part2.id)
      .replaceAll(resourceDigest(env2v), resourceDigest(env2))
      .replaceAll(resourceDigest(vectorEnv1), resourceDigest(env1)) // the same unless the vector predates D22
      .replaceAll(vectorRead.holder.address, holder);
    const want = JSON.parse(text);
    want.evidence.tip = read.evidence.tip;
    // The sat-read input is the index read on this chain: its source and digest are chain-dependent.
    want.evidence.inputs = want.evidence.inputs.map((i: { kind: string }) => (i.kind === 'sat-read' ? report.evidence.inputs.find((x) => x.kind === 'sat-read') : i));
    // The resolved author log is resolution-dependent: its input, and the signer label's source, obtained
    // time and freshness (a vector written before D22 has neither: its label names the inscription).
    const resolvedInput = report.evidence.inputs.find((x) => x.kind === 'signer-history');
    if (resolvedInput && !want.evidence.inputs.some((i: { kind: string }) => i.kind === 'signer-history')) want.evidence.inputs.push(resolvedInput);
    want.signers = want.signers.map((x: { did: string }) => {
      const got = report.signers.find((y) => y.did === x.did);
      return got ? { ...x, source: got.source, obtained: got.obtained, freshness: got.freshness } : x;
    });
    for (const e of want.entries) e.block = part2.height;
    const diffs: string[] = [];
    const walk = (a: unknown, b: unknown, path: string) => {
      if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
        if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${path}: expected ${JSON.stringify(a)}, got ${JSON.stringify(b)}`);
        return;
      }
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    };
    // P14.25: reports compare as JSON values, ignoring each diagnostic's reason.
    const noReason = (r: { diagnostics?: Array<{ reason?: string }> }) => ({ ...r, diagnostics: (r.diagnostics ?? []).map(({ reason: _r, ...d }) => d) });
    walk(noReason(want), noReason(report), 'report');
    const part1Same = Buffer.compare(Buffer.from(part1.envelope), Buffer.from(env1)) === 0;
    if (!part1Same) diffs.push('part 1 as read from ord differs from the vector envelope (without signers)');
    if (read.inscriptions.length !== 2) diffs.push(`ord lists ${read.inscriptions.length} inscriptions on the sat`);
    const result = {
      gate: 'T14-093 with @originals/sdk and @originals/vh as the implementation (plan 051)', date: new Date().toISOString().slice(0, 10),
      bitcoind: rt.versions.bitcoind, ord: rt.versions.ord, passed: diffs.length === 0, sat: sat.toString(), anchoringAlias: BTCO, holder,
      transactions: { funding: fundTxid, commit: signed.txids[0], revealPart1: signed.txids[1], revealPart2: signed.txids[2] },
      inscriptions: read.inscriptions.map(({ envelope, ...x }) => ({ ...x, envelopeBytes: envelope.length, envelopeDigest: resourceDigest(envelope) })),
      part1EnvelopeMatchesVector: part1Same, part1VectorHadSigners: !bytesEqual(vectorEnv1, env1), resolvedAuthorLog: { did: authorDid, url: authorUrl, obtained }, anchoringEntry: e4.versionId, tip: read.evidence.tip, report, differences: diffs,
    };
    writeFileSync(join(import.meta.dir, 'og-vector-regtest.last-run.json'), JSON.stringify(result, null, 2) + '\n');
    if (diffs.length) { for (const d of diffs) console.error('MISMATCH', d); throw new Error(`${diffs.length} differences from the expected report`); }
    log('PASS: the report this SDK computes from ord\'s reads equals the vector\'s expected report');
  } finally {
    rt.cleanup();
  }
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The envelope as a D22 writer writes it: the metadata's entries and part in the vector's own member order, and no
 * signers member (the reader drops it). For a vector with no signers member this is the vector's envelope, byte for byte.
 */
function withoutSigners(env: Uint8Array): Uint8Array {
  const r = readInscription(env);
  if (r.kind !== 'originals') throw new Error('the vector envelope does not read');
  return encodeEnvelope({ contentType: r.contentType, metadata: encodeMetadata(r.metadata, { keepOrder: true }), body: r.body });
}

main().catch((e) => { console.error('[og-vector-regtest] FAIL', e?.stack ?? e); process.exitCode = 1; });
