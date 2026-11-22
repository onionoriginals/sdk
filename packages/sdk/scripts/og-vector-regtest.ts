// T14-093 with the SDK as the second implementation: inscribe the spec's bitcoin vector on a
// real regtest chain with this SDK's commit/reveal builder (no pointer, both parts on one
// sat), read it back through ord 0.29.x with this SDK's reader, and compare the report this
// SDK computes with the vector's expected report, substituting only chain-dependent values.
// Part 1 is the vector's envelope byte for byte; the vector's sat is synthetic, so entry 4,
// the anchoring entry, is re-signed with the vector's test key for the real sat.
// Run: bun packages/sdk/scripts/og-vector-regtest.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { localSigner } from '@originals/vh/crypto';
import { encodeEnvelope, encodeMetadata, prepareNext, readInscription, resourceDigest, signEntry, verifyOriginal, type OgEntry } from '@originals/vh/og';
import { readSatEvidence } from '../src/og/evidence.js';
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
    const env1 = vread('bitcoin/inscriptions/part-1.envelope.bin');
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
    const report = await verifyOriginal(read.evidence);

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
      .replaceAll(vectorRead.holder.address, holder);
    const want = JSON.parse(text);
    want.evidence.tip = read.evidence.tip;
    // The sat-read input is the index read on this chain: its source and digest are chain-dependent.
    want.evidence.inputs = want.evidence.inputs.map((i: { kind: string }) => (i.kind === 'sat-read' ? report.evidence.inputs.find((x) => x.kind === 'sat-read') : i));
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
    if (!part1Same) diffs.push('part 1 as read from ord differs from the vector envelope');
    if (read.inscriptions.length !== 2) diffs.push(`ord lists ${read.inscriptions.length} inscriptions on the sat`);
    const result = {
      gate: 'T14-093 with @originals/sdk and @originals/vh as the implementation (plan 051)', date: new Date().toISOString().slice(0, 10),
      bitcoind: rt.versions.bitcoind, ord: rt.versions.ord, passed: diffs.length === 0, sat: sat.toString(), anchoringAlias: BTCO, holder,
      transactions: { funding: fundTxid, commit: signed.txids[0], revealPart1: signed.txids[1], revealPart2: signed.txids[2] },
      inscriptions: read.inscriptions.map(({ envelope, ...x }) => ({ ...x, envelopeBytes: envelope.length, envelopeDigest: resourceDigest(envelope) })),
      part1EnvelopeMatchesVector: part1Same, anchoringEntry: e4.versionId, tip: read.evidence.tip, report, differences: diffs,
    };
    writeFileSync(join(import.meta.dir, 'og-vector-regtest.last-run.json'), JSON.stringify(result, null, 2) + '\n');
    if (diffs.length) { for (const d of diffs) console.error('MISMATCH', d); throw new Error(`${diffs.length} differences from the expected report`); }
    log('PASS: the report this SDK computes from ord\'s reads equals the vector\'s expected report');
  } finally {
    rt.cleanup();
  }
}

main().catch((e) => { console.error('[og-vector-regtest] FAIL', e?.stack ?? e); process.exitCode = 1; });
