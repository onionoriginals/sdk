/**
 * The did:og anchoring command's steps, over a state directory that lets the
 * owner stop and resume. The state file holds the ephemeral reveal key until
 * the reveal confirms; it is written with mode 0600 and never into the repo.
 * The author's key file is read, never copied, printed or logged.
 *
 *   author     create a new did:webvh author DID; print did.jsonl and its URL; wait until it resolves
 *   prepare    build the genesis entry; size the publication; show the funding address and exact amount
 *   fund       wait for the funding output to confirm; find its first sat; sign the anchoring entry; check the local copy
 *   broadcast  sign and broadcast the commit and each reveal, the sat going to the holder's address
 *   verify     read everything back from the ord explorer, fetch the author's did.jsonl from its public URL (no
 *              redirects) as the resolved signer history (D22), compute the report from that evidence set, write
 *              last-run.json
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import {
  OG_LIMITS, OG_METHOD, btcoDid, defaultCheck, listsKey, resourceDigest, transferCheck, verifyOriginal,
  type BitcoinNetwork, type BodyMode, type Descriptor, type OgEntry, type Report,
} from "@originals/vh/og";
import type { JsonObject } from "@originals/vh/json";
import { checkAuthorLog, createAuthorDid, DEFAULT_AUTHOR_DOMAIN, type AuthorLogCheck } from "./author-did.js";
import { readSatEvidence, withResolvedSigner } from "./evidence.js";
import { checkAddress, fundingAddress, hex, plan, signChain } from "./inscribe.js";
import { readKeyFile } from "./keys.js";
import { anchoringPublication, checkLocalCopy, choosePreview, createAnchoringEntry, createGenesis, describeTransferCheck, disclosure, type AuthorRef } from "./original.js";
import type { ChainBackend, OrdExplorer } from "./chain.js";

export interface Io {
  say(line: string): void;
  /** Ask the owner to confirm; false stops the step. */
  confirm(question: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface Ctx {
  stateDir: string;
  keyFile: string;
  network: BitcoinNetwork;
  chain: ChainBackend;
  ord: OrdExplorer;
  io: Io;
  /** Fetch for checking the author's did.jsonl at its URL; tests point it at a local server. */
  fetchAuthorLog?: (url: string) => Promise<string | null>;
  /** How long to wait for a condition before giving up, in ms. */
  timeoutMs?: number;
  pollMs?: number;
}

export interface AnchorState {
  version: 1;
  network: BitcoinNetwork;
  author?: { did: string; url: string; log: string; verificationMethod: string; versionId: string; resolved?: boolean };
  original?: {
    file: string; name: string; mediaType: string; digest: string; size: number; body: BodyMode; previewMessage: string;
    preview?: { hex: string; descriptor: Descriptor };
    genesis: OgEntry;
  };
  reveal?: { secretHex: string; fundingAddress: string; fundingAmount: string; holder: string; feeRate: number; postage: string; estimatedParts: number; estimatedFees: string[] };
  funding?: { txid: string; vout: number; amount: string; sat: string };
  anchoringEntry?: OgEntry;
  signed?: { hex: string[]; txids: string[]; postage: string; fees: string[]; parts: number };
  broadcast?: Array<{ txid: string; at: string; status: "submitted" | "pending" | "submitted-not-observed" | "confirmed" }>;
  done?: boolean;
}

const STATE = "anchor-state.json";

export function loadState(dir: string, network: BitcoinNetwork): AnchorState {
  const p = join(dir, STATE);
  if (!existsSync(p)) return { version: 1, network };
  const s = JSON.parse(readFileSync(p, "utf8")) as AnchorState;
  if (s.network !== network) throw new Error(`the state in ${dir} is for ${s.network}, not ${network}`);
  return s;
}

export function saveState(dir: string, s: AnchorState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, STATE);
  writeFileSync(`${p}.tmp`, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
  chmodSync(p, 0o600);
}

function authorRef(s: AnchorState, ctx: Ctx): AuthorRef {
  if (!s.author) throw new Error("run the author step first");
  const { keys } = readKeyFile(ctx.keyFile);
  return { did: s.author.did, verificationMethod: s.author.verificationMethod, versionId: s.author.versionId, log: s.author.log, signer: keys.assertion };
}

async function until<T>(ctx: Ctx, what: string, f: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + (ctx.timeoutMs ?? 6 * 3600_000);
  let announced = false;
  for (;;) {
    const v = await f().catch((e: Error) => {
      if (!announced) ctx.io.say(`  (${what}: ${e.message}; retrying)`);
      announced = true;
      return undefined;
    });
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await ctx.io.sleep(ctx.pollMs ?? 15_000);
  }
}

// ---------------------------------------------------------------------------
// Step 1: the author DID

export async function stepAuthor(ctx: Ctx, opts: { name: string; domain?: string; wait?: boolean }): Promise<AnchorState> {
  const s = loadState(ctx.stateDir, ctx.network);
  if (!s.author) {
    const { keys, warning } = readKeyFile(ctx.keyFile);
    if (warning) ctx.io.say(`Warning: ${warning}`);
    const d = await createAuthorDid(keys, { domain: opts.domain ?? DEFAULT_AUTHOR_DOMAIN, path: ["authors", opts.name] });
    s.author = { did: d.did, url: d.url, log: d.log, verificationMethod: d.verificationMethod, versionId: d.versionId };
    saveState(ctx.stateDir, s);
  }
  ctx.io.say(`Author DID: ${s.author.did}`);
  ctx.io.say(`Serve this file, byte for byte, at ${s.author.url} (Content-Type: application/jsonl; CORS: Access-Control-Allow-Origin: *):`);
  ctx.io.say("----- did.jsonl -----");
  ctx.io.say(s.author.log.trimEnd());
  ctx.io.say("----- end -----");
  writeFileSync(join(ctx.stateDir, "did.jsonl"), s.author.log, { mode: 0o644 });
  ctx.io.say(`(also written to ${join(ctx.stateDir, "did.jsonl")})`);
  if (opts.wait === false) return s;
  if (!(await ctx.io.confirm(`Is it served at ${s.author.url}?`))) throw new Error("stopped: the author DID is not served yet");
  const fetchLog = ctx.fetchAuthorLog ?? (async (url: string) => {
    const r = await fetch(url, { redirect: "error" });
    return r.ok ? r.text() : null;
  });
  const author = s.author;
  await until(ctx, `the DID to resolve at ${author.url}`, async () => {
    const text = await fetchLog(author.url);
    if (text === null) throw new Error("not served yet");
    const c = await checkAuthorLog(author.did, text);
    if (!c.ok) throw new Error(c.reason);
    if (text !== author.log) throw new Error("the served log differs from the one created");
    return true;
  });
  s.author.resolved = true;
  saveState(ctx.stateDir, s);
  ctx.io.say("The author DID resolves.");
  return s;
}

// ---------------------------------------------------------------------------
// Step 2: prepare

const PLACEHOLDER_SAT = 2_099_999_997_689_999n;

export async function stepPrepare(ctx: Ctx, opts: { file: string; name?: string; mediaType: string; body?: BodyMode; previewFile?: string; holder: string; feeRate?: number; postage?: bigint }): Promise<AnchorState> {
  const s = loadState(ctx.stateDir, ctx.network);
  if (!s.author?.resolved) throw new Error("the author DID must resolve first (author step)");
  if (s.funding) throw new Error("this state is already funded; use a new state directory for another Original");
  checkAddress(opts.holder, ctx.network);
  const bytes = new Uint8Array(readFileSync(opts.file));
  const author = authorRef(s, ctx);
  const choice = await choosePreview({ bytes, mediaType: opts.mediaType, body: opts.body, preview: opts.previewFile ? { bytes: new Uint8Array(readFileSync(opts.previewFile)), mediaType: guessType(opts.previewFile) } : undefined });
  const name = opts.name ?? basename(opts.file);
  const genesis = s.original?.genesis && s.original.digest === resourceDigest(bytes) ? s.original.genesis : await createGenesis({ name, bytes, mediaType: opts.mediaType, network: ctx.network, author });
  s.original = { file: opts.file, name, mediaType: opts.mediaType, digest: resourceDigest(bytes), size: bytes.length, body: choice.body, previewMessage: choice.message, genesis, ...(choice.preview ? { preview: { hex: hex.encode(choice.preview.bytes), descriptor: choice.preview.descriptor } } : {}) };
  // Size the publication with the largest sat number, so the real one can only be smaller.
  const probe = await createAnchoringEntry(genesis, { sat: PLACEHOLDER_SAT, network: ctx.network, body: choice.body, preview: choice.preview?.descriptor, author });
  const parts = anchoringPublication([genesis, probe], choice.body === "preview" ? choice.preview!.bytes : choice.body === "full" ? bytes : null);
  const secret = s.reveal ? hex.decode(s.reveal.secretHex) : new Uint8Array(randomBytes(32));
  const feeRate = opts.feeRate ?? (await ctx.chain.feeRate());
  const postage = opts.postage ?? 1_000n;
  const p = plan({ secret, network: ctx.network, envelopes: parts.map((x) => x.envelope), holder: opts.holder, feeRate, postage });
  const funding = fundingAddress(secret, ctx.network);
  s.reveal = { secretHex: hex.encode(secret), fundingAddress: funding.address, fundingAmount: p.fundingAmount.toString(), holder: opts.holder, feeRate, postage: postage.toString(), estimatedParts: parts.length, estimatedFees: p.fees.map(String) };
  saveState(ctx.stateDir, s);
  const fees = p.fees.reduce((a, b) => a + b, 0n);
  for (const l of disclosure({ name, mediaType: opts.mediaType, bytes: bytes.length, body: choice.body, previewMessage: choice.message, parts: parts.length, feeSats: fees, feeRate, network: ctx.network, author: author.did }).lines) ctx.io.say(l);
  ctx.io.say(`Fund this taproot address with EXACTLY ${p.fundingAmount} sats (${Number(p.fundingAmount) / 1e8} BTC), in one output, from any wallet:`);
  ctx.io.say(`  ${funding.address}`);
  ctx.io.say(`The first sat of that output becomes the anchoring sat. Do not fund it from an output holding inscriptions or rare sats you want to keep.`);
  ctx.io.say(`The reveal key is saved in ${join(ctx.stateDir, STATE)} (mode 0600) until the reveal confirms. Keep that directory until then.`);
  return s;
}

function guessType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ({ webp: "image/webp", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", txt: "text/plain", md: "text/markdown", svg: "image/svg+xml", json: "application/json" } as Record<string, string>)[ext ?? ""] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Step 3: fund

export async function stepFund(ctx: Ctx, opts: { yes?: boolean } = {}): Promise<AnchorState> {
  const s = loadState(ctx.stateDir, ctx.network);
  if (!s.reveal || !s.original || !s.author) throw new Error("run prepare first");
  const reveal = s.reveal;
  const want = BigInt(reveal.fundingAmount);
  if (!s.funding) {
    ctx.io.say(`Waiting for ${reveal.fundingAddress} to receive ${want} sats with one confirmation...`);
    const utxo = await until(ctx, "the funding output", async () => {
      const list = await ctx.chain.utxos(reveal.fundingAddress);
      const u = list.find((x) => x.value >= want && x.confirmations >= 1);
      if (!u) throw new Error(list.length ? `seen ${list.map((x) => `${x.value} sats, ${x.confirmations} conf`).join("; ")}` : "nothing yet");
      return u;
    });
    if (utxo.value > want) ctx.io.say(`The output holds ${utxo.value} sats, ${utxo.value - want} more than needed; the surplus stays with the sat.`);
    const sat = await until(ctx, "the explorer to index the funding output", () => ctx.ord.firstSat(`${utxo.txid}:${utxo.vout}`));
    // P9.34: refuse a sat the writer knows is taken.
    const existing = await ctx.ord.satInscriptions(sat);
    for (const id of existing) {
      const info = await ctx.ord.inscription(id);
      if (info.metaprotocol === "og") throw new Error(`sat ${sat} already carries an Originals inscription (${id}); refusing to anchor on a taken sat (P9.34). Fund again from another output.`);
    }
    if (existing.length) ctx.io.say(`Note: sat ${sat} already carries ${existing.length} other inscription(s); they do not affect the Original (P9.31).`);
    s.funding = { txid: utxo.txid, vout: utxo.vout, amount: utxo.value.toString(), sat: sat.toString() };
    saveState(ctx.stateDir, s);
  }
  const author = authorRef(s, ctx);
  const sat = BigInt(s.funding.sat);
  ctx.io.say(`Anchoring sat: ${sat} (${btcoDid(ctx.network, sat)}).`);
  const anchoring = s.anchoringEntry ?? await createAnchoringEntry(s.original.genesis, { sat, network: ctx.network, body: s.original.body, preview: s.original.preview?.descriptor, author });
  const bytes = new Uint8Array(readFileSync(s.original.file));
  if (resourceDigest(bytes) !== s.original.digest) throw new Error(`${s.original.file} changed since prepare`);
  // P9.18: verify the committed log through the anchoring entry as a local copy, with the author log it holds (never inscribed, D22).
  const local = await checkLocalCopy([s.original.genesis, anchoring], author, bytes);
  if (!local.ok) throw new Error(`the local copy does not verify; refusing to inscribe (P9.18): ${local.problems.join("; ")}`);
  ctx.io.say("Local copy verified through the anchoring entry (the writer's own check: not on Bitcoin yet, never current).");
  const parts = anchoringPublication([s.original.genesis, anchoring], bodyBytes(s, bytes));
  const p = plan({ secret: hex.decode(s.reveal.secretHex), network: ctx.network, envelopes: parts.map((x) => x.envelope), holder: s.reveal.holder, feeRate: s.reveal.feeRate, postage: 0n });
  const fees = p.fees.reduce((a, b) => a + b, 0n);
  for (const l of disclosure({ name: s.original.name, mediaType: s.original.mediaType, bytes: s.original.size, body: s.original.body, previewMessage: s.original.previewMessage, parts: parts.length, feeSats: fees, feeRate: s.reveal.feeRate, network: ctx.network, author: author.did }).lines) ctx.io.say(l);
  ctx.io.say(`The final reveal sends the sat to ${s.reveal.holder}, in an output of ${BigInt(s.funding.amount) - fees} sats.`);
  if (!opts.yes && !(await ctx.io.confirm(`Sign the anchoring entry for ${btcoDid(ctx.network, sat)} and inscribe ${parts.length} inscription(s) on ${ctx.network}?`))) throw new Error("stopped before signing");
  s.anchoringEntry = anchoring;
  saveState(ctx.stateDir, s);
  return s;
}

function bodyBytes(s: AnchorState, bytes: Uint8Array): Uint8Array | null {
  if (s.original!.body === "preview") return hex.decode(s.original!.preview!.hex);
  if (s.original!.body === "full") return bytes;
  return null;
}

// ---------------------------------------------------------------------------
// Step 4: broadcast

export async function stepBroadcast(ctx: Ctx): Promise<AnchorState> {
  const s = loadState(ctx.stateDir, ctx.network);
  if (!s.anchoringEntry || !s.funding || !s.original || !s.reveal) throw new Error("run fund first");
  const bytes = new Uint8Array(readFileSync(s.original.file));
  if (!s.signed) {
    const parts = anchoringPublication([s.original.genesis, s.anchoringEntry], bodyBytes(s, bytes));
    const chain = signChain({
      secret: hex.decode(s.reveal.secretHex), network: ctx.network, envelopes: parts.map((p) => p.envelope), holder: s.reveal.holder, feeRate: s.reveal.feeRate,
      funding: { txid: s.funding.txid, vout: s.funding.vout, amount: BigInt(s.funding.amount) },
    });
    s.signed = { hex: chain.hex, txids: chain.txids, postage: chain.postage.toString(), fees: chain.fees.map(String), parts: parts.length };
    saveState(ctx.stateDir, s);
  }
  // Rebroadcasting the same transactions is a retry, never a re-signed entry (P9.6).
  s.broadcast ??= [];
  for (let k = 0; k < s.signed.hex.length; k++) {
    const txid = s.signed.txids[k];
    const seen = await ctx.chain.txConfirmations(txid);
    if (seen === null) {
      try {
        await ctx.chain.broadcast(s.signed.hex[k]);
      } catch (error) {
        ctx.io.say(`Broadcast of ${txid} failed: ${(error as Error).message}`);
        throw error;
      }
    }
    const after = await ctx.chain.txConfirmations(txid);
    // P9.18: pending only while the network is seen to hold it; otherwise submitted, not observed.
    const status = after === null ? "submitted-not-observed" : after > 0 ? "confirmed" : "pending";
    const prior = s.broadcast.findIndex((b) => b.txid === txid);
    const record = { txid, at: new Date().toISOString(), status } as const;
    if (prior >= 0) s.broadcast[prior] = record;
    else s.broadcast.push(record);
    saveState(ctx.stateDir, s);
    ctx.io.say(`${k === 0 ? "commit" : `reveal ${k}/${s.signed.hex.length - 1}`} ${txid}: ${status === "pending" ? "pending Bitcoin acceptance (in the mempool)" : status === "confirmed" ? "confirmed" : "submitted, not observed"}`);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Step 5: verify from Bitcoin alone

export interface LastRun {
  command: "originals-og anchor";
  profile: string;
  network: BitcoinNetwork;
  original: string;
  author: string;
  authorUrl: string;
  sat: string;
  anchoringAlias: string;
  /**
   * The holder the explorer reports at the verified tip (P9.11), the same as `report.bitcoin.holder.address`;
   * null when no holder was observed. It can differ from `revealDestination` once the sat has moved.
   */
  holder: string | null;
  /** The address the final reveal sent the sat to, as configured with `--holder`. */
  revealDestination: string;
  transactions: { funding: string; commit: string; reveals: string[] };
  inscriptions: Array<{ id: string; height: number; txIndex: number; inscriptionIndex: number; confirmations: number; metaprotocol: string | null; contentType: string | null; envelopeBytes: number; envelopeDigest: string }>;
  tip: { height: number; hash: string };
  ord: string;
  backend: string;
  report: Report;
  defaultCheck: boolean;
  /** P7.22: the transfer check, on the Original's publication history (at least the transfer depth deep, P14.13), not on the sat transfer. */
  transferCheck: boolean;
  /**
   * The author's did.jsonl fetched from its public URL (no redirects), which the evidence set holds as the
   * resolved signer history (D22, P7.8): whether it was served, verifies as the author DID's own log, and
   * reaches every version the inscribed entries name.
   */
  publicHost: { url: string; served: boolean; verifies: boolean; reachesNamedVersions: boolean; obtained?: string; latestVersionId?: string; reason?: string };
  /** Not part of the report (P14.25): the newest resolved author version no longer lists a key an entry used, or deactivates the DID. */
  warnings: string[];
  passed: boolean;
}

/**
 * Beside the report, never in it (P14.25; D22): the served author log does not hold the version the entries
 * name, its newest version deactivates the DID, or no longer lists the key the entries were signed with.
 * A missing named version is also a failure: the report cannot check the entries, and the run does not
 * pass. A removed key or a deactivation is a warning only: the inscribed entries stay accepted, since each
 * is checked at the version it names (P5.3, P9.33). Each message is one or more full sentences.
 */
export function authorWarnings(c: AuthorLogCheck, verificationMethod: string, versionId: string): string[] {
  const latest = c.versions[c.versions.length - 1];
  if (!c.ok || !latest) return [];
  const out: string[] = [];
  const named = c.versions.find((v) => v.versionId === versionId)?.document;
  if (!named) out.push(`The resolved author log does not contain the version the entries name (${versionId}). The report cannot verify the inscribed entries against it, so the run does not pass.`);
  const vms = Array.isArray(named?.verificationMethod) ? (named.verificationMethod as Array<{ id?: unknown; publicKeyMultibase?: unknown }>) : [];
  const key = vms.find((v) => v.id === verificationMethod)?.publicKeyMultibase;
  if (latest.deactivated) out.push(`The latest resolved version of the author DID (${latest.versionId}) is deactivated. Inscribed entries are verified against the DID version each entry names.`);
  else if (typeof key === "string" && !listsKey(latest.document as JsonObject, key)) out.push(`The latest resolved version of the author DID (${latest.versionId}) no longer lists the key ${verificationMethod}. Inscribed entries are verified against the DID version each entry names.`);
  return out;
}

/**
 * Step 5. Waits until the final reveal has `minConfirmations` confirmations, by default the
 * transfer depth of 6 (P7.22, P14.13), so that the publication history the report relies on can
 * pass the transfer check.
 */
export async function stepVerify(ctx: Ctx, opts: { out?: string; minConfirmations?: number } = {}): Promise<LastRun> {
  const s = loadState(ctx.stateDir, ctx.network);
  if (!s.signed || !s.funding || !s.original || !s.author || !s.reveal) throw new Error("run broadcast first");
  const signed = s.signed;
  const final = signed.txids[signed.txids.length - 1];
  const depth = opts.minConfirmations ?? OG_LIMITS.transferDepth;
  ctx.io.say(`Waiting for the final reveal ${final} to have ${depth} confirmation(s)...`);
  await until(ctx, `the final reveal to have ${depth} confirmations`, async () => ((await ctx.chain.txConfirmations(final)) ?? 0) >= depth ? true : undefined);
  const original = s.original.genesis.state.id as string;
  const sat = BigInt(s.funding.sat);
  // Wait until the explorer has indexed every part, at a tip of its own where each part is `depth` deep: the
  // evidence set's tip is the explorer's, which can trail the chain backend's by a block or more.
  const read = await until(ctx, `the explorer to index the inscriptions ${depth} blocks deep`, async () => {
    const r = await readSatEvidence({ original, network: ctx.network, sat, ord: ctx.ord, chain: ctx.chain });
    const parts = signed.txids.slice(1).map((t) => r.inscriptions.find((i) => i.id === `${t}i0`));
    return parts.every((i) => i !== undefined && i.confirmations >= depth) ? r : undefined;
  });
  // D22: the author's history is not inscribed. Resolve it from its public URL, no redirects, and supply it
  // in the evidence set as a signer history whose source is that URL, with its obtained time (P7.8, P7.17).
  const fetchLog = ctx.fetchAuthorLog ?? (async (url: string) => {
    const r = await fetch(url, { redirect: "error" });
    return r.ok ? r.text() : null;
  });
  const obtained = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const served = await fetchLog(s.author.url).catch(() => null);
  const evidence = served === null ? read.evidence : withResolvedSigner(read.evidence, { did: s.author.did, url: s.author.url, log: served, obtained });
  const report = await verifyOriginal(evidence);
  const named = [s.original.genesis, ...(s.anchoringEntry ? [s.anchoringEntry] : [])].map((e) => (e.state.author as { versionId: string }).versionId);
  let publicHost: LastRun["publicHost"] = { url: s.author.url, served: served !== null, verifies: false, reachesNamedVersions: false };
  const warnings: string[] = [];
  if (served !== null) {
    const c = await checkAuthorLog(s.author.did, served);
    publicHost = { url: s.author.url, served: true, verifies: c.ok, reachesNamedVersions: c.ok && named.every((v) => c.versions.some((x) => x.versionId === v)), obtained, latestVersionId: c.latestVersionId, reason: c.ok ? undefined : c.reason };
    warnings.push(...authorWarnings(c, s.author.verificationMethod, s.author.versionId));
  }
  const axes = report.axes as Record<string, string>;
  const run: LastRun = {
    command: "originals-og anchor",
    profile: OG_METHOD,
    network: ctx.network,
    original,
    author: s.author.did,
    authorUrl: s.author.url,
    sat: s.funding.sat,
    anchoringAlias: btcoDid(ctx.network, sat),
    holder: report.bitcoin?.holder.address ?? null,
    revealDestination: s.reveal.holder,
    transactions: { funding: s.funding.txid, commit: signed.txids[0], reveals: signed.txids.slice(1) },
    inscriptions: read.inscriptions.map((i) => ({ id: i.id, height: i.height, txIndex: i.txIndex, inscriptionIndex: i.inscriptionIndex, confirmations: i.confirmations, metaprotocol: i.metaprotocol, contentType: i.contentType, envelopeBytes: i.envelope.length, envelopeDigest: resourceDigest(i.envelope) })),
    tip: evidence.tip!,
    ord: `${read.ordVersion} at ${ctx.ord.base}`,
    backend: ctx.chain.name,
    report,
    defaultCheck: defaultCheck(report),
    transferCheck: transferCheck(report),
    publicHost,
    warnings,
    passed: axes.outcome === "verified" && axes.bitcoin === "anchored" && axes.state === "current" && transferCheck(report) && publicHost.verifies && publicHost.reachesNamedVersions,
  };
  const out = opts.out ?? join(ctx.stateDir, "last-run.json");
  writeFileSync(out, JSON.stringify(run, null, 2) + "\n");
  ctx.io.say(`Report: outcome ${axes.outcome}, state ${axes.state}, bitcoin ${axes.bitcoin}, availability ${axes.availability}; holder at the tip ${run.holder ?? "not observed"} (${JSON.stringify(report.bitcoin?.holder.uniqueness)}).`);
  if (run.holder !== run.revealDestination) ctx.io.say(`The sat is no longer at the reveal destination ${run.revealDestination}: it has moved since the reveal (P9.11).`);
  ctx.io.say(describeTransferCheck(report));
  ctx.io.say(`Author log at ${publicHost.url}: ${publicHost.served ? (publicHost.verifies && publicHost.reachesNamedVersions ? `served, verifies and reaches the versions the entries name (latest ${publicHost.latestVersionId}); supplied to the verifier as the resolved history` : `served but ${publicHost.verifies ? "does not reach the versions the entries name" : `does not verify (${publicHost.reason ?? "invalid"})`}`) : "not served: the report cannot check the author's signatures (signer-history-missing)"}.`);
  for (const w of warnings) ctx.io.say(`Warning (not part of the report): ${w}`);
  ctx.io.say(`Wrote ${out}. ${run.passed ? "PASS" : "NOT PASSED"}`);
  if (run.passed) {
    s.done = true;
    saveState(ctx.stateDir, s);
    ctx.io.say("The reveal has confirmed: the ephemeral reveal key in the state file is no longer needed.");
  }
  return run;
}
