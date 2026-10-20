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
import type { DataIntegrityProof } from "../crypto/index.js";
import { fail } from "../errors.js";
import { isJsonObject, type JsonObject } from "../json/index.js";
import type { LogEntry, Specialisation, VerifiedEntry, VersionRules } from "../log/index.js";
import type { DidVhExtension } from "../didvh/index.js";
import { parseDidWebvh } from "../webvh/index.js";
import { authorKey, authorMethod, namedVersion, versionNumberOf, type AuthorHistory } from "./author.js";
import { ORIGINALS_METHOD, checkAuthorRef, checkEditorChange, checkEditorRef, checkEntryState, resourceIdsThrough, type AuthorRef, type EntryState } from "./state.js";

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
 * The key one signer identity is known by for P5.8's per-identity order: a
 * did:webvh's SCID, which every location it moves to keeps (P5.14); any other
 * DID itself.
 */
export function identityKey(did: string): string {
  if (did.startsWith("did:webvh:")) {
    try {
      return `did:webvh:${parseDidWebvh(did).scid}`;
    } catch {
      return did;
    }
  }
  return did;
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
  const out = new Map([[identityKey(state.author.did), state.author.versionId]]);
  if (state.editor) out.set(identityKey(state.editor.did), state.editor.versionId);
  return out;
}

/**
 * The specialisation's rules, given the verified histories of the signer DIDs
 * in evidence: the author's and each editor's, by identity DID (P5.14).
 *
 * An author entry is authorized by the author DID's key at the version it
 * names (P5.3, P5.9). Editors are VH-Log PR 11's "Editors from a Controller"
 * [S25], through the engine's editor hook (`keys.editors`): the current
 * editors are the grants in `asset.editors`, which only an author entry
 * changes (P5.15, P5.16); an entry identifies its signer as an editor by its
 * `editor` reference; an editor entry is checked against the grants in its
 * parent's state (P5.17), and its key follows the author key rules against
 * the editor DID at the version its reference names (P5.18). The engine
 * enforces that an editor entry is not the genesis entry, sets no parameter,
 * leaves the grants alone and carries one proof by its editor; the profile's
 * `limit` is the grant's scope (`checkEditorEntry`, P5.16).
 * Bitcoin: an inscribed entry is also checked against the signer DID's state
 * at its inscription time (P9.15), in `assembleFromBitcoin` through the same
 * `signerOf`.
 */
export function originalsRules(authors: Iterable<AuthorHistory>): Omit<Specialisation, "versions" | "versionParameter"> {
  const byDid = histories(authors);
  const named = new WeakMap<LogEntry, Named>();
  // P4.1: every resourceID used through an entry, so none is used again, even after removal.
  const usedIds = new WeakMap<LogEntry, ReadonlySet<string>>();
  const usedThrough = (history: readonly VerifiedEntry[]): ReadonlySet<string> => {
    const last = history[history.length - 1];
    if (!last) return new Set();
    const known = usedIds.get(last.entry);
    if (known) return known;
    let used = new Set<string>();
    for (const v of history) used = resourceIdsThrough((v.entry.state as unknown as EntryState).asset, used);
    return used;
  };

  /** The key `signer` authorizes for `proof` at the version it names: the author's, or an editor's (P5.3, P5.18). */
  const signerKey = (entry: LogEntry, previous: VerifiedEntry | undefined, proof: DataIntegrityProof, role: "author" | "editor"): Promise<string> => {
    const ref = checkAuthorRef(entry.state.author);
    if (previous) {
      const genesisAuthor = (previous.entry.state.author as JsonObject | undefined)?.did;
      if (ref.did !== genesisAuthor) fail("invalid-evidence", "AUTHOR_DID_CHANGED", "the author DID is fixed at genesis (P5.8)");
    }
    authorMethod(ref.did);
    const editor = role === "editor";
    const signer: AuthorRef = editor ? checkEditorRef(entry.state.editor) : ref;
    if (proof.verificationMethod !== signer.verificationMethod) {
      fail("author-binding", editor ? "SIGNER_VM_MISMATCH" : "AUTHOR_VM_MISMATCH", `the proof's verificationMethod must be the ${role} verification method the entry names (P5.2)`);
    }
    const history = byDid.get(signer.did);
    if (!history) {
      if (editor) fail("incomplete-evidence", "EDITOR_HISTORY_MISSING", `no verified history for editor DID ${signer.did} (P7.1, P5.6)`, { did: signer.did, role: "editor" });
      fail("incomplete-evidence", "AUTHOR_HISTORY_MISSING", `no verified history for author DID ${ref.did}`, { did: ref.did, role: "author" });
    }
    // P5.8, P5.18: per signer identity, never older than the version its own most recent earlier
    // entry named, ordered by the signer DID's own history: versionId number, or chain order
    // for did:btco (P5.13). Keyed by identity, so a did:webvh named at another location is the
    // same signer (P5.14).
    const through = namedThrough(named, previous);
    const identity = identityKey(signer.did);
    const before = through.get(identity);
    const order = (id: string) => history.versions.find((v) => v.versionId === id)?.versionNumber ?? (history.method === "did:btco" ? NaN : versionNumberOf(id));
    if (before !== undefined && order(signer.versionId) < order(before)) {
      fail("invalid-evidence", editor ? "SIGNER_VERSION_REGRESSED" : "AUTHOR_VERSION_REGRESSED", `an entry may not name an older ${role} DID version than the signer's previous entry (P5.8)`);
    }
    const version = namedVersion(history, signer);
    // P6.5, P5.3: a deactivated DID version authorizes nothing, whoever signs (P5.18 for editors).
    if (version.deactivated) {
      fail("deactivated", "SIGNER_VERSION_DEACTIVATED", `${signer.did} is deactivated at version ${signer.versionId}; an entry cannot name it (P6.5, P5.18)`, { did: signer.did, role });
    }
    const key = authorKey(version, signer);
    named.set(entry, new Map([...through, [identity, signer.versionId]]));
    return Promise.resolve(key);
  };

  return {
    name: "originals",
    versionTime: { fractionalDigits: 3 },
    maxProofs: 1,
    keys: {
      kind: "controller",
      authorize: ({ entry, previous, proof }) => signerKey(entry, previous, proof, "author"),
      // VH-Log PR 11, "Editors from a Controller" [S25]: the grants are the record of editors (P5.15-P5.18).
      editors: {
        editorOf: (entry) => {
          if (entry.state.editor === undefined) return undefined;
          const editor = checkEditorRef(entry.state.editor);
          authorMethod(editor.did);
          return editor.did;
        },
        recordOf: (entry) => (isJsonObject(entry.state.asset) ? entry.state.asset.editors : undefined),
        // P5.16, P5.17: the grant in the parent's state decides before any editor evidence is looked up,
        // so an editor with no grant is rejected, never reported as missing evidence (C12-05).
        lists: (record, editor) => Array.isArray(record) && record.some((g) => isJsonObject(g) && g.did === editor),
        authorize: ({ entry, previous, proof }) => signerKey(entry, previous, proof, "editor"),
        // P5.16: only the name, metadata and resource descriptors the grant allows change, and no resource
        // is added or removed; the author reference is the parent's and the operation is update. Judged
        // before the state's other rules, so a change outside the grant is reported as that.
        limit: ({ entry, previous, scid, index }) => {
          checkEditorChange(entry.state, {
            scid, index, previous: previous?.entry.state as unknown as EntryState | undefined, deactivatedParameter: entry.parameters.deactivated === true,
          });
        },
      },
    },
    validateEntry: ({ entry, previous, history, scid, index, active }) => {
      if (Object.keys(active.witness).length > 0) {
        fail("invalid-evidence", "WITNESS_NOT_PERMITTED", "Originals asset logs do not use witnesses; anchor on Bitcoin for proven ordering (owner decision Q14)");
      }
      const used = usedThrough(history);
      const state = checkEntryState(entry.state, {
        scid,
        index,
        previous: previous?.entry.state as unknown as EntryState | undefined,
        deactivatedParameter: entry.parameters.deactivated === true,
        usedResourceIds: used,
        // The editor rules run through the engine's editor hook (`keys.editors.limit`).
        editorRules: false,
      });
      usedIds.set(entry, resourceIdsThrough(state.asset, used));
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
