#!/usr/bin/env node
/**
 * originals-og: anchor a new did:og Original on Bitcoin (plan 051, the
 * mainnet release gate's step b). The owner runs it; it never broadcasts
 * without an explicit confirmation, and never prints the author's keys.
 *
 *   originals-og keygen --out <key file>
 *   originals-og anchor <author|prepare|fund|broadcast|verify|run> --state <dir> --key <key file> --network <mainnet|signet|regtest> [options]
 *
 * Options:
 *   --name <author name>          path segment: did:webvh:<SCID>:<domain>:authors:<name>   (author, run)
 *   --domain <domain>             default originals.build                                     (author, run)
 *   --file <path> --media-type <type> [--title <name>] [--body preview|full|none] [--preview <file>]
 *   --holder <address>            the ordinals-capable address that receives the sat      (prepare, run)
 *   --fee-rate <sat/vB> --postage <sats>
 *   --esplora <url>               default mempool.space for the network
 *   --rpc-url <url> --rpc-auth <user:pass>   Bitcoin Core RPC instead of Esplora (regtest)
 *   --ord <url>                   ord 0.29.x explorer; default ordinals.com for the network
 *   --out <path>                  where verify writes last-run.json (default <state>/last-run.json)
 *   --min-confirmations <n>       confirmations verify waits for (default 6, the transfer depth, P7.22)
 *   --yes                         do not ask before signing (never used for mainnet by default)
 */
import { createInterface } from "node:readline/promises";
import type { BitcoinNetwork, BodyMode } from "@originals/vh/og";
import { CoreRpcBackend, EsploraBackend, MEMPOOL_SPACE, ORD_EXPLORER, OrdExplorer, type ChainBackend } from "./chain.js";
import { generateKeyFile } from "./keys.js";
import { stepAuthor, stepBroadcast, stepFund, stepPrepare, stepVerify, type Ctx } from "./anchor.js";

function args(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags.set(a.slice(2), true);
      else {
        flags.set(a.slice(2), next);
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function need(flags: Map<string, string | true>, name: string): string {
  const v = flags.get(name);
  if (typeof v !== "string") throw new Error(`--${name} is required`);
  return v;
}

export function backendsFrom(flags: Map<string, string | true>, network: BitcoinNetwork): { chain: ChainBackend; ord: OrdExplorer } {
  const rpc = flags.get("rpc-url");
  let chain: ChainBackend;
  if (typeof rpc === "string") chain = new CoreRpcBackend(rpc, need(flags, "rpc-auth"), Number(flags.get("fee-rate") ?? 2));
  else {
    const esplora = flags.get("esplora");
    const base = typeof esplora === "string" ? esplora : network === "regtest" ? undefined : MEMPOOL_SPACE[network];
    if (!base) throw new Error("regtest needs --rpc-url and --rpc-auth, or --esplora");
    chain = new EsploraBackend(base);
  }
  const ordUrl = flags.get("ord");
  const ordBase = typeof ordUrl === "string" ? ordUrl : ORD_EXPLORER[network];
  if (!ordBase) throw new Error("regtest needs --ord <url of an ord 0.29.x server>");
  return { chain, ord: new OrdExplorer(ordBase.replace(/\/$/, "")) };
}

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = args(argv);
  const [command, step] = positional;
  if (command === "keygen") {
    const out = need(flags, "out");
    generateKeyFile(out);
    console.log(`Wrote a new author key file to ${out} (mode 0600). Keep it out of any repository; it is never printed.`);
    return 0;
  }
  if (command !== "anchor" || !step) {
    console.error("usage: originals-og keygen --out <file> | originals-og anchor <author|prepare|fund|broadcast|verify|run> --state <dir> --key <file> --network <network> ...");
    return 2;
  }
  const network = need(flags, "network") as BitcoinNetwork;
  if (!["mainnet", "signet", "testnet", "regtest"].includes(network)) throw new Error(`unknown network ${network}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const yes = flags.get("yes") === true;
  const ctx: Ctx = {
    stateDir: need(flags, "state"),
    keyFile: need(flags, "key"),
    network,
    ...backendsFrom(flags, network),
    io: {
      say: (l) => console.log(l),
      confirm: async (q) => {
        if (yes && network !== "mainnet") return true;
        const a = await rl.question(`${q} Type "yes" to continue: `);
        return a.trim() === "yes";
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    pollMs: Number(flags.get("poll-ms") ?? 15_000),
  };
  const prepare = () => stepPrepare(ctx, {
    file: need(flags, "file"), mediaType: need(flags, "media-type"), name: flags.get("title") as string | undefined,
    body: flags.get("body") as BodyMode | undefined, previewFile: flags.get("preview") as string | undefined,
    holder: need(flags, "holder"), feeRate: flags.has("fee-rate") ? Number(flags.get("fee-rate")) : undefined,
    postage: flags.has("postage") ? BigInt(flags.get("postage") as string) : undefined,
  });
  const verifyOpts = () => ({ out: flags.get("out") as string | undefined, minConfirmations: flags.has("min-confirmations") ? Number(flags.get("min-confirmations")) : undefined });
  const author = () => stepAuthor(ctx, { name: need(flags, "name"), domain: flags.get("domain") as string | undefined });
  try {
    if (step === "author") await author();
    else if (step === "prepare") await prepare();
    else if (step === "fund") await stepFund(ctx, { yes: yes && network !== "mainnet" });
    else if (step === "broadcast") await stepBroadcast(ctx);
    else if (step === "verify") return (await stepVerify(ctx, verifyOpts())).passed ? 0 : 1;
    else if (step === "run") {
      await author();
      await prepare();
      await stepFund(ctx, { yes: yes && network !== "mainnet" });
      await stepBroadcast(ctx);
      return (await stepVerify(ctx, verifyOpts())).passed ? 0 : 1;
    } else throw new Error(`unknown step ${step}`);
    return 0;
  } finally {
    rl.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/og/cli.js") || process.argv[1]?.endsWith("/og/cli.ts")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: Error) => {
    console.error(`originals-og: ${error.message}`);
    process.exit(1);
  });
}
