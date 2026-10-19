/**
 * The `originals:1.0` did:vh extension (did:vh PR 3) as a VH-Log
 * specialisation. Keys come from the author DID (VH-Log PR 11): one proof per
 * entry (P5.2), by the author key the entry names (P5.3). versionTime carries
 * milliseconds (VH-Log PR 8; owner decision Q8).
 *
 * Witnesses (P9.8, P9.9 as reworded in plan 011 S2, owner decision Q7): an
 * entry that sets the witness parameter to a value other than `{}` must set it
 * to the declaration in the author DID version it names, and once witnesses
 * are active they cannot be removed (the anchoring exception arrives with
 * Bitcoin, plan 011 PR 9). An entry that leaves the parameter unchanged is not
 * checked against the declaration; witnesses check changes against the
 * author DID's latest state when they approve (P9.9).
 */
import { fail } from "../errors.js";
import { canonicalize, isJsonObject, type JsonObject } from "../json/index.js";
import type { Specialisation, VerifiedEntry, VersionRules } from "../log/index.js";
import type { DidVhExtension } from "../didvh/index.js";
import { authorKey, authorMethod, namedVersion, versionNumberOf, witnessDeclaration, type AuthorHistory } from "./author.js";
import { ORIGINALS_METHOD, checkAuthorRef, checkEntryState, type EntryState } from "./state.js";

export const ORIGINALS_1_0: VersionRules = Object.freeze({
  vhLog: "vh-log:1.0",
  rank: 1,
  entrySuites: ["eddsa-jcs-2022", "bip340-jcs-2025"],
  // PROVISIONAL (plan 011, S3): the spec names entry suites only.
  witnessSuites: ["eddsa-jcs-2022"],
}) as VersionRules;

function histories(list: Iterable<AuthorHistory>): Map<string, AuthorHistory> {
  return new Map([...list].map((h) => [h.did, h]));
}

/** The specialisation's rules, given the verified histories of the author DIDs in evidence. */
export function originalsRules(authors: Iterable<AuthorHistory>): Omit<Specialisation, "versions" | "versionParameter"> {
  const byDid = histories(authors);
  return {
    name: "originals",
    versionTime: { fractionalDigits: 3 },
    maxProofs: 1,
    keys: {
      kind: "controller",
      authorize: ({ entry, previous, proof }) => {
        const ref = checkAuthorRef(entry.state.author);
        if (previous) {
          const genesisAuthor = (previous.entry.state.author as JsonObject | undefined)?.did;
          if (ref.did !== genesisAuthor) fail("invalid-evidence", "AUTHOR_DID_CHANGED", "the author DID is fixed at genesis (P5.8)");
        }
        authorMethod(ref.did);
        if (proof.verificationMethod !== ref.verificationMethod) {
          fail("author-binding", "AUTHOR_VM_MISMATCH", "the proof's verificationMethod must be the author verification method the entry names (P5.2)");
        }
        const history = byDid.get(ref.did);
        if (!history) fail("incomplete-evidence", "AUTHOR_HISTORY_MISSING", `no verified history for author DID ${ref.did}`);
        const previousVersion = (previous?.entry.state.author as JsonObject | undefined)?.versionId;
        if (typeof previousVersion === "string" && versionNumberOf(ref.versionId) < versionNumberOf(previousVersion)) {
          fail("invalid-evidence", "AUTHOR_VERSION_REGRESSED", "an entry may not name an older author DID version than its predecessor (P5.8)");
        }
        return Promise.resolve(authorKey(namedVersion(history, ref), ref));
      },
    },
    validateEntry: ({ entry, previous, scid, index }) => {
      const set = entry.parameters.witness;
      if (isJsonObject(set) && Object.keys(set).length === 0) {
        const wasActive = Object.keys(previous?.active.witness ?? {}).length > 0;
        if (wasActive) fail("invalid-evidence", "WITNESS_REMOVED", "once witnesses are active an entry may not remove them (P9.9)");
      } else if (set !== undefined) {
        const ref = checkAuthorRef(entry.state.author);
        const history = byDid.get(ref.did);
        if (!history) fail("incomplete-evidence", "AUTHOR_HISTORY_MISSING", `no verified history for author DID ${ref.did}`);
        const declared = witnessDeclaration(namedVersion(history, ref));
        if (declared === null || canonicalize(declared) !== canonicalize(set)) {
          fail("invalid-evidence", "WITNESS_NOT_DECLARED", "the witness parameter must equal the author DID's declaration at the named version (P9.9)");
        }
      }
      checkEntryState(entry.state, {
        scid,
        index,
        previous: previous?.entry.state as unknown as EntryState | undefined,
        deactivatedParameter: entry.parameters.deactivated === true,
      });
    },
  };
}

export function originalsSpecialisation(authors: Iterable<AuthorHistory>): Specialisation {
  return { ...originalsRules(authors), versionParameter: "method", versions: { [ORIGINALS_METHOD]: ORIGINALS_1_0 } };
}

/**
 * The DID document of an Original's did:vh at a version, derived from the log
 * and never stored (P3.8). PROVISIONAL (D1): the `#files` service lists each
 * resource's current descriptor.
 */
export function deriveDocument(entries: VerifiedEntry[]): JsonObject {
  const state = entries[entries.length - 1].entry.state as unknown as EntryState;
  const service = {
    id: `${state.id}#files`,
    type: "OriginalsFiles",
    serviceEndpoint: Object.fromEntries(state.asset.resources.map((r) => [r.id, { mediaType: r.mediaType, size: r.size, digest: r.digest }])),
  };
  return {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: state.id,
    controller: state.author.did,
    ...(state.asset.aliases.length > 0 ? { alsoKnownAs: state.asset.aliases } : {}),
    service: [service],
  };
}

/** The extension for `resolveDidVh`, so a generic did:vh resolver can derive the document. */
export function originalsExtension(authors: Iterable<AuthorHistory>): DidVhExtension {
  return { ...originalsRules(authors), methods: { [ORIGINALS_METHOD]: ORIGINALS_1_0 }, deriveDocument };
}
