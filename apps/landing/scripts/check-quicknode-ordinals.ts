/**
 * Pre-deploy check for the two external reads the money path depends on.
 *
 *   BTC_NETWORK=mainnet QUICKNODE_ENDPOINT=... \
 *     bun run apps/landing/scripts/check-quicknode-ordinals.ts
 *
 * 1. The QuickNode **Ordinals & Runes add-on** — `getFirstSatOfOutput`, the
 *    call that derives a did:btco identity. This is what actually gates
 *    inscription; without it the mainnet flow cannot complete at all.
 * 2. The **deposit indexer seam** (BTC_INDEXER_API / BTC_INDEXER_TOKEN, see
 *    server/bitcoin.ts) — the address→UTXO read behind every deposit. Checked
 *    only when an address is supplied, since it needs one to probe.
 *
 * QuickNode is deliberately NOT the indexer: measured against the live mainnet
 * endpoint, Core there has no address index, `scantxoutset` is blocked at the
 * edge, and the Ordinals add-on maps outpoint→address and sat→address but
 * never address→UTXOs. The two reads are separate vendors on purpose.
 *
 * Address to probe (optional, in order): BTC_CHECK_ADDRESS, BTC_FAUCET_ADDRESS.
 * Outpoint to probe (optional, skips the indexer entirely): BTC_CHECK_OUTPOINT
 * as `txid:vout`. On mainnet with neither, the Ordinals check is skipped and
 * the script exits non-zero — a check that cannot check is not a pass.
 */
import { QuickNodeProvider } from '@originals/sdk';
import { fetchFaucetUtxos, resolveIndexer, serverBtcNetwork, IndexerError } from '../server/bitcoin';

const endpoint = process.env.QUICKNODE_ENDPOINT;
if (!endpoint) {
  console.error('Set QUICKNODE_ENDPOINT (the endpoint this deploy will use, WITH the Ordinals & Runes add-on).');
  process.exit(1);
}

const chain = serverBtcNetwork(process.env); // mainnet | testnet4
const network = chain === 'mainnet' ? 'mainnet' : 'testnet';
const indexer = resolveIndexer(process.env, network);
const address = process.env.BTC_CHECK_ADDRESS ?? process.env.BTC_FAUCET_ADDRESS;
const outpointEnv = process.env.BTC_CHECK_OUTPOINT;

console.log(`Checking a ${chain} deploy.`);
console.log(`  QuickNode: ${new URL(endpoint).host}`);
console.log(`  Deposit indexer: ${indexer.api}${indexer.authToken ? ' (authenticated)' : ' (no token — free public tier)'}`);
if (chain === 'mainnet' && !process.env.BTC_INDEXER_API) {
  console.warn(
    '  ⚠ BTC_INDEXER_API is unset — mainnet deposit reads will run against the free public API,\n' +
      '    unauthenticated and rate-limited at its discretion. Sanctioned (KTD4), but know that you chose it.'
  );
}

const provider = new QuickNodeProvider({ endpoint, expectedNetwork: network });

/** The outpoint to ask the Ordinals add-on about. */
let probe: { txid: string; vout: number };

if (outpointEnv) {
  const [txid, vout] = outpointEnv.split(':');
  if (!/^[0-9a-f]{64}$/i.test(txid ?? '') || !/^\d+$/.test(vout ?? '')) {
    console.error(`BTC_CHECK_OUTPOINT must be "txid:vout"; got "${outpointEnv}".`);
    process.exit(1);
  }
  probe = { txid, vout: Number(vout) };
} else if (address) {
  // Doubles as the indexer check: this is the exact call the deposit route makes.
  let utxos: Awaited<ReturnType<typeof fetchFaucetUtxos>>;
  try {
    utxos = await fetchFaucetUtxos({ ...indexer, address, network });
  } catch (e) {
    const err = e as IndexerError;
    console.error(`❌ The deposit indexer (${indexer.api}) could not be read: ${err.message}`);
    if (err.kind === 'rate_limited') {
      console.error('   → rate-limited. On the free tier this is what a busy deploy looks like; set BTC_INDEXER_API + BTC_INDEXER_TOKEN.');
    }
    process.exit(1);
  }
  console.log(`✅ Deposit indexer reachable — ${utxos.length} confirmed UTXO(s) at ${address}.`);
  if (utxos.length === 0) {
    console.error(`No confirmed UTXOs at ${address} — fund it (or set BTC_CHECK_OUTPOINT) so the Ordinals add-on can be checked.`);
    process.exit(1);
  }
  probe = { txid: utxos[0].txid, vout: utxos[0].vout };
} else {
  console.error(
    'No outpoint to probe. Set BTC_CHECK_OUTPOINT=txid:vout (any confirmed mainnet outpoint) or\n' +
      'BTC_CHECK_ADDRESS to an address with a confirmed UTXO. The Ordinals add-on is what gates\n' +
      'inscription, so an unverified endpoint is not a pass.'
  );
  process.exit(1);
}

try {
  const sat = await provider.getFirstSatOfOutput!(probe);
  console.log(`✅ Ordinals & Runes add-on works on ${chain}.`);
  console.log(`   first sat of ${probe.txid}:${probe.vout} = ${sat}`);
  console.log(`   → real ${chain} inscription is viable on this endpoint.`);
} catch (e) {
  const msg = (e as Error).message;
  if (/serves chain|configured for/.test(msg)) {
    console.error(`❌ Network-guard mismatch (NOT an add-on problem): ${msg}`);
    console.error(`   → this endpoint is not on ${chain}. Point QUICKNODE_ENDPOINT at a ${chain} endpoint, or fix BTC_NETWORK.`);
  } else {
    console.error(`❌ getFirstSatOfOutput failed — the QuickNode Ordinals & Runes add-on is likely NOT enabled on this endpoint.`);
    console.error(`   ${msg}`);
    console.error(`   → enable the add-on for this endpoint, or self-host ord + bitcoind. Inscription cannot ship without it.`);
  }
  process.exit(1);
}
