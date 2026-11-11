/**
 * did:evm resolution (originals-spec PR 59, proposed: P3.9, P14.18).
 * EXPERIMENTAL and PROVISIONAL, as the method name is (D6).
 *
 * A did:evm DID is an alias of an Original only if it names the token P14.19
 * derives for that Original and the log accepted on that token lists it; this
 * resolver accepts neither alone. It reads the Original's log from its tokens,
 * verifies it under this profile (`verifyOriginal`), and returns the did:vh,
 * its state and the report. The DID document is derived from the state
 * accepted on the token, never stored: nothing here reads `tokenURI` or any
 * served document (P3.8, P3.9).
 */
import type { JsonObject } from "../json/index.js";
import type { EvmEvidence, EvmStretch } from "./evm-anchor.js";
import { parseEvmAlias, type TrustClass, describeClass } from "./evm.js";
import type { AssetState } from "./state.js";
import { verifyOriginal, type OriginalsReport, type VerifyOriginalOptions } from "./verify.js";

export interface DidEvmResolution {
  did: string;
  /**
   * resolved: the token alias of an Original, on the token it is anchored on
   * now. moved: the Original has left this token (P9.29); `replacedBy` names
   * the alias that replaced it, and no state on this token is returned.
   * not-found: the DID names no token with an accepted anchoring publication
   * of the Original the evidence shows, or one whose accepted log does not
   * list it: it resolves to nothing (P3.9, P9.23). unsupported: no pinned
   * anchor contract, an unlisted chain, or other code (P9.19, P9.21).
   * unverified: the token's evidence is missing (P9.22, P9.25).
   */
  status: "resolved" | "moved" | "not-found" | "unsupported" | "unverified";
  /** The Original's did:vh, when the token's accepted log names it. */
  original: string | null;
  replacedBy: string | null;
  /** For `resolved`: the state accepted on the token (the report says whether it is current). */
  state: AssetState | null;
  /** For `resolved`: P14.18's derived document, the token alias as `id` and service `id`, `alsoKnownAs` exactly the did:vh. */
  document: JsonObject | null;
  chain: { chain: string; name: string; class: TrustClass; describes: ReturnType<typeof describeClass> } | null;
  report: OriginalsReport | null;
}

const nothing = (did: string, status: DidEvmResolution["status"], report: OriginalsReport | null = null, original: string | null = null): DidEvmResolution =>
  ({ did, status, original, replacedBy: null, state: null, document: null, chain: null, report });

/**
 * Resolve a did:evm DID (P3.9). `evm` is the pin and the providers' reads of
 * the token it names and of every token on the Original's path; `log` may add
 * a copy of the log, which is never preferred to the tokens (P7.14).
 * Throws STATE_ALIASES (invalid-evidence) for a DID not of P14.18's form.
 */
export async function resolveDidEvm(did: string, options: Omit<VerifyOriginalOptions, "evm"> & { evm: EvmEvidence }): Promise<DidEvmResolution> {
  const alias = parseEvmAlias(did);
  const pin = options.evm.pin;
  if (!pin) return nothing(did, "unsupported");
  // P14.18, P14.21: a token of other code, or at another address, is not an Originals anchor.
  if (alias.contract !== pin.address) return nothing(did, "not-found");
  const report = await verifyOriginal(options);
  const evm = report.evm;
  if (!evm) return nothing(did, "not-found", report, report.original);
  if (evm.status === "unsupported" && evm.stretches.every((s) => s.token !== did)) return nothing(did, "unsupported", report);
  const stretch: EvmStretch | undefined = evm.stretches.find((s) => s.token === did);
  if (!stretch) return nothing(did, evm.status === "unverified" ? "unverified" : "not-found", report, report.original);
  if (stretch.status === "unverified") return nothing(did, "unverified", report, report.original);
  // P9.23: no accepted anchoring publication (or arrival) on the token: not an alias, nothing to resolve.
  if (stretch.status !== "anchored") return nothing(did, "not-found", report, report.original);
  const chain = { chain: stretch.chain, name: stretch.name, class: stretch.class, describes: stretch.describes };
  // P3.9, P9.29: a token the Original has left still resolves, to a report that it moved.
  if (stretch.departure) {
    return { did, status: "moved", original: report.original, replacedBy: stretch.departure.destination || null, state: null, document: null, chain, report };
  }
  const state = report.state;
  // P3.9: the log accepted on the token must list the alias.
  if (!state || !state.aliases.includes(did) || report.original === null) return nothing(did, "not-found", report, report.original);
  return { did, status: "resolved", original: report.original, replacedBy: null, state, document: tokenDocument(did, report.original, report.document), chain, report };
}

/** P14.18: P14.9's document, with the token alias as `id` and in the service `id`, and `alsoKnownAs` exactly the did:vh. */
function tokenDocument(did: string, original: string, derived: JsonObject | null): JsonObject | null {
  if (!derived) return null;
  const services = Array.isArray(derived.service) ? derived.service : [];
  return {
    ...derived,
    id: did,
    alsoKnownAs: [original],
    service: services.map((s) => {
      const service = s as JsonObject;
      const id = typeof service.id === "string" ? service.id : "";
      return { ...service, id: `${did}${id.slice(id.indexOf("#"))}` };
    }),
  };
}
