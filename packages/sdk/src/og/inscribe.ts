/**
 * Commit and reveal transactions for a did:og publication, with no pointer
 * (P14.12): ord puts an inscription on the first sat of the input carrying
 * it, so every transaction spends the sat at input 0 and sends it, at offset
 * 0, to output 0. The chain is:
 *
 *   funding output (key path, which the author funds; its first sat is the anchoring sat)
 *     -> commit: output 0 commits to part 1's reveal script
 *     -> reveal part 1: output 0 commits to part 2's script ... -> reveal of the final part: output 0 to the holder
 *
 * The sat is known once the funding output confirms, so the anchoring entry,
 * which names it, is signed before any reveal script exists (P9.10).
 */
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { BitcoinNetwork } from "@originals/vh/og";

export type BtcNet = typeof btc.NETWORK;

export function scureNetwork(network: BitcoinNetwork): BtcNet {
  if (network === "mainnet") return btc.NETWORK;
  if (network === "regtest") return { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
  return btc.TEST_NETWORK;
}

/** ord's reveal script: `<x-only key> OP_CHECKSIG`, then the envelope. */
const leafOf = (pub: Uint8Array, envelope: Uint8Array) => new Uint8Array([0x20, ...pub, 0xac, ...envelope]);

function scriptOutput(pub: Uint8Array, envelope: Uint8Array, net: BtcNet) {
  return btc.p2tr(pub, { script: leafOf(pub, envelope) }, net, true);
}

export function fundingAddress(secret: Uint8Array, network: BitcoinNetwork): { address: string; script: Uint8Array } {
  const pub = schnorr.getPublicKey(secret);
  const p = btc.p2tr(pub, undefined, scureNetwork(network));
  return { address: p.address, script: p.script };
}

/** Check that an address belongs to the network (and is not the funding address). */
export function checkAddress(address: string, network: BitcoinNetwork): Uint8Array {
  try {
    return btc.OutScript.encode(btc.Address(scureNetwork(network)).decode(address));
  } catch (error) {
    throw new Error(`${address} is not a ${network} address: ${(error as Error).message}`);
  }
}

interface Prev {
  txid: string;
  vout: number;
  amount: bigint;
}

function revealTx(secret: Uint8Array, pub: Uint8Array, prev: Prev, envelope: Uint8Array, to: Uint8Array, amount: bigint, net: BtcNet): btc.Transaction {
  const pay = scriptOutput(pub, envelope, net);
  const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, allowLegacyWitnessUtxo: true });
  tx.addInput({ txid: prev.txid, index: prev.vout, witnessUtxo: { script: pay.script, amount: prev.amount }, tapLeafScript: pay.tapLeafScript, tapInternalKey: pub });
  tx.addOutput({ script: to, amount });
  const [cb, scriptVer] = pay.tapLeafScript![0];
  const leaf = scriptVer.subarray(0, -1);
  const msg = tx.preimageWitnessV1(0, [pay.script], btc.SigHash.DEFAULT, [prev.amount], undefined, leaf, 0xc0);
  tx.updateInput(0, { finalScriptWitness: [schnorr.sign(msg, secret), leaf, btc.TaprootControlBlock.encode(cb)] }, true);
  return tx;
}

function commitTx(secret: Uint8Array, pub: Uint8Array, funding: Prev, fundingScript: Uint8Array, to: Uint8Array, amount: bigint): btc.Transaction {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: funding.txid, index: funding.vout, witnessUtxo: { script: fundingScript, amount: funding.amount }, tapInternalKey: pub });
  tx.addOutput({ script: to, amount });
  tx.signIdx(secret, 0);
  tx.finalize();
  return tx;
}

export interface PlanInput {
  secret: Uint8Array;
  network: BitcoinNetwork;
  envelopes: Uint8Array[];
  holder: string;
  feeRate: number;
  /** What the sat keeps at the holder's output. */
  postage: bigint;
}

export interface Plan {
  /** Fees of the commit and each reveal, in sats. */
  fees: bigint[];
  /** The exact amount to send to the funding address. */
  fundingAmount: bigint;
  vsizes: number[];
}

/** Size the chain from the transactions themselves, at the fee rate (P9.18: tell the cost first). */
export function plan(input: PlanInput): Plan {
  const net = scureNetwork(input.network);
  const pub = schnorr.getPublicKey(input.secret);
  const holder = checkAddress(input.holder, input.network);
  const dummy: Prev = { txid: "00".repeat(32), vout: 0, amount: 100_000_000n };
  const funding = fundingAddress(input.secret, input.network);
  const vsizes = [commitTx(input.secret, pub, dummy, funding.script, scriptOutput(pub, input.envelopes[0], net).script, 1000n).vsize];
  input.envelopes.forEach((env, k) => {
    const to = k + 1 < input.envelopes.length ? scriptOutput(pub, input.envelopes[k + 1], net).script : holder;
    vsizes.push(revealTx(input.secret, pub, dummy, env, to, 1000n, net).vsize);
  });
  const fees = vsizes.map((v) => BigInt(Math.ceil(v * input.feeRate)));
  return { fees, vsizes, fundingAmount: fees.reduce((a, b) => a + b, 0n) + input.postage };
}

export interface Signed {
  /** Raw transactions in broadcast order: commit, then each reveal. */
  hex: string[];
  txids: string[];
  /** The value the holder's output keeps. */
  postage: bigint;
  fees: bigint[];
}

/** Build and sign the chain spending the funding output, at the planned fee rate. */
export function signChain(input: Omit<PlanInput, "postage"> & { funding: Prev }): Signed {
  const net = scureNetwork(input.network);
  const pub = schnorr.getPublicKey(input.secret);
  const holder = checkAddress(input.holder, input.network);
  const funding = fundingAddress(input.secret, input.network);
  const scripts = input.envelopes.map((e) => scriptOutput(pub, e, net).script);
  // Fees from the real sizes; whatever the funding output holds beyond them stays with the sat.
  const p = plan({ ...input, postage: 0n });
  const total = p.fees.reduce((a, b) => a + b, 0n);
  if (input.funding.amount - total < 546n) throw new Error(`the funding output holds ${input.funding.amount} sats; it needs at least ${total + 546n}`);
  const txs: btc.Transaction[] = [];
  let value = input.funding.amount - p.fees[0];
  txs.push(commitTx(input.secret, pub, input.funding, funding.script, scripts[0], value));
  let prev: Prev = { txid: txs[0].id, vout: 0, amount: value };
  input.envelopes.forEach((env, k) => {
    value -= p.fees[k + 1];
    const to = k + 1 < input.envelopes.length ? scripts[k + 1] : holder;
    const tx = revealTx(input.secret, pub, prev, env, to, value, net);
    txs.push(tx);
    prev = { txid: tx.id, vout: 0, amount: value };
  });
  return { hex: txs.map((t) => t.hex), txids: txs.map((t) => t.id), postage: value, fees: p.fees };
}

export const hex = { encode: bytesToHex, decode: hexToBytes };
