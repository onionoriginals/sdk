/**
 * The did:webvh alias of a published Original (P3.6, P3.7). A did:webvh is an
 * alias only when both directions hold: the Original's asset state lists it,
 * and its own latest DID document points back to the did:vh. PROVISIONAL
 * (plan 011, S4): "points back" means the did:webvh document's `alsoKnownAs`
 * lists the did:vh; the two logs have different SCIDs.
 *
 * The alias log is verified as did:webvh and used for nothing else: never for
 * the Original's state, resource versions, authority or ownership (P3.6).
 */
import { OriginalsError } from "../errors.js";
import { parseLog, verifyLog } from "../log/index.js";
import { didWebvh } from "../webvh/index.js";

/** The alias's own did:webvh log and witness file, as supplied in evidence. */
export interface AliasEvidence {
  did: string;
  log: string | unknown[];
  witness?: unknown;
}

export interface AliasReport {
  did: string;
  /**
   * confirmed: listed by the Original and pointing back to it.
   * not-confirmed: the alias log verifies but does not point back, has moved
   * or is deactivated. unavailable: no alias log was supplied. invalid: the
   * alias log does not verify as did:webvh.
   */
  status: "confirmed" | "not-confirmed" | "unavailable" | "invalid";
  reason?: "alias-does-not-point-here" | "alias-moved" | "alias-deactivated";
  message?: string;
}

/** Check one direction of P3.6: the alias's latest DID document points to `original`. */
export async function checkAlias(original: string, evidence: AliasEvidence | undefined, did: string, now?: number | Date): Promise<AliasReport> {
  if (!evidence) return { did, status: "unavailable" };
  let entries: unknown[];
  try {
    entries = typeof evidence.log === "string" ? parseLog(evidence.log) : evidence.log;
  } catch (error) {
    if (!(error instanceof OriginalsError)) throw error;
    return { did, status: "invalid", message: error.message };
  }
  const log = await verifyLog(entries, { specialisation: didWebvh, witnessFile: evidence.witness, now });
  const latest = log.entries[log.entries.length - 1];
  if (!latest || log.failure) return { did, status: "invalid", message: log.failure?.error.message ?? "the alias log is empty" };
  const document = latest.entry.state;
  if (latest.active.deactivated) return { did, status: "not-confirmed", reason: "alias-deactivated" };
  if (document.id !== did) return { did, status: "not-confirmed", reason: "alias-moved" };
  const aka = Array.isArray(document.alsoKnownAs) ? document.alsoKnownAs : [];
  if (!aka.includes(original)) return { did, status: "not-confirmed", reason: "alias-does-not-point-here" };
  return { did, status: "confirmed" };
}

/** The did:vh a did:webvh alias log claims to be an alias of, from its latest document. */
export async function aliasTarget(evidence: AliasEvidence, now?: number | Date): Promise<string | undefined> {
  const entries = typeof evidence.log === "string" ? parseLog(evidence.log) : evidence.log;
  const log = await verifyLog(entries, { specialisation: didWebvh, witnessFile: evidence.witness, now });
  const latest = log.entries[log.entries.length - 1];
  if (!latest || log.failure) return undefined;
  const aka = Array.isArray(latest.entry.state.alsoKnownAs) ? latest.entry.state.alsoKnownAs : [];
  const targets = aka.filter((x): x is string => typeof x === "string" && x.startsWith("did:vh:"));
  return targets.length === 1 ? targets[0] : undefined;
}
