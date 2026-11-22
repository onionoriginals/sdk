/**
 * The SDK's did:og writer for an Original that goes straight to Bitcoin: its
 * genesis entry, and the anchoring entry that adds the anchoring sat's
 * did:btco alias and signs the body mode (P9.10, P9.17, P9.30). Before
 * inscribing, the writer verifies its own committed log as a local copy
 * (P9.18) and tells the author what becomes public (P9.18, P8.3).
 */
import type { ProofSigner } from "@originals/vh/crypto";
import { parseJsonLines, type JsonObject } from "@originals/vh/json";
import {
  OG_LIMITS, btcoDid, transferCheck, buildPublication, isActiveContent, prepareGenesis, prepareNext, resourceDigest, serializeLog, signEntry,
  type BitcoinNetwork, type BodyMode, type Descriptor, type OgEntry, type PublicationPart, type Report, type SignerHistoryItem, verifyLocalCopy,
} from "@originals/vh/og";
import { generateImagePreview } from "../originals/preview.js";

export interface AuthorRef {
  did: string;
  verificationMethod: string;
  versionId: string;
  /** The author DID's `did.jsonl`, inscribed with the anchoring publication (P9.33). */
  log: string;
  signer: ProofSigner;
}

export interface OriginalInput {
  name: string;
  bytes: Uint8Array;
  mediaType: string;
  network: BitcoinNetwork;
  metadata?: JsonObject;
  author: AuthorRef;
  /** The body mode the anchoring entry signs (P9.17). Default `preview`. */
  body?: BodyMode;
  /** For a version that is not an image: the author's own preview, if any (P9.30). */
  preview?: { bytes: Uint8Array; mediaType: string };
  now?: () => Date;
}

const descriptorOf = (bytes: Uint8Array, mediaType: string): Descriptor => ({ mediaType, size: bytes.length, digest: resourceDigest(bytes) });
const isImage = (mediaType: string) => mediaType.split("/")[0].toLowerCase() === "image";
const time = (d: Date) => d.toISOString().replace(".000Z", "Z");

/** The preview the anchoring entry names, and the body it signs (P9.30): generated WebP for an image. */
export async function choosePreview(input: Pick<OriginalInput, "bytes" | "mediaType" | "body" | "preview">): Promise<{ body: BodyMode; preview?: { bytes: Uint8Array; descriptor: Descriptor }; message: string }> {
  const mode = input.body ?? "preview";
  if (mode === "full") {
    return { body: "full", message: "the full version will be inscribed" };
  }
  if (mode === "none") return { body: "none", message: "no body: the entries are in the metadata only" };
  if (isImage(input.mediaType)) {
    const r = await generateImagePreview(input.bytes, input.mediaType);
    if (r.status === "generated") return { body: "preview", preview: { bytes: r.preview.bytes, descriptor: descriptorOf(r.preview.bytes, "image/webp") }, message: `a ${r.preview.width}x${r.preview.height} WebP preview of ${r.preview.bytes.length} bytes` };
    return { body: "none", message: `no preview: ${r.failure.message}; the inscription has no body unless you choose the full version` };
  }
  if (input.preview) {
    if (input.preview.bytes.length < 1 || input.preview.bytes.length > OG_LIMITS.previewBytes) throw new Error("a preview is 1 to 8,192 bytes (P9.30)");
    return { body: "preview", preview: { bytes: input.preview.bytes, descriptor: descriptorOf(input.preview.bytes, input.preview.mediaType) }, message: `your ${input.preview.mediaType} preview of ${input.preview.bytes.length} bytes` };
  }
  return { body: "none", message: "no preview for a version that is not an image: the inscription has no body" };
}

export async function createGenesis(input: OriginalInput): Promise<OgEntry> {
  const now = input.now ?? (() => new Date());
  const asset: JsonObject = { name: input.name, status: "active", network: input.network, resource: descriptorOf(input.bytes, input.mediaType) as unknown as JsonObject, aliases: [] };
  if (input.metadata) asset.metadata = input.metadata;
  const state: JsonObject = {
    id: "did:og:{SCID}", operation: "create",
    author: { did: input.author.did, verificationMethod: input.author.verificationMethod, versionId: input.author.versionId },
    asset, transitions: [{ from: null, to: resourceDigest(input.bytes) }],
  };
  return signEntry(prepareGenesis({ versionTime: time(now()), state }), input.author.verificationMethod, input.author.signer);
}

/** The anchoring entry (P9.10): the parent's state with the did:btco alias of the sat, the network unchanged, and the body mode. */
export async function createAnchoringEntry(parent: OgEntry, input: { sat: bigint | string; network: BitcoinNetwork; body: BodyMode; preview?: Descriptor; author: AuthorRef; now?: () => Date }): Promise<OgEntry> {
  const state = JSON.parse(JSON.stringify(parent.state)) as JsonObject & { asset: JsonObject };
  state.operation = "update";
  state.transitions = [];
  state.author = { did: input.author.did, verificationMethod: input.author.verificationMethod, versionId: input.author.versionId };
  state.asset.aliases = [...(state.asset.aliases as string[]), btcoDid(input.network, input.sat)];
  state.asset.body = input.body;
  if (input.preview) state.asset.preview = input.preview as unknown as JsonObject;
  const now = input.now ?? (() => new Date());
  let t = now();
  if (t.getTime() <= Date.parse(parent.versionTime)) t = new Date(Date.parse(parent.versionTime) + 1000);
  return signEntry(prepareNext(parent, { versionTime: time(t), parameters: {}, state }), input.author.verificationMethod, input.author.signer);
}

/** The anchoring publication (P9.17, P9.33): the log through the anchoring entry and the author's history. */
export function anchoringPublication(entries: OgEntry[], author: AuthorRef, body: Uint8Array | null): PublicationPart[] {
  const signers: SignerHistoryItem[] = [{ did: author.did, log: parseJsonLines(author.log) as JsonObject[] }];
  return buildPublication({ entries, signers, body });
}

/**
 * P9.18: the writer verifies its own committed log as a local copy before it
 * inscribes: whole, from genesis through the anchoring entry, with the
 * author's history it will inscribe. Never current, and never a report for
 * anyone else; it gates the inscription only.
 */
export async function checkLocalCopy(entries: OgEntry[], author: AuthorRef, resource: Uint8Array): Promise<{ ok: boolean; report: Report; problems: string[] }> {
  const enc = new TextEncoder();
  const report = await verifyLocalCopy({
    original: entries[0].state.id as string,
    inputs: [
      { kind: "log", source: "local-copy", bytes: enc.encode(serializeLog(entries)) },
      { kind: "signer-history", source: "local-copy:author", bytes: enc.encode(author.log), did: author.did },
      { kind: "resource", source: "local-copy:resource", bytes: resource },
    ],
  });
  const problems: string[] = [];
  for (const e of report.entries ?? []) if (e.status !== "accepted") problems.push(`${e.versionId} is ${e.status}${"rule" in e ? ` under ${e.rule}` : ""}`);
  // P9.33 (T9-073): never inscribe an entry whose key the newest verified version of its signer's DID no longer lists.
  for (const e of report.entries ?? []) if (e.status === "accepted" && e.authority !== "current-key") problems.push(`${e.versionId} is signed with a key the newest author DID version no longer lists (${e.authority})`);
  const axes = report.axes as { history?: string; identity?: string };
  if (axes.history !== "valid") problems.push(`history is ${axes.history}`);
  if (axes.identity !== "complete") problems.push(`identity is ${axes.identity}`);
  if (report.entries?.length !== entries.length) problems.push("not every entry was checked");
  return { ok: problems.length === 0, report, problems };
}

export interface Disclosure {
  lines: string[];
}

/** What the author must be told before an entry is inscribed (P9.18, T9-083). */
export function disclosure(input: { name: string; mediaType: string; bytes: number; body: BodyMode; previewMessage: string; parts: number; feeSats: bigint; feeRate: number; network: BitcoinNetwork; author: string }): Disclosure {
  const lines = [
    `Body: ${input.body === "preview" ? `a preview (${input.previewMessage})` : input.body === "full" ? `the full version (${input.bytes} bytes)` : "none"}.`,
    `Public and permanent on Bitcoin ${input.network}, and no later entry can remove it: this body, the log with its name "${input.name}" and metadata, and the author DID history of ${input.author}.`,
    input.body === "full" ? "Bitcoin will hold the current version." : `Bitcoin will NOT hold the version itself (${input.mediaType}, ${input.bytes} bytes); keep it, and give it to whoever receives the sat.`,
    `Inscriptions: ${input.parts}. Cost: about ${input.feeSats} sats in fees at ${input.feeRate} sat/vB, plus the postage the sat keeps.`,
  ];
  if (isActiveContent(input.body === "full" ? input.mediaType : "")) lines.push("Warning: the body is active content (HTML or SVG); Bitcoin explorers may render it outside the profile's isolation (P9.7).");
  return { lines };
}

/**
 * How the SDK and its interfaces describe the transfer check (P7.22, T7-074): a check on the
 * Original's publication history, which must be at least the transfer depth (6 blocks, P14.13)
 * deep, never "6 confirmations of the transfer". The holder is the one the index reports under
 * its own confirmation policy (P9.11), so the transaction that last moved the sat may have fewer
 * confirmations; an application that needs that transfer settled checks its depth separately.
 */
export function describeTransferCheck(report: Report): string {
  const passes = transferCheck(report);
  const shallow = report.diagnostics.filter((d) => d.code === "insufficient-depth").map((d) => d.item.id);
  const verdict = passes ? "passes" : shallow.length ? `fails: ${shallow.length} publication(s) of the history are fewer than ${OG_LIMITS.transferDepth} blocks deep (${shallow.join(", ")})` : "fails";
  return `Transfer check on the Original's publication history (the anchoring publication and every publication the head depends on at least ${OG_LIMITS.transferDepth} blocks deep): ${verdict}. It does not check how deep the transaction that last moved the sat is; check that separately if you need the transfer itself settled.`;
}
