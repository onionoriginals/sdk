/**
 * Confirm your QuickNode testnet4 endpoint's Ordinals add-on actually returns
 * sat ranges — the one external unknown that decides whether real testnet4
 * inscription is even possible on your setup.
 *
 *   QUICKNODE_ENDPOINT=... BTC_FAUCET_ADDRESS=tb1q... \
 *     bun run apps/landing/scripts/check-quicknode-ordinals.ts
 *
 * It fetches a confirmed UTXO of your funded faucet address (via mempool.space
 * testnet4) and asks QuickNode for its first sat — the exact call the inscription
 * path uses to derive the did:btco identity. Method-not-found ⇒ the add-on does
 * not cover testnet4, and you'll need a self-hosted ord+bitcoind instead.
 */
import { QuickNodeProvider } from '@originals/sdk';
import { fetchFaucetUtxos } from '../server/bitcoin';

const endpoint = process.env.QUICKNODE_ENDPOINT;
const address = process.env.BTC_FAUCET_ADDRESS;
if (!endpoint || !address) {
  console.error('Set QUICKNODE_ENDPOINT and BTC_FAUCET_ADDRESS (a funded tb1q… testnet4 address).');
  process.exit(1);
}

const api = process.env.MEMPOOL_TESTNET4_API ?? 'https://mempool.space/testnet4/api';
const provider = new QuickNodeProvider({ endpoint, expectedNetwork: 'testnet' });

const utxos = await fetchFaucetUtxos({ api, address });
if (utxos.length === 0) {
  console.error(`No confirmed UTXOs at ${address} — fund it from a testnet4 faucet first.`);
  process.exit(1);
}

const u = utxos[0];
try {
  const sat = await provider.getFirstSatOfOutput!({ txid: u.txid, vout: u.vout });
  console.log(`✅ Ordinals add-on works on testnet4.`);
  console.log(`   first sat of ${u.txid}:${u.vout} = ${sat}`);
  console.log(`   → real testnet4 inscription is viable on this endpoint.`);
} catch (e) {
  const msg = (e as Error).message;
  if (/serves chain|configured for/.test(msg)) {
    console.error(`❌ Network-guard mismatch (NOT an add-on problem): ${msg}`);
    console.error(`   → update @originals/sdk (CHAIN_TO_NETWORK must map your endpoint's chain to 'testnet') and rebuild.`);
  } else {
    console.error(`❌ getFirstSatOfOutput failed — the QuickNode Ordinals add-on likely does NOT cover testnet4.`);
    console.error(`   ${msg}`);
    console.error(`   → use a self-hosted ord + bitcoind on testnet4 instead.`);
  }
  process.exit(1);
}
