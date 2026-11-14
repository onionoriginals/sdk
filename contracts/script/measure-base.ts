/**
 * Gas and fee measurement of the EXPERIMENTAL anchor contract on Base
 * mainnet (chain 8453), without spending anything (originals-spec PR 59,
 * P9.25, P9.27, P14.20-P14.22).
 *
 *   bun contracts/script/measure-base.ts [--rpc <public Base RPC>] [--out <file.json>]
 *
 * The RPC URL comes from `--rpc`, else `BASE_RPC_URL`, else
 * https://mainnet.base.org. The script:
 *
 * 1. Starts a local anvil FORKED from that endpoint at its latest block
 *    (`--network base --chain-id 8453 --enable-tx-gas-limit`), so execution
 *    runs on Base's state, gas schedule and predeploys, and Base's EIP-7825
 *    cap (Azul) applies. Every transaction goes to the local fork only, sent
 *    from anvil's unlocked, well-known dev accounts: no key is handled here.
 * 2. Deploys the contract through the deterministic deployment proxy with a
 *    zero salt (P14.21), checks the address and runtime code hash, then mints
 *    and publishes through the SDK writer (`prepareEvmPublication`,
 *    `submitEvmPublication`) and the SDK workflow (`OriginalsSDK`, for the
 *    move to Bitcoin and its departure publication).
 * 3. Prices each transaction on the LIVE endpoint with read-only calls only:
 *    `eth_feeHistory`, `eth_maxPriorityFeePerGas`, and `eth_call` to the
 *    GasPriceOracle predeploy (`getL1Fee` of the transaction's signed bytes
 *    from the fork, `getOperatorFee` of its gasUsed). It never sends a
 *    transaction to the public endpoint.
 * 4. Converts to USD at Coinbase's public ETH-USD spot price.
 *
 * Measurement only: nothing here is a deployment, and the contract stays
 * unaudited (contracts/README.md).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { localSigner } from "@originals/vh/crypto";
import { serializeLog, signWith, type LogEntry } from "@originals/vh/log";
import { EVM_CHAINS, createOriginal, derivedTokenAlias, resourceDigest, updateOriginal, type EvmAnchorPin } from "@originals/vh/originals";
import { encodeCall, fromHex, keccakHex, toHex } from "../../packages/sdk/src/originals/evm-abi.js";
import {
  EvmRpc,
  evmGenesisNotice,
  mintEvmToken,
  prepareEvmPublication,
  submitEvmPublication,
  waitForEvmReceipt,
  type EvmFetch,
  type EvmWallet,
  type EvmWriterContext,
} from "../../packages/sdk/src/originals/evm.js";
import { inscriptionMetadata } from "../../packages/sdk/src/originals/inscription.js";
import { MemoryStore, OriginalsSDK } from "../../packages/sdk/src/originals/index.js";
// Test helper that builds a local author DID with its evidence; nothing leaves the process.
import { Author, seed } from "../../packages/sdk/tests/unit/originals/helpers.js";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const LIVE = arg("--rpc") ?? process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const OUT = arg("--out");

const ROOT = resolve(import.meta.dir, "../..");
const ARTIFACT = join(ROOT, "contracts/out/OriginalsAnchor.sol/OriginalsAnchor.json");
const PROXY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const ORACLE = "0x420000000000000000000000000000000000000f";
const L1BLOCK = "0x4200000000000000000000000000000000000015";
const ADDRESS = "0x48f382c1d6c079bde4971c89e316841d2c9e79c2"; // contracts/README.md
const CODE_HASH = "0x0a97a92302c38e4084f1d15ea5ff08fa8892f3161a54aa63e650f62a8f3f05f0";
const TX_GAS_CAP = 16_777_216n; // EIP-7825, enforced on Base since Azul
/** Anvil's unlocked dev accounts (public test mnemonic), on the local fork only. */
const DEPLOYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const MINTER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

const fetcher = globalThis.fetch.bind(globalThis) as unknown as EvmFetch;
const live = new EvmRpc(LIVE, { fetch: fetcher });

/** Read-only methods only ever go to the public endpoint. */
const LIVE_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_call"]);
async function liveRequest<T>(method: string, params: unknown[]): Promise<T> {
  if (!LIVE_METHODS.has(method)) throw new Error(`refusing ${method} on the public endpoint`);
  return live.request<T>(method, params);
}
async function liveCall(signature: string, types: Parameters<typeof encodeCall>[1], values: Parameters<typeof encodeCall>[2], to = ORACLE, block = "latest"): Promise<bigint | null> {
  try {
    return BigInt(await liveRequest<string>("eth_call", [{ to, data: toHex(encodeCall(signature, types, values)) }, block]));
  } catch {
    return null;
  }
}

function tool(name: string): string {
  const local = join(homedir(), ".foundry/bin", name);
  if (existsSync(local)) return local;
  const found = Bun.which(name);
  if (!found) throw new Error(`${name} not found; install Foundry`);
  return found;
}

async function startFork(block: number) {
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const proc = Bun.spawn(
    [tool("anvil"), "--port", String(port), "--fork-url", LIVE, "--fork-block-number", String(block), "--chain-id", "8453", "--network", "base", "--enable-tx-gas-limit", "--slots-in-an-epoch", "1", "--silent"],
    { stdout: "ignore", stderr: "inherit" },
  );
  const url = `http://127.0.0.1:${port}`;
  const rpc = new EvmRpc(url, { fetch: fetcher });
  for (let i = 0; ; i++) {
    try {
      await rpc.chainId();
      break;
    } catch (error) {
      if (i > 300) throw error;
      await Bun.sleep(100);
    }
  }
  return { proc, url, rpc };
}

const anvilWallet = (rpc: EvmRpc, address: string): EvmWallet => ({
  address,
  sendTransaction: (tx) => rpc.request<string>("eth_sendTransaction", [{ from: tx.from, to: tx.to, data: tx.data }]),
});

function random(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65_536)));
  return b;
}
/** Text that does not compress much (base64 of random bytes), so the L1 data fee is not understated. */
const notes = (n: number) => Buffer.from(random(Math.ceil((n * 3) / 4))).toString("base64").slice(0, n);

interface TxRow {
  hash: string;
  gasUsed: bigint;
  gasLimit: bigint;
  rawBytes: number;
  l1Fee: bigint;
  operatorFee: bigint;
}
interface OpRow {
  operation: string;
  kind: string;
  storedBytes: number | null;
  txs: TxRow[];
}

async function main() {
  // --- live chain inputs (read-only) ---
  const chainId = BigInt(await liveRequest<string>("eth_chainId", []));
  if (chainId !== 8453n) throw new Error(`${LIVE} serves chain ${chainId}, not Base (8453)`);
  const forkBlock = Number(BigInt(await liveRequest<string>("eth_blockNumber", []))) - 5;
  const head = await liveRequest<{ number: string; hash: string; gasLimit: string; baseFeePerGas: string; timestamp: string; extraData: string }>("eth_getBlockByNumber", [`0x${forkBlock.toString(16)}`, false]);
  console.error(`forking Base at block ${forkBlock} (${head.hash})`);
  const fork = await startFork(forkBlock);
  const { url, rpc } = fork;
  const ops: OpRow[] = [];
  try {
    // --- deployment through the proxy (P14.21) ---
    if ((await rpc.code(PROXY, "latest")).length === 0) throw new Error("no deterministic deployment proxy on Base");
    const init = (JSON.parse(readFileSync(ARTIFACT, "utf8")) as { bytecode: { object: string } }).bytecode.object;
    const deployHash = await rpc.request<string>("eth_sendTransaction", [{ from: DEPLOYER, to: PROXY, data: `0x${"00".repeat(32)}${init.slice(2)}` }]);
    await waitForEvmReceipt(rpc, deployHash, { pollMs: 50 });
    const code = await rpc.code(ADDRESS, "latest");
    const codeHash = keccakHex(code);
    if (codeHash !== CODE_HASH) throw new Error(`code at ${ADDRESS} is ${codeHash}, not the README's ${CODE_HASH}`);
    ops.push({ operation: "Deployment through the proxy", kind: "deploy", storedBytes: null, txs: [{ hash: deployHash } as TxRow] });
    await rpc.request("anvil_mine", ["0x3"]);

    const pin: EvmAnchorPin = { address: ADDRESS, codeHash, chains: EVM_CHAINS };
    const anchor = { chain: "eip155:8453", minter: MINTER };
    const ctx: EvmWriterContext = { chain: anchor.chain, pin, wallet: anvilWallet(rpc, MINTER), rpc: url, fetch: fetcher, pollMs: 50 };
    const KEY = seed(61);
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const sign = signWith(localSigner("Ed25519", KEY), { cryptosuite: "eddsa-jcs-2022", verificationMethod: alice.ref("orig").verificationMethod });
    const author = alice.ref("orig");
    let t = Date.parse("2026-11-14T12:00:00Z");
    const at = () => new Date((t += 1_000)).toISOString().replace(".000Z", "Z");
    const desc = (b: Uint8Array) => ({ mediaType: "image/png", size: b.length, digest: resourceDigest(b) });
    const line = (...es: LogEntry[]) => serializeLog(es).split("\n").filter(Boolean);

    const record = async (operation: string, prepared: Awaited<ReturnType<typeof prepareEvmPublication>>) => {
      const result = await submitEvmPublication(ctx, prepared);
      const kind = prepared.plan.kind === "staged" ? `begin + ${prepared.plan.appends} append + ${prepared.plan.commit}` : prepared.plan.kind;
      ops.push({ operation, kind, storedBytes: prepared.storedBytes, txs: result.txHashes.map((hash) => ({ hash }) as TxRow) });
      console.error(`${operation}: ${kind}, ${result.txHashes.length} tx, ${result.gasUsed} gas`);
    };

    /** A new Original anchored on Base with a body of `size` bytes, minted, and its anchoring publication. */
    const anchored = async (size: number, label: string, mint = false) => {
      const body = random(size);
      const genesis = await createOriginal({ versionTime: at(), name: "Harbor at dusk", resource: desc(body), author, sign, anchor, evm: pin });
      const did = genesis.state.id as string;
      const anchoring = await updateOriginal(genesis, { versionTime: at(), author, sign, aliases: [derivedTokenAlias(did, anchor, pin)], evm: pin });
      const minted = await mintEvmToken(ctx, { original: did, anchor });
      if (mint) ops.push({ operation: "`mint`", kind: "mint", storedBytes: null, txs: [{ hash: minted.txHash! } as TxRow] });
      await record(label, await prepareEvmPublication(ctx, { alias: minted.alias, lines: line(genesis, anchoring), body }));
      return { body, anchoring, alias: minted.alias };
    };

    // Small first publication, then edits that keep the body (publishSameBody) with small and larger asset states.
    const small = await anchored(1_000, "First publication: genesis + anchoring entries, 1 kB body", true);
    const rename = await updateOriginal(small.anchoring, { versionTime: at(), author, sign, name: "Harbor at night", evm: pin });
    await record("Edit (rename), small asset state, `publishSameBody`", await prepareEvmPublication(ctx, { alias: small.alias, lines: line(rename), body: small.body }));
    const meta10 = await updateOriginal(rename, { versionTime: at(), author, sign, metadata: { notes: notes(10_000) }, evm: pin });
    await record("Edit, 10 kB asset metadata, `publishSameBody`", await prepareEvmPublication(ctx, { alias: small.alias, lines: line(meta10), body: small.body }));
    const meta30 = await updateOriginal(meta10, { versionTime: at(), author, sign, metadata: { notes: notes(30_000) }, evm: pin });
    await record("Edit, 30 kB asset metadata, `publishSameBody`", await prepareEvmPublication(ctx, { alias: small.alias, lines: line(meta30), body: small.body }));

    // First publications of larger bodies on the SDK's default staging path (maxTxBytes 60,000).
    for (const kb of [10, 50, 100]) await anchored(kb * 1_000, `First publication, ${kb} kB body`);
    // The largest: metadata + body = 350,000 bytes (P9.25, P14.20).
    {
      const probe = random(340_000);
      const g = await createOriginal({ versionTime: at(), name: "Harbor at dusk", resource: desc(probe), author, sign, anchor, evm: pin });
      const a = await updateOriginal(g, { versionTime: at(), author, sign, aliases: [derivedTokenAlias(g.state.id as string, anchor, pin)], evm: pin });
      // The metadata length depends on the body only through its size's digits, the same here, and on
      // signature encodings, whose base58 length varies by a byte or two: leave 8 bytes for that.
      await anchored(350_000 - inscriptionMetadata(line(g, a)).length - 8, "First publication, max (~350,000 B stored)");
    }

    // A single `publish` of 100 kB is over Base's per-transaction cap: anvil (with the EIP-7825 check) must refuse it.
    let single100: string;
    {
      const body = random(100_000);
      const g = await createOriginal({ versionTime: at(), name: "Harbor at dusk", resource: desc(body), author, sign, anchor, evm: pin });
      const a = await updateOriginal(g, { versionTime: at(), author, sign, aliases: [derivedTokenAlias(g.state.id as string, anchor, pin)], evm: pin });
      const minted = await mintEvmToken(ctx, { original: g.state.id as string, anchor });
      const prepared = await prepareEvmPublication(ctx, { alias: minted.alias, lines: line(g, a), body, maxTxBytes: 400_000 });
      const data = toHex(encodeCall("publish(uint256,string,bytes,bytes)", ["uint256", "string", "bytes", "bytes"], [prepared.tokenId, "image/png", prepared.metadata, body]));
      // eth_estimateGas is not capped by anvil, so estimate, then send with that gas limit to the local fork.
      const est = BigInt(await rpc.request<string>("eth_estimateGas", [{ from: MINTER, to: ADDRESS, data }]));
      try {
        const hash = await rpc.request<string>("eth_sendTransaction", [{ from: MINTER, to: ADDRESS, data, gas: `0x${est.toString(16)}` }]);
        single100 = `needs ${est} gas; the fork ACCEPTED it (${hash}): the EIP-7825 check did not apply`;
      } catch (error) {
        single100 = `needs ${est} gas; the fork refused it: ${(error as Error).message.slice(0, 200)}`;
      }
    }

    // The move to Bitcoin (P9.28, P9.29) through the SDK workflow, and its departure publication on the Base token.
    {
      const store = new MemoryStore();
      const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], evm: { pin, providers: { [anchor.chain]: [url] }, fetch: fetcher, pollMs: 50 } });
      const minter = anvilWallet(rpc, MINTER);
      const signer = alice.signer("orig", KEY);
      const final = async () => void (await rpc.request("anvil_mine", ["0x3"]));
      const created = await sdk.create({ name: "Harbor at dusk", resource: { mediaType: "image/png", bytes: random(1_000) }, author, signer, anchor, acknowledged: evmGenesisNotice(anchor, pin) });
      if (created.kind !== "original") throw new Error("expected an Original");
      const did = created.original.did;
      const anchoringSdk = await sdk.anchor(did, { parent: created.original.checkpoint, author, signer });
      await sdk.mintEvm(did, { wallet: minter });
      const plan = await sdk.prepareEvmPublication(did, { wallet: minter });
      await sdk.submitEvmPublication(did, plan, { wallet: minter, acknowledged: plan.notice });
      await final();
      const prepared = await sdk.prepareMove(did, { parent: anchoringSdk.original.checkpoint, author, to: { sat: "did:btco:5000000000" } });
      await sdk.move(did, { prepared, signer, acknowledged: prepared.notice });
      const departure = await sdk.prepareEvmPublication(did, { wallet: minter });
      if (departure.kind !== "departure") throw new Error(`expected a departure, got ${departure.kind}`);
      const sent = await sdk.submitEvmPublication(did, departure, { wallet: minter, acknowledged: departure.notice });
      const kind = departure.prepared.plan.kind;
      ops.push({ operation: "Move to Bitcoin: departure publication (move entry)", kind, storedBytes: departure.prepared.storedBytes, txs: sent.txHashes.map((hash) => ({ hash }) as TxRow) });
      console.error(`departure: ${kind}, ${sent.gasUsed} gas`);
    }

    // --- per-transaction gas and signed bytes from the fork, priced on the live chain ---
    const isthmus = (await liveCall("isIsthmus()", [], [])) === 1n;
    for (const op of ops) {
      for (const tx of op.txs) {
        const receipt = await rpc.request<{ gasUsed: string }>("eth_getTransactionReceipt", [tx.hash]);
        const full = await rpc.request<{ gas: string }>("eth_getTransactionByHash", [tx.hash]);
        const raw = await rpc.request<string>("eth_getRawTransactionByHash", [tx.hash]);
        tx.gasUsed = BigInt(receipt.gasUsed);
        tx.gasLimit = BigInt(full.gas);
        tx.rawBytes = (raw.length - 2) / 2;
        const l1 = await liveCall("getL1Fee(bytes)", ["bytes"], [fromHex(raw)]);
        if (l1 === null) throw new Error(`getL1Fee failed for ${tx.hash} (${tx.rawBytes} bytes)`);
        tx.l1Fee = l1;
        tx.operatorFee = isthmus ? ((await liveCall("getOperatorFee(uint256)", ["uint256"], [tx.gasUsed])) ?? 0n) : 0n;
      }
    }

    // --- live fee inputs ---
    const latest = await liveRequest<{ number: string; baseFeePerGas: string; gasLimit: string }>("eth_getBlockByNumber", ["latest", false]);
    const gasPrice = BigInt(await liveRequest<string>("eth_gasPrice", []));
    const tip = BigInt(await liveRequest<string>("eth_maxPriorityFeePerGas", []));
    const history = await liveRequest<{ oldestBlock: string; baseFeePerGas: string[]; reward: string[][] }>("eth_feeHistory", ["0x400", "latest", [10, 50, 90]]);
    const bases = history.baseFeePerGas.map((x) => BigInt(x));
    const rewards = history.reward.map((r) => r.map((x) => BigInt(x)));
    const median = (xs: bigint[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor(xs.length / 2)];
    const minB = bases.reduce((a, b) => (b < a ? b : a));
    const maxB = bases.reduce((a, b) => (b > a ? b : a));
    const band = {
      low: minB + median(rewards.map((r) => r[0])),
      typical: BigInt(latest.baseFeePerGas) + median(rewards.map((r) => r[1])),
      high: maxB + median(rewards.map((r) => r[2])),
    };
    const oracle = {
      l1BaseFee: await liveCall("l1BaseFee()", [], []),
      blobBaseFee: await liveCall("blobBaseFee()", [], []),
      baseFeeScalar: await liveCall("baseFeeScalar()", [], []),
      blobBaseFeeScalar: await liveCall("blobBaseFeeScalar()", [], []),
      isEcotone: await liveCall("isEcotone()", [], []),
      isFjord: await liveCall("isFjord()", [], []),
      isIsthmus: await liveCall("isIsthmus()", [], []),
      isJovian: await liveCall("isJovian()", [], []),
      operatorFeeScalar: await liveCall("operatorFeeScalar()", [], [], L1BLOCK),
      operatorFeeConstant: await liveCall("operatorFeeConstant()", [], [], L1BLOCK),
      daFootprintGasScalar: await liveCall("daFootprintGasScalar()", [], [], L1BLOCK),
      l1UpperBound100k: await liveCall("getL1FeeUpperBound(uint256)", ["uint256"], [100_000n]),
    };
    const spot = (await (await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot")).json()) as { data: { amount: string } };
    const eth = Number(spot.data.amount);
    const priced = new Date().toISOString();

    const usd = (wei: bigint) => (Number(wei) / 1e18) * eth;
    const rows = ops.map((op) => {
      const gas = op.txs.reduce((n, x) => n + x.gasUsed, 0n);
      const l1 = op.txs.reduce((n, x) => n + x.l1Fee, 0n);
      const opf = op.txs.reduce((n, x) => n + x.operatorFee, 0n);
      const l2 = (p: bigint) => gas * p;
      const maxTx = op.txs.reduce((n, x) => (x.gasUsed > n ? x.gasUsed : n), 0n);
      return {
        operation: op.operation,
        kind: op.kind,
        storedBytes: op.storedBytes,
        txs: op.txs.length,
        gasUsed: gas.toString(),
        maxTxGasUsed: maxTx.toString(),
        maxTxGasLimit: op.txs.reduce((n, x) => (x.gasLimit > n ? x.gasLimit : n), 0n).toString(),
        overCap: op.txs.some((x) => x.gasLimit > TX_GAS_CAP),
        rawBytes: op.txs.reduce((n, x) => n + x.rawBytes, 0),
        l2FeeWei: { low: l2(band.low).toString(), typical: l2(band.typical).toString(), high: l2(band.high).toString() },
        l1FeeWei: l1.toString(),
        operatorFeeWei: opf.toString(),
        usd: { low: usd(l2(band.low) + l1 + opf), typical: usd(l2(band.typical) + l1 + opf), high: usd(l2(band.high) + l1 + opf) },
        usdL2Typical: usd(l2(band.typical)),
        usdL1: usd(l1),
        perTx: op.txs.map((x) => ({ gasUsed: x.gasUsed.toString(), gasLimit: x.gasLimit.toString(), rawBytes: x.rawBytes, l1FeeWei: x.l1Fee.toString() })),
      };
    });
    const out = {
      chain: "Base mainnet (8453)",
      endpoint: new URL(LIVE).host,
      fork: { block: forkBlock, hash: head.hash, timestamp: Number(BigInt(head.timestamp)), gasLimit: Number(BigInt(head.gasLimit)), extraData: head.extraData },
      pricedAt: priced,
      liveBlock: Number(BigInt(latest.number)),
      blockGasLimit: Number(BigInt(latest.gasLimit)),
      gas: {
        baseFee: latest.baseFeePerGas,
        gasPrice: gasPrice.toString(),
        maxPriorityFeePerGas: tip.toString(),
        feeHistory: { oldestBlock: Number(BigInt(history.oldestBlock)), blocks: rewards.length, minBase: minB.toString(), maxBase: maxB.toString(), band: Object.fromEntries(Object.entries(band).map(([k, v]) => [k, v.toString()])) },
      },
      oracle: Object.fromEntries(Object.entries(oracle).map(([k, v]) => [k, v === null ? null : v.toString()])),
      ethUsd: eth,
      txGasCap: TX_GAS_CAP.toString(),
      single100kPublish: single100,
      rows,
    };
    const json = JSON.stringify(out, null, 2);
    if (OUT) writeFileSync(OUT, json);
    console.log(json);
  } finally {
    fork.proc.kill();
  }
}

await main();
