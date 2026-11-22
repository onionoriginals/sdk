/**
 * Writing a publication (P9.17, P9.32, P9.33, P14.12): the inscriptions that
 * carry one step of an Original's log on its anchoring sat. A writer splits a
 * publication into parts only when one inscription would exceed 350,000
 * bytes, puts the last entry and the body in the final part, and refuses a
 * publication that needs more than 16 parts.
 */
import { encodeEnvelope, encodeMetadata, type Metadata, type SignerHistoryItem } from "./inscription.js";
import type { OgEntry } from "./log.js";
import { OG_LIMITS, reject } from "./rules.js";
import { stateOf } from "./state.js";

export interface PublicationPart {
  metadata: Uint8Array;
  contentType: string | null;
  body: Uint8Array | null;
  envelope: Uint8Array;
}

export interface PublicationInput {
  /** The entries it carries: genesis through the anchoring entry, or exactly one later entry. */
  entries: OgEntry[];
  /** Signer histories to inscribe with it, each continuing what is already inscribed (P9.33). */
  signers?: SignerHistoryItem[];
  /** The bytes the last entry's `body` names: its preview, its full version, or none (P9.17). */
  body: Uint8Array | null;
}

/** P9.17: the content type and body the last entry's body mode requires. */
function bodyOf(last: OgEntry, body: Uint8Array | null): { contentType: string | null; body: Uint8Array | null } {
  const a = stateOf(last).asset;
  if (a.body === "preview") {
    if (!body || body.length !== a.preview!.size) reject("P9.17", "BODY_REQUIRED", "body preview: the preview's bytes are required");
    return { contentType: a.preview!.mediaType, body };
  }
  if (a.body === "full") {
    if (!body || body.length !== a.resource.size) reject("P9.17", "BODY_REQUIRED", "body full: the version's bytes are required");
    return { contentType: a.resource.mediaType, body };
  }
  if (a.body === "none") return { contentType: null, body: null };
  return reject("P9.30", "BODY_PRESENCE", "the last entry of a publication signs a body mode");
}

const fits = (m: Metadata, body: Uint8Array | null) => encodeMetadata(m).length + (body?.length ?? 0) <= OG_LIMITS.inscriptionBytes;

/** Build a publication's inscriptions, in one part or as few as needed (P9.32). */
export function buildPublication(input: PublicationInput): PublicationPart[] {
  if (input.entries.length === 0) reject("P9.17", "NO_ENTRIES", "a publication carries at least one entry");
  const last = input.entries[input.entries.length - 1];
  const { contentType, body } = bodyOf(last, input.body);
  const single: Metadata = { entries: input.entries, ...(input.signers?.length ? { signers: input.signers } : {}) };
  if (fits(single, body)) return [part(single, contentType, body)];

  // Parts: the final one holds the last entry and the body; the earlier ones hold the signer
  // histories, then the other entries, in order, packed greedily.
  const finalProbe: Metadata = { entries: [last], part: [16, 16] };
  if (!fits(finalProbe, body)) reject("P9.17", "FINAL_TOO_LARGE", "the last entry and its body do not fit in one inscription");
  const groups: Array<{ entries: OgEntry[]; signers: SignerHistoryItem[] }> = [{ entries: [], signers: [] }];
  const probe = (g: { entries: OgEntry[]; signers: SignerHistoryItem[] }): Metadata => ({ entries: g.entries, ...(g.signers.length ? { signers: g.signers } : {}), part: [16, 16] });
  const place = (add: (g: { entries: OgEntry[]; signers: SignerHistoryItem[] }) => void, remove: (g: { entries: OgEntry[]; signers: SignerHistoryItem[] }) => void) => {
    const g = groups[groups.length - 1];
    add(g);
    if (fits(probe(g), null)) return;
    remove(g);
    const fresh = { entries: [], signers: [] };
    add(fresh);
    if (!fits(probe(fresh), null)) reject("P9.32", "ITEM_TOO_LARGE", "one signer history or entry does not fit in an inscription");
    groups.push(fresh);
  };
  for (const s of input.signers ?? []) place((g) => g.signers.push(s), (g) => g.signers.pop());
  for (const e of input.entries.slice(0, -1)) place((g) => g.entries.push(e), (g) => g.entries.pop());
  const n = groups.length + 1;
  if (n > OG_LIMITS.publicationParts) reject("P9.17", "TOO_MANY_PARTS", "the publication would need more than 16 inscriptions (P14.13)");
  const parts = groups.map((g, k) => part({ entries: g.entries, ...(g.signers.length ? { signers: g.signers } : {}), part: [k + 1, n] }, null, null));
  parts.push(part({ entries: [last], part: [n, n] }, contentType, body));
  return parts;
}

function part(m: Metadata, contentType: string | null, body: Uint8Array | null): PublicationPart {
  const metadata = encodeMetadata(m);
  return { metadata, contentType, body, envelope: encodeEnvelope({ contentType, metadata, body }) };
}
