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
 *   --min-confirmations <n>       confirmations of the final reveal verify waits for (default 6, so the publication
 *                                 history meets the transfer check's depth, P7.22; the sat transfer is not checked)
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
  const answers = confirmations(process.stdin, process.stdout, { mainnet: network === "mainnet" });
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
        return answers.confirm(q);
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
    answers.close();
  }
}

/**
 * Answers to the command's confirmations, one line each. Lines that arrive while a step is still
 * waiting (for the funding output, say) are kept for the next question, and the end of input is a
 * "no", never an error. On mainnet every answer has to be typed at a terminal after its question is
 * shown: piped input and lines typed ahead are refused, so nothing confirms a mainnet broadcast but a
 * person reading the question.
 */
export function confirmations(input: NodeJS.ReadableStream & { isTTY?: boolean }, output: NodeJS.WritableStream, options: { mainnet: boolean }) {
  const rl = createInterface({ input, terminal: false });
  const queued: string[] = [];
  let waiting: ((line: string | null) => void) | undefined;
  let ended = false;
  rl.on("line", (line) => {
    if (waiting) {
      const w = waiting;
      waiting = undefined;
      w(line);
    } else queued.push(line);
  });
  rl.on("close", () => {
    ended = true;
    waiting?.(null);
    waiting = undefined;
  });
  return {
    async confirm(question: string): Promise<boolean> {
      if (options.mainnet && !input.isTTY) {
        output.write(`${question}\nOn mainnet the answer has to be typed at a terminal; standard input is not one, so this is a no.\n`);
        return false;
      }
      if (options.mainnet) queued.length = 0; // typed ahead of the question: not an answer to it
      output.write(`${question} Type "yes" to continue: `);
      const line = queued.length > 0 ? queued.shift()! : ended ? null : await new Promise<string | null>((r) => { waiting = r; });
      if (line === null) output.write("\n(no answer: input ended)\n");
      return line?.trim() === "yes";
    },
    close: () => rl.close(),
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/og/cli.js") || process.argv[1]?.endsWith("/og/cli.ts")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: Error) => {
    console.error(`originals-og: ${error.message}`);
    process.exit(1);
  });
}
