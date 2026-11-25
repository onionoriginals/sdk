/**
 * The DID document derived for each version of a did:og (P14.9, P3.8). It is
 * computed from the entry alone; a stored or served document is never used.
 * The grants and the preview are not in it.
 */
import type { JsonObject } from "../json/index.js";
import type { OgEntry } from "./log.js";
import { stateOf } from "./state.js";

export function deriveDocument(entry: OgEntry): JsonObject {
  const s = stateOf(entry);
  const doc: JsonObject = {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: s.id,
    controller: s.author.did,
  };
  if (s.asset.aliases.length) doc.alsoKnownAs = [...s.asset.aliases];
  const { mediaType, size, digest } = s.asset.resource;
  doc.service = [{ id: `${s.id}#files`, type: "OriginalsFiles", serviceEndpoint: { mediaType, size, digest } }];
  return doc;
}
