/**
 * What an Originals inscription carries (P9.17, P14.12; owner decision of 1
 * November 2026, originals-spec #53):
 * - metadata (ord tag 5): the CBOR encoding of a JSON array of the entries it
 *   carries, each the parsed JSON of one stored asset log line. The JSON-to-CBOR
 *   mapping is ord's for `--json-metadata` and stays PROVISIONAL (D6, P14.12):
 *   objects are maps with text keys in the object's order, integers in
 *   shortest form. Hashes and proofs are over each entry's JCS form, so key
 *   order does not matter (P14.3).
 * - content type (ord tag 1): the `mediaType` of the resource in the last entry.
 * - body: the exact bytes of the resource version that entry's descriptor names,
 *   with no content encoding.
 * Metadata and body together are at most 350,000 bytes.
 */
import { OriginalsError } from "@originals/vh";
import { parseJson } from "@originals/vh/json";
import { encodeCbor, type ResourceDescriptor } from "@originals/vh/originals";

/** The CBOR metadata of an inscription carrying these stored lines, in order (P14.12). */
export function inscriptionMetadata(lines: readonly string[]): Uint8Array {
  try {
    return encodeCbor(lines.map((line) => parseJson(line)));
  } catch (error) {
    // A valid entry with a non-integer number (P14.5 allows one) has no CBOR form under the mapping
    // P14.12 gives, so it can never be inscribed. PROVISIONAL, pending a spec fix (plan 011 finding S13).
    if (error instanceof OriginalsError && error.code === "CBOR_INVALID") {
      throw new OriginalsError("unsupported-profile", "METADATA_NOT_INSCRIBABLE", "an entry holds a number that is not an integer of magnitude at most 2^53 - 1, which inscription metadata cannot carry (P14.12)");
    }
    throw error;
  }
}

/** The resource descriptor the entry on `line` names (P9.17). */
export function descriptorOfLine(line: string): ResourceDescriptor {
  const entry = parseJson(line) as { state?: { asset?: { resource?: ResourceDescriptor } } };
  const d = entry.state?.asset?.resource;
  if (!d || typeof d.digest !== "string" || typeof d.mediaType !== "string" || typeof d.size !== "number") {
    throw new TypeError("the entry names no resource descriptor");
  }
  return d;
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

/**
 * What the SDK tells the author before inscribing an entry (P9.18; C12-193):
 * the inscribed resource version, and the log with its name and metadata,
 * become public and permanent on Bitcoin and cannot be removed by a later
 * entry (P8.3); for active content, that explorers may render it outside
 * this profile's isolation rules (P9.7).
 */
export interface InscriptionNotice {
  /** The resource version the inscription's body carries. */
  version: { digest: string; mediaType: string; size: number };
  /** The entries whose state, name and metadata included, the metadata carries. */
  entries: string[];
  permanent: true;
  activeContent: boolean;
  /** The plain statement to show the author. */
  text: string;
}

export function inscriptionNotice(entries: readonly string[], d: ResourceDescriptor): InscriptionNotice {
  const activeContent = isActiveContent(d.mediaType);
  const carried = entries.length === 1
    ? `the entry ${entries[0]}`
    : `the log from ${entries[0]} through ${entries[entries.length - 1]}`;
  const text =
    `This inscription puts the resource version ${d.digest} (${d.mediaType}, ${d.size} bytes) and ${carried}, ` +
    `with the Original's name and metadata, on Bitcoin. They become public and permanent, ` +
    "and no later entry can remove them." +
    (activeContent ? ` ${d.mediaType} is active content: Bitcoin explorers may render it outside the Originals isolation rules.` : "");
  return { version: { digest: d.digest, mediaType: d.mediaType, size: d.size }, entries: [...entries], permanent: true, activeContent, text };
}
