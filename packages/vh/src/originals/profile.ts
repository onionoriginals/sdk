/**
 * The `originals:1.0` did:vh extension (did:vh PR 3) as a VH-Log
 * specialisation. Keys come from the author DID (VH-Log PR 11): one proof per
 * entry (P5.2), by the author key the entry names (P5.3). versionTime carries
 * milliseconds (VH-Log PR 8; owner decision Q8).
 *
 * No witnesses (P9.8, P9.9; owner decision Q14): an asset log never sets the
 * VH witness parameter to anything but `{}`. Unanchored Originals have claimed
 * ordering only; Bitcoin anchoring gives proven ordering and a single history.
 * Author DIDs keep their own method's witnesses, which this does not affect.
 */
import { fail } from "../errors.js";
import type { JsonObject } from "../json/index.js";
import type { LogEntry, Specialisation, VerifiedEntry, VersionRules } from "../log/index.js";
import type { DidVhExtension } from "../didvh/index.js";
import { authorKey, authorMethod, namedVersion, versionNumberOf, type AuthorHistory } from "./author.js";
import { ORIGINALS_METHOD, checkAuthorRef, checkEditorRef, checkEntryState, type AuthorRef, type EntryState } from "./state.js";

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

/**
 * The versionId each signer identity named in its most recent entry, through
 * an entry, for P5.8's per-identity order (P5.18). Kept per verified entry
 * object, so copies verified with the same rules never share it.
 */
type Named = ReadonlyMap<string, string>;

function namedThrough(record: WeakMap<LogEntry, Named>, previous: VerifiedEntry | undefined): Named {
  if (!previous) return new Map();
  const known = record.get(previous.entry);
  if (known) return known;
  // A predecessor verified elsewhere: its own signer and author references are what it names.
  const state = previous.entry.state as unknown as EntryState;
  const out = new Map([[state.author.did, state.author.versionId]]);
  if (state.editor) out.set(state.editor.did, state.editor.versionId);
  return out;
}

/**
 * The specialisation's rules, given the verified histories of the signer DIDs
 * in evidence: the author's and each editor's, by identity DID (P5.14).
 *
 * An author entry is authorized by the author DID's key at the version it
 * names (P5.3, P5.9); an editor entry by the editor DID's key at the version
 * its editor reference names, and only for the change its grant in the
 * parent's state allows, which `checkEntryState` enforces (P5.16). Editor
 * keys follow the author key rules against the editor DID (P5.18).
 * Bitcoin: for an inscribed entry, P9.15 checks the signer DID's state at the
 * inscription time; that is the anchoring branch's (plan 011 PR 9), which
 * hooks in where `namedVersion` is resolved below.
 */
export function originalsRules(authors: Iterable<AuthorHistory>): Omit<Specialisation, "versions" | "versionParameter"> {
  const byDid = histories(authors);
  const named = new WeakMap<LogEntry, Named>();
  return {
    name: "originals",
    versionTime: { fractionalDigits: 3 },
    maxProofs: 1,
    keys: {
      kind: "controller",
      authorize: ({ entry, previous, proof }) => {
        const ref = checkAuthorRef(entry.state.author);
        const editor = entry.state.editor === undefined ? undefined : checkEditorRef(entry.state.editor);
        if (previous) {
          const genesisAuthor = (previous.entry.state.author as JsonObject | undefined)?.did;
          if (ref.did !== genesisAuthor) fail("invalid-evidence", "AUTHOR_DID_CHANGED", "the author DID is fixed at genesis (P5.8)");
        }
        authorMethod(ref.did);
        const signer: AuthorRef = editor ?? ref;
        if (editor) authorMethod(editor.did);
        if (proof.verificationMethod !== signer.verificationMethod) {
          fail("author-binding", editor ? "SIGNER_VM_MISMATCH" : "AUTHOR_VM_MISMATCH", `the proof's verificationMethod must be the ${editor ? "editor" : "author"} verification method the entry names (P5.2)`);
        }
        const history = byDid.get(signer.did);
        if (!history) {
          if (editor) fail("incomplete-evidence", "EDITOR_HISTORY_MISSING", `no verified history for editor DID ${editor.did} (P7.1, P5.6)`, { did: editor.did, role: "editor" });
          fail("incomplete-evidence", "AUTHOR_HISTORY_MISSING", `no verified history for author DID ${ref.did}`, { did: ref.did, role: "author" });
        }
        // P5.8, P5.18: per signer identity, never older than the version its own most recent earlier entry named.
        const through = namedThrough(named, previous);
        const before = through.get(signer.did);
        if (before !== undefined && versionNumberOf(signer.versionId) < versionNumberOf(before)) {
          fail("invalid-evidence", editor ? "SIGNER_VERSION_REGRESSED" : "AUTHOR_VERSION_REGRESSED", `an entry may not name an older ${editor ? "editor" : "author"} DID version than the signer's previous entry (P5.8)`);
        }
        const key = authorKey(namedVersion(history, signer), signer);
        named.set(entry, new Map([...through, [signer.did, signer.versionId]]));
        return Promise.resolve(key);
      },
    },
    validateEntry: ({ entry, previous, scid, index, active }) => {
      if (Object.keys(active.witness).length > 0) {
        fail("invalid-evidence", "WITNESS_NOT_PERMITTED", "Originals asset logs do not use witnesses; anchor on Bitcoin for proven ordering (owner decision Q14)");
      }
      checkEntryState(entry.state, {
        scid,
        index,
        previous: previous?.entry.state as unknown as EntryState | undefined,
        deactivatedParameter: entry.parameters.deactivated === true,
      });
      // P5.16: an editor entry's parameters are empty; only an author entry may change any parameter.
      if (entry.state.editor !== undefined && Object.keys(entry.parameters).length > 0) {
        fail("outside-grant", "EDITOR_PARAMETERS", "an editor entry's parameters must be empty (P5.16)");
      }
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
