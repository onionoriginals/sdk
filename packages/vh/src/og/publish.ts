/**
 * Writing a publication (P9.17, P9.32, P14.12): the inscriptions that carry
 * one step of an Original's log on its anchoring sat. A writer splits a
 * publication into parts only when one inscription would exceed 350,000
 * bytes, puts the last entry and the body in the final part, and refuses a
 * publication that needs more than 16 parts. It never inscribes a signer DID
 * history (D22): the metadata is `{entries, part?}`, and its size counts
 * entries and the body only.
 */
import { encodeEnvelope, encodeMetadata, type Metadata } from "./inscription.js";
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
  const single: Metadata = { entries: input.entries };
  if (fits(single, body)) return [part(single, contentType, body)];

  // Parts: the final one holds the last entry and the body; the earlier ones hold the other
  // entries, in order, packed greedily.
  const finalProbe: Metadata = { entries: [last], part: [16, 16] };
  if (!fits(finalProbe, body)) reject("P9.17", "FINAL_TOO_LARGE", "the last entry and its body do not fit in one inscription");
  const groups: OgEntry[][] = [];
  for (const e of input.entries.slice(0, -1)) {
    const g = groups[groups.length - 1];
    if (g && fits({ entries: [...g, e], part: [16, 16] }, null)) {
      g.push(e);
      continue;
    }
    if (!fits({ entries: [e], part: [16, 16] }, null)) reject("P9.32", "ITEM_TOO_LARGE", "one entry does not fit in an inscription");
    groups.push([e]);
  }
  const n = groups.length + 1;
  if (n > OG_LIMITS.publicationParts) reject("P9.17", "TOO_MANY_PARTS", "the publication would need more than 16 inscriptions (P14.13)");
  const parts = groups.map((entries, k) => part({ entries, part: [k + 1, n] }, null, null));
  parts.push(part({ entries: [last], part: [n, n] }, contentType, body));
  return parts;
}

function part(m: Metadata, contentType: string | null, body: Uint8Array | null): PublicationPart {
  const metadata = encodeMetadata(m);
  return { metadata, contentType, body, envelope: encodeEnvelope({ contentType, metadata, body }) };
}
