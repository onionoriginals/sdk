/**
 * What an Originals inscription carries (P9.17, P14.12; owner decision of 1
 * November 2026, originals-spec #53, #54):
 * - metadata (ord tag 5): the CBOR encoding of a JSON array of the entries it
 *   carries, each the parsed JSON of one stored asset log line. The JSON-to-CBOR
 *   mapping is ord's for `--json-metadata` and stays PROVISIONAL (D6, P14.12):
 *   objects are maps with text keys in the object's order, integers in
 *   shortest form, other numbers as the narrowest float (half, single or
 *   double precision) that holds them exactly (#54). Hashes and proofs are over
 *   each entry's JCS form, so key order and float width do not matter (P14.3).
 * - content type (ord tag 1) and body (owner decision, 18 November 2026,
 *   originals-spec PR 64): the preview the last entry names, under its media
 *   type; or, when it names none, the exact bytes of the resource version its
 *   descriptor names under that version's media type, or no body and no
 *   content type (P9.30). Never a content encoding or a delegate.
 * Metadata and body together are at most 350,000 bytes.
 */
import { OriginalsError } from "@originals/vh";
import { parseJson } from "@originals/vh/json";
import { checkDescriptor, encodeCbor, type ResourceDescriptor } from "@originals/vh/originals";

/** The CBOR metadata of an inscription carrying these stored lines, in order (P14.12). */
export function inscriptionMetadata(lines: readonly string[]): Uint8Array {
  return encodeCbor(lines.map((line) => parseJson(line)));
}

/**
 * The resource descriptor the entry on `line` names (P9.17), checked as the
 * state rules check it (P14.6). Throws `invalid-evidence` / `STATE_RESOURCE`
 * when the entry names none, or a malformed one.
 */
export function descriptorOfLine(line: string): ResourceDescriptor {
  const entry = parseJson(line) as { state?: { asset?: { resource?: unknown } } };
  const d = entry?.state?.asset?.resource;
  if (d === undefined) throw new OriginalsError("invalid-evidence", "STATE_RESOURCE", "the entry names no resource descriptor (P9.17)");
  return checkDescriptor(d, "state.asset.resource");
}

/**
 * The preview the entry on `line` names (P9.30, P14.5), checked as a
 * descriptor, or undefined when it names none.
 */
export function previewOfLine(line: string): ResourceDescriptor | undefined {
  const entry = parseJson(line) as { state?: { asset?: { preview?: unknown } } };
  const p = entry?.state?.asset?.preview;
  return p === undefined ? undefined : checkDescriptor(p, "state.asset.preview");
}

/**
 * Media types that explorers may render as active content, outside this
 * profile's isolation rules (P9.7, P9.18). PROVISIONAL: the spec names HTML
 * and SVG as examples; this list adds their close relatives and scripts.
 */
const ACTIVE = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/x-javascript",
  "text/xml",
  "application/xml",
  "application/pdf",
  "application/wasm",
]);

export function isActiveContent(mediaType: string): boolean {
  const type = mediaType.toLowerCase();
  return ACTIVE.has(type) || (type.startsWith("image/") && type.endsWith("+xml"));
}

/** What an inscription's body carries (P9.17, P9.30): the preview its last entry names, the full version, or none. */
export type InscribedBody =
  | { kind: "preview"; mediaType: string; size: number; digest: string }
  | { kind: "full"; mediaType: string; size: number; digest: string }
  | { kind: "none" };

/** What an inscription costs at the fee rate the SDK uses (P9.18), in sats. */
export interface InscriptionCost {
  /** sat/vB. */
  feeRate: number;
  commitFee: number;
  revealFee: number;
  /** The fees together: what the inscription costs. */
  total: number;
  /** The value of the output that carries the sat after the reveal: kept by its holder, not spent. */
  postage: number;
}

/**
 * What the SDK tells the author before inscribing an entry (P9.18; C12-193):
 * whether the inscription carries the preview, the full version or no body
 * (P9.30); that this body, and the log with its name and metadata, become
 * public and permanent on Bitcoin and cannot be removed by a later entry
 * (P8.3); what it costs at the fee rate the SDK will use; that the version
 * itself is not on Bitcoin unless inscribed in full; and, for active content
 * in the body, that explorers may render it outside this profile's isolation
 * rules (P9.7).
 */
export interface InscriptionNotice {
  /** The resource version the last entry names. */
  version: { digest: string; mediaType: string; size: number };
  /** What the body carries. */
  body: InscribedBody;
  /** The entries whose state, name and metadata included, the metadata carries. */
  entries: string[];
  permanent: true;
  /** Whether the body is active content (P9.7); never for a preview of an image, which is WebP. */
  activeContent: boolean;
  /** The cost at the fee rate used, when the pair is built. */
  cost?: InscriptionCost;
  /** The plain statement to show the author. */
  text: string;
}

/**
 * The notice for an inscription carrying `entries` whose last entry names the
 * version `d`. `body` defaults to the full version (an entry with no preview,
 * inscribed in full).
 */
export function inscriptionNotice(entries: readonly string[], d: ResourceDescriptor, body: InscribedBody = { kind: "full", ...d }, cost?: InscriptionCost): InscriptionNotice {
  const activeContent = body.kind !== "none" && isActiveContent(body.mediaType);
  const carried = entries.length === 1
    ? `the entry ${entries[0]}`
    : `the log from ${entries[0]} through ${entries[entries.length - 1]}`;
  const what = body.kind === "preview"
    ? `a preview (${body.mediaType}, ${body.size} bytes) of the resource version ${d.digest}, not the version itself,`
    : body.kind === "full"
      ? `the full resource version ${d.digest} (${d.mediaType}, ${d.size} bytes)`
      : `no body, only`;
  const text =
    `This inscription puts ${what} and ${carried}, with the Original's name and metadata, on Bitcoin. They become public and permanent, ` +
    "and no later entry can remove them." +
    (body.kind !== "full" ? ` The version itself (${d.mediaType}, ${d.size} bytes) is not on Bitcoin: keep it, publish it or hand it over yourself.` : "") +
    (cost ? ` At ${cost.feeRate} sat/vB it costs ${cost.total} sats in fees (commit ${cost.commitFee}, reveal ${cost.revealFee}); the sat keeps ${cost.postage} sats of postage.` : "") +
    (body.kind !== "none" && activeContent ? ` ${body.mediaType} is active content: Bitcoin explorers may render it outside the Originals isolation rules.` : "");
  return { version: { digest: d.digest, mediaType: d.mediaType, size: d.size }, body, entries: [...entries], permanent: true, activeContent, ...(cost ? { cost } : {}), text };
}
