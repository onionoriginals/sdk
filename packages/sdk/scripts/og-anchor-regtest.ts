// End-to-end regtest run of the did:og anchoring command (plan 051): Bitcoin Core and ord
// 0.29.x on regtest in a temporary directory, a local HTTP server standing in for the
// author DID's host, and the command's own steps: author, prepare, fund, broadcast, verify.
// The inscriptions carry no signer history (D22): verify resolves the author's did.jsonl from
// that host and supplies it to the verifier as the resolved signer history.
// Run: bun packages/sdk/scripts/og-anchor-regtest.ts [--image] [--keep]
// Regtest only; nothing outside the temporary directory is written except the run record.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyFile } from '../src/og/keys.js';
import { loadState, stepAuthor, stepBroadcast, stepFund, stepPrepare, stepVerify, type Ctx } from '../src/og/anchor.js';
import { freePort, sleep, startRegtest } from './og-regtest-harness.js';

const image = process.argv.includes('--image');
// --large: a 348,000-byte version inscribed in full, so the publication is in parts on one sat (P9.32).
const large = process.argv.includes('--large');
const keep = process.argv.includes('--keep');
const log = (...a: unknown[]) => console.log('[og-regtest]', ...a);
let httpServer: ReturnType<typeof Bun.serve> | undefined;

async function main() {
  const rt = await startRegtest({ label: 'og-anchor-regtest', keep });
  const { tmp, core, ord, mine, ordSync } = rt;
  const w = rt.wallet;
  const bitcoindVersion = rt.versions.bitcoind, ordVersion = rt.versions.ord;
  log(bitcoindVersion, '/', ordVersion, '/', tmp);
  const httpPort = await freePort();
  try {
  // The author DID's host: serves whatever did.jsonl the test publishes, like originals.build would.
  const served = new Map<string, string>();
  httpServer = Bun.serve({ port: httpPort, hostname: '127.0.0.1', fetch: (req) => {
    const body = served.get(new URL(req.url).pathname);
    return body ? new Response(body, { headers: { 'content-type': 'application/jsonl', 'access-control-allow-origin': '*' } }) : new Response('not found', { status: 404 });
  } });

  const stateDir = join(tmp, 'state');
  const keyFile = join(tmp, 'author-keys.json');
  generateKeyFile(keyFile);
  const holder = await w<string>('getnewaddress', ['', 'bech32m']);
  let blocksAfterBroadcast = false;
  const ctx: Ctx = {
    stateDir, keyFile, network: 'regtest', chain: core, ord, pollMs: 200, timeoutMs: 120_000,
    io: {
      say: (l) => console.log('   ', l),
      confirm: async () => true,
      sleep: async (ms) => { if (blocksAfterBroadcast) { await mine(1); await ordSync(); } await sleep(ms); },
    },
    // did:webvh resolves over HTTPS; this host is local, so the same path is fetched over HTTP, with no redirects.
    fetchAuthorLog: async (url) => {
      const path = new URL(url).pathname;
      const r = await fetch(`http://127.0.0.1:${httpPort}${path}`, { redirect: 'error' });
      return r.ok ? r.text() : null;
    },
  };

  // 1. author: a new did:webvh at localhost:<port>:authors:regtest-author; publish it, then it resolves.
  const s0 = await stepAuthor({ ...ctx, io: { ...ctx.io, confirm: async () => { const s = loadState(stateDir, 'regtest'); served.set(new URL(s.author!.url).pathname, s.author!.log); return true; } } }, { name: 'regtest-author', domain: `og-regtest.localhost:${httpPort}` });
  log('author', s0.author!.did, s0.author!.url);

  // 2. prepare: an Original from a file.
  const file = join(tmp, image ? 'harbor.png' : 'field-notes.md');
  let mediaType = 'text/markdown';
  if (image) {
    const { encode } = await import('@jsquash/png');
    const px = new Uint8ClampedArray(96 * 64 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 256));
    writeFileSync(file, new Uint8Array(await encode({ data: px, width: 96, height: 64, colorSpace: 'srgb' } as ImageData)));
    mediaType = 'image/png';
  } else if (large) {
    let t = '# Field notes\n\n';
    for (let i = 1; t.length < 348_000; i++) t += `Observation ${String(i).padStart(5, '0')}: the tide was lower than the day before.\n`;
    writeFileSync(file, t.slice(0, 347_999) + '\n');
  } else writeFileSync(file, '# Field notes\n\nAnchored on regtest by the originals-og command.\n');
  const s1 = await stepPrepare(ctx, { file, mediaType, name: image ? 'Harbor at dawn' : 'Field notes', body: image ? 'preview' : 'full', holder, feeRate: 2 });

  // 3. fund: the owner's wallet sends the exact amount; one confirmation.
  const amount = Number(BigInt(s1.reveal!.fundingAmount)) / 1e8;
  const fundTxid = await w<string>('sendtoaddress', [s1.reveal!.fundingAddress, amount]);
  log('funded', fundTxid, `${s1.reveal!.fundingAmount} sats`);
  await mine(1); await ordSync();
  await stepFund(ctx, { yes: true });

  // 4. broadcast; 5. verify (each wait mines a block on regtest).
  await stepBroadcast(ctx);
  blocksAfterBroadcast = true;
  const run = await stepVerify(ctx, { out: join(tmp, 'last-run.json') });
  const record = { gate: 'originals-og anchor on regtest (plan 051)', date: new Date().toISOString().slice(0, 10), bitcoind: bitcoindVersion, ord: ordVersion, image, large, ...run };
  const out = join(import.meta.dir, `og-anchor-regtest.last-run${image ? '.image' : large ? '.large' : ''}.json`);
  writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
  log(run.passed ? 'PASS' : 'FAIL', 'wrote', out);
  if (!run.passed) { console.error(JSON.stringify(run.report, null, 2)); process.exitCode = 1; }
  } finally {
    httpServer?.stop(true);
    rt.cleanup();
  }
}

main().catch((e) => { console.error('[og-regtest] FAIL', e?.stack ?? e); process.exitCode = 1; });
