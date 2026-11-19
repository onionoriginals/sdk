/**
 * A code workspace (plan 049 phases 1–3, profile 0.2): a repo Original, its
 * branch Originals and their objects, over any `OriginalsStore` and
 * `ObjectStore`. Browser-safe; `@originals/code/fs` opens one on disk and
 * `@originals/code/git` supplies commits from a git repository.
 *
 * Every Original is written through the SDK: the repo and release Originals
 * with `create`/`edit` and, for signers not all present, the draft flow
 * (`proposeRepo` → `cosignRepo` → `commitRepo`; P5.19–P5.22); a branch
 * Original by building its entries with the vh builders, signing each once,
 * and importing the resulting log, which the SDK verifies whole and commits
 * durably (P6.2). No `originals:1.0` rule is relaxed anywhere.
 *
 * Profile 0.2 (PROVISIONAL, plan 050 §5 step 3): the repo Original is a set
 * Original whose members are the delegates (K5); a branch Original is a child
 * of the repo pinning the newest repo version its writer holds (K4); path
 * grants are `paths`-scoped grants in the repo's `editors`, inherited by every
 * branch (K7); the release Original is a set Original with the repo's members
 * and threshold and a child of the repo (K15, K17).
 */
import { parseLog, serializeLog, type LogEntry } from "@originals/vh/log";
import { ORIGINALS_LIMITS, codeTreePathView, signerOf, type AuthorDidEvidence, type AuthorRef, type EditorGrant, type EntryState } from "@originals/vh/originals";
import { OriginalsSDK, keySigner, writeEvidence, type Draft, type EntrySummary, type OriginalsStore } from "@originals/sdk/originals";
import type { DataIntegrityProof } from "@originals/vh/crypto";
import { appendCommits, branchChain, metadataOf, type MirrorCommit } from "./branch.js";
import { readBundle, writeBundle } from "./bundle.js";
import { verifyRepository, type RepositoryReport } from "./verify.js";
import {
  RELEASE_MEDIA_TYPE,
  REPO_MEDIA_TYPE,
  checkRef,
  checkTag,
  decodeReleaseManifest,
  decodeRepoDocument,
  encodeReleaseManifest,
  encodeRepoDocument,
  releasesMetadata,
  repoMetadata,
  type ReleaseManifest,
  type RepoDocument,
} from "./documents.js";
import { codeError, requireSoleAuthor, soleAuthorDid } from "./errors.js";
import { covers, pathGrant } from "./grants.js";
import { diffTrees, readTree } from "./objects.js";
import { identityEvidence, identityRef, identitySigner, SIGNING_FRAGMENT, type LocalIdentity } from "./identity.js";
import { sourceOf, type ObjectStore } from "./store.js";

/** Where a mirror's commits come from (`@originals/code/git` reads a git repository). */
export interface CommitSource {
  /** The ref's first-parent chain, oldest first (`git rev-list --first-parent --reverse`). */
  firstParent(ref: string): Promise<string[]>;
  /**
   * Convert one commit: store its trees and blobs in `objects` and return its
   * ids and root tree. With `commitObject`, also store the raw git commit
   * object and return its digest (K12).
   */
  convert(commit: string, objects: ObjectStore, options?: { commitObject?: boolean }): Promise<MirrorCommit>;
}

export interface CodeWorkspaceOptions {
  originals: OriginalsStore;
  objects: ObjectStore;
  /** Public identities (DID and log) of every signer this workspace verifies. */
  identities?: Array<Pick<LocalIdentity, "did" | "log">>;
  clock?: () => number;
  /** Entries per branch segment: `ORIGINALS_LIMITS.entries` (P7.7); lower only to test segmenting (K13). */
  segmentEntries?: number;
}

export interface MirrorResult {
  branch: string;
  created: boolean;
  appended: number;
  head: { commit: string; versionId: string };
  /**
   * Whether the appended entries carry raw commit objects (K12, O3):
   * `included`, `omitted-private` (the source is marked private and the
   * caller did not opt in) or `omitted` (the caller opted out).
   */
  commitObjects: "included" | "omitted-private" | "omitted";
  /** Segments of the branch after this mirror (K13, O1); the branch did is the last one's. */
  segments: number;
  /** Segments this mirror started, oldest first. */
  newSegments: string[];
  /** A contributor's own branch (K14, O7): never listed, never votes. */
  contribution?: boolean;
  /** Set when the branch is new and the signer is not the repo's author, who must list it (K5). */
  needsListing?: boolean;
}

const stateOf = (e: LogEntry) => e.state as unknown as EntryState;
const sortDids = (dids: Iterable<string>) => [...new Set(dids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The repo Original's state the code profile reads (K5, K7): the repo
 * document, the signer set's threshold (who changes the repo, P5.20) and the
 * editor grants every branch inherits (P5.24). The delegates are the
 * document's `delegates`, which equal the signer set's members.
 */
export interface RepoState {
  document: RepoDocument;
  /** Members of the signer set that sign each repo change (P5.20). */
  threshold: number;
  /** The repo's editor grants: path grants are those with a `paths` scope (K7). */
  editors: EditorGrant[];
}

/** Who signs: one identity or several (a set Original's author entry, P5.19). */
export type Signers = LocalIdentity | readonly LocalIdentity[];

const base64 = {
  encode(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  },
  decode(text: string): Uint8Array {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  },
};

/** PROVISIONAL (K17): a proposal file, an unsigned or partly signed draft for a repo or release change. */
export const PROPOSAL_FORMAT = "originals-code-proposal/0.1";

/** A draft as a JSON file, so members who are not together cosign it in turn (P5.22). */
export function serializeProposal(draft: Draft): string {
  return `${JSON.stringify(
    {
      format: PROPOSAL_FORMAT,
      original: draft.original,
      parent: draft.parent,
      entry: draft.entry,
      summary: draft.summary,
      display: draft.display,
      bytes: Object.fromEntries([...draft.bytes].map(([d, b]) => [d, base64.encode(b)])),
      proofs: draft.proofs ?? [],
    },
    null,
    2,
  )}\n`;
}

/** Read a proposal file back into a draft. The SDK checks it again before anyone signs or anything is committed. */
export function parseProposal(text: string): Draft {
  const v = JSON.parse(text) as Record<string, unknown>;
  if (v?.format !== PROPOSAL_FORMAT || typeof v.original !== "string" || typeof v.parent !== "string" || typeof v.entry !== "object" || v.entry === null || typeof v.display !== "string" || !Array.isArray(v.proofs)) {
    codeError("invalid-evidence", "PROPOSAL_FILE", `not an ${PROPOSAL_FORMAT} file`);
  }
  const bytes = new Map<string, Uint8Array>();
  for (const [d, b] of Object.entries((v.bytes ?? {}) as Record<string, unknown>)) {
    if (typeof b !== "string") codeError("invalid-evidence", "PROPOSAL_FILE", "proposal bytes are base64");
    bytes.set(d, base64.decode(b));
  }
  return {
    kind: "draft",
    signed: false,
    original: v.original,
    parent: v.parent,
    entry: v.entry as Draft["entry"],
    summary: v.summary as EntrySummary,
    display: v.display,
    bytes,
    proofs: v.proofs as DataIntegrityProof[],
  };
}

export class CodeWorkspace {
  readonly sdk: OriginalsSDK;
  private readonly identities = new Map<string, Pick<LocalIdentity, "did" | "log">>();

  private constructor(
    readonly originals: OriginalsStore,
    readonly objects: ObjectStore,
    private readonly clock: () => number,
    private readonly maxEntries: number,
  ) {
    this.sdk = OriginalsSDK.create({
      store: originals,
      clock,
      authors: async (did) => {
        const id = this.identities.get(did);
        if (id) return identityEvidence(id);
        return originals.getAuthorEvidence(did);
      },
    });
  }

  static create(options: CodeWorkspaceOptions): CodeWorkspace {
    const ws = new CodeWorkspace(options.originals, options.objects, options.clock ?? Date.now, Math.min(options.segmentEntries ?? ORIGINALS_LIMITS.entries, ORIGINALS_LIMITS.entries));
    for (const id of options.identities ?? []) ws.addIdentity(id);
    return ws;
  }

  /** Register a signer's public identity (its DID log), so entries it signs verify. */
  addIdentity(identity: Pick<LocalIdentity, "did" | "log">): void {
    this.identities.set(identity.did, { did: identity.did, log: identity.log });
  }

  private signer(identity: LocalIdentity) {
    this.addIdentity(identity);
    return keySigner({ keyType: "Ed25519", secretKey: identity.signingSecret, verificationMethod: `${identity.did}#${SIGNING_FRAGMENT}` });
  }

  private signers(signers: Signers): LocalIdentity[] {
    const list = Array.isArray(signers) ? [...(signers as readonly LocalIdentity[])] : [signers as LocalIdentity];
    if (list.length === 0) codeError("unauthorized-key", "SIGNER_REQUIRED", "at least one signer is needed");
    return list;
  }

  /** The author reference for `did` at its latest version this workspace holds (P5.1). */
  private refOf(did: string): AuthorRef {
    const id = this.identities.get(did);
    if (!id) return codeError("incomplete-evidence", "IDENTITY_MISSING", `no DID history for ${did} in this workspace: add its public identity`);
    return identityRef(id);
  }

  /**
   * Create the repo Original (K5): a set Original whose members are the
   * delegates, `identity` and each of `delegates`, with `threshold` of them
   * (default 1) signing each later change (P5.19, P5.20). Every member signs
   * the genesis entry, so nobody becomes a delegate without signing (P5.19).
   */
  async initRepo(input: { name: string; identity: LocalIdentity; delegates?: readonly LocalIdentity[]; threshold?: number; document?: Partial<Omit<RepoDocument, "delegates">> }): Promise<string> {
    const members = [input.identity, ...(input.delegates ?? [])];
    const dids = sortDids(members.map((m) => m.did));
    const document: RepoDocument = { refs: {}, ...input.document, delegates: dids };
    const created = await this.sdk.create({
      name: input.name,
      metadata: repoMetadata(),
      resource: { mediaType: REPO_MEDIA_TYPE, bytes: encodeRepoDocument(document) },
      authors: { threshold: input.threshold ?? 1, members: members.map((m) => identityRef(m)) },
      signers: members.map((m) => this.signer(m)),
    });
    if (created.kind !== "original") return codeError("invalid-evidence", "REPO_NOT_CREATED", "the repo Original was not created");
    return created.original.did;
  }

  /** The repo document at the repo's verified head, or at `checkpoint`. */
  async repoDocument(repo: string, checkpoint?: string): Promise<{ versionId: string; document: RepoDocument }> {
    const { versionId, document } = await this.repoState(repo, checkpoint);
    return { versionId, document };
  }

  /** The repo state at the repo's verified head, or at `checkpoint`: document, threshold and grants (K5, K7). */
  async repoState(repo: string, checkpoint?: string): Promise<RepoState & { versionId: string }> {
    const view = await this.sdk.get(repo, checkpoint ? { checkpoint } : {});
    const bytes = await this.sdk.resourceBytes(view.state.resource.digest);
    if (!bytes) return codeError("unavailable-bytes", "REPO_DOCUMENT_MISSING", "the repo document's bytes are not held");
    if (!view.state.authors) return codeError("invalid-evidence", "REPO_NOT_SET", "a repo Original is a set Original whose members are its delegates (K5)");
    return { versionId: view.checkpoint, document: decodeRepoDocument(bytes), threshold: view.state.authors.threshold, editors: [...(view.state.editors ?? [])] };
  }

  /**
   * Prepare a repo change for its signers (K5; P5.20, P5.21): `signers` are
   * the DIDs of the members who will sign it, at least the current
   * threshold, plus every member the change adds. Nothing is signed: each
   * signer cosigns the draft (`cosignRepo`, or the CLI's `repo cosign`), and
   * `commitRepo` commits it once all have.
   */
  async proposeRepo(repo: string, signers: readonly string[], change: (state: RepoState) => RepoState): Promise<Draft> {
    const current = await this.repoState(repo);
    const next = change(structuredClone({ document: current.document, threshold: current.threshold, editors: current.editors }));
    const delegates = sortDids(next.document.delegates);
    const document: RepoDocument = { ...next.document, delegates };
    const added = delegates.filter((d) => !current.document.delegates.includes(d));
    // P5.20: every added member signs too; refused here, before anyone is asked.
    const missing = added.filter((d) => !signers.includes(d));
    if (missing.length > 0) codeError("unauthorized-key", "AUTHORS_MEMBER_NOT_SIGNED", `every delegate the change adds signs it (P5.20): ${missing.join(", ")}`);
    const authorsChanged = delegates.join("\n") !== current.document.delegates.join("\n") || next.threshold !== current.threshold;
    const editorsChanged = JSON.stringify(next.editors) !== JSON.stringify(current.editors);
    const bytes = encodeRepoDocument(document);
    return this.sdk.prepareEdit(repo, {
      parent: current.versionId,
      resource: { bytes, mediaType: REPO_MEDIA_TYPE },
      author: sortDids(signers).map((d) => this.refOf(d)),
      ...(authorsChanged ? { authors: { threshold: next.threshold, dids: delegates } } : {}),
      ...(editorsChanged ? { editors: next.editors.length > 0 ? next.editors : null } : {}),
    });
  }

  /** Add `identity`'s signature to a repo or release draft (P5.22); the draft must name it. */
  async cosignRepo(draft: Draft, identity: LocalIdentity): Promise<Draft> {
    return this.sdk.cosign(draft, this.signer(identity));
  }

  /** Commit a draft every signer it names has signed (P5.19, P6.2); returns the new checkpoint. */
  async commitRepo(draft: Draft): Promise<string> {
    return (await this.sdk.commitDraft(draft)).original.checkpoint;
  }

  /** Propose, sign with each of `signers` and commit a repo change: every signer present (K5). */
  async changeRepo(repo: string, signers: Signers, change: (state: RepoState) => RepoState): Promise<string> {
    const list = this.signers(signers);
    for (const id of list) this.addIdentity(id);
    let draft = await this.proposeRepo(repo, list.map((i) => i.did), change);
    for (const id of list) draft = await this.cosignRepo(draft, id);
    return this.commitRepo(draft);
  }

  /** Change the repo document (and with its `delegates`, the signer set), signed by `signers` meeting the threshold (K5, P5.20). */
  async updateRepo(repo: string, signers: Signers, change: (document: RepoDocument) => RepoDocument, options: { threshold?: number } = {}): Promise<string> {
    return this.changeRepo(repo, signers, (s) => ({ ...s, document: change(s.document), ...(options.threshold !== undefined ? { threshold: options.threshold } : {}) }));
  }

  /** List `branch` as `delegate`'s branch for `ref` (a repo change, K5). */
  async listBranch(repo: string, signers: Signers, input: { ref: string; delegate: string; branch: string; threshold?: number }): Promise<string> {
    return this.updateRepo(repo, signers, (doc) => {
      const rule = doc.refs[input.ref] ?? { threshold: input.threshold ?? 1, branches: {} };
      rule.branches[input.delegate] = input.branch;
      if (input.threshold !== undefined) rule.threshold = input.threshold;
      doc.refs[input.ref] = rule;
      return doc;
    });
  }

  /**
   * Grant `did` the paths `paths` in every branch (K7): a `paths`-scoped
   * grant in the repo's `editors`, which each branch inherits at its pin
   * (P5.24, P5.28). Null revokes it; entries made under it stay valid and are
   * reported historically authorized only (P5.26). A repo change (K5).
   */
  async grantPaths(repo: string, signers: Signers, did: string, paths: readonly string[] | null): Promise<string> {
    return this.changeRepo(repo, signers, (s) => {
      const editors = s.editors.filter((g) => g.did !== did);
      if (paths !== null) editors.push(pathGrant(did, paths));
      editors.sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0));
      return { ...s, editors };
    });
  }

  private async entries(did: string): Promise<LogEntry[]> {
    const stored = await this.originals.get(did);
    return stored ? (parseLog(stored.log) as unknown as LogEntry[]) : [];
  }

  /**
   * A branch's segments, oldest first, ending with `did` (K13, O1): each
   * segment's genesis names the previous one. Every segment must be held.
   */
  async segments(did: string): Promise<LogEntry[][]> {
    const out: LogEntry[][] = [];
    const seen = new Set<string>();
    for (let at: string | undefined = did; at; ) {
      if (seen.has(at)) codeError("invalid-evidence", "SEGMENT_CYCLE", `segment ${at} is its own predecessor`);
      seen.add(at);
      const log = await this.entries(at);
      if (log.length === 0) {
        if (at === did) return [];
        codeError("incomplete-evidence", "BRANCH_NOT_HELD", `segment ${at} is not in this workspace`);
      }
      out.unshift(log);
      at = metadataOf(log[0]).previous?.did;
    }
    return out;
  }

  /**
   * Mirror a ref's first-parent chain into a branch Original: one entry per
   * commit after the branch's head (phase 1). `branch` names an existing
   * branch to write as its editor (phase 3); otherwise the branch is the
   * signer's own for this ref, created if absent. A first-parent chain that
   * no longer extends the branch (a force-push) is refused as
   * `MIRROR_DIVERGED`: never a silent rebase (P4.5).
   */
  async mirror(input: {
    repo: string;
    ref: string;
    identity: LocalIdentity;
    source: CommitSource;
    branch?: string;
    limit?: number;
    /**
     * Mirror raw commit objects (K12, plan 049 O3). Default: yes for a public
     * source; for a source marked `private`, only with `commits: true`, since a
     * commit object carries author and committer names and emails, and
     * Originals give no confidentiality (P8.2).
     */
    commits?: boolean;
    /** The source is private: commit objects need an explicit `commits: true`. */
    private?: boolean;
    /**
     * Mirror as a contributor (K14, plan 049 O7): into the signer's own
     * branch Original for this ref, `branch` if given (its newest segment),
     * never listed in the repo document. It names the repo and is verified
     * as a contribution; it never votes for a canonical head.
     */
    contribute?: boolean;
  }): Promise<MirrorResult> {
    const { repo, ref, identity } = input;
    this.addIdentity(identity);
    const repoDoc = await this.repoState(repo);
    const own = input.contribute ? undefined : repoDoc.document.refs[ref]?.branches[identity.did];
    const branch = input.branch ?? own;
    if (input.contribute && branch && Object.values(repoDoc.document.refs).some((r) => Object.values(r.branches).includes(branch))) {
      codeError("invalid-evidence", "CONTRIBUTION_LISTED", `${branch} is a delegate's listed branch; a contribution is the contributor's own branch (K14)`);
    }
    const segments = branch ? await this.segments(branch) : [];
    const log = segments.at(-1) ?? [];
    if (branch && log.length === 0) codeError("incomplete-evidence", "BRANCH_NOT_HELD", `${branch} is not in this workspace`);
    const role: "author" | "editor" = log.length === 0 || requireSoleAuthor(stateOf(segments[0][0])) === identity.did ? "author" : "editor";
    // K7: an editor writes under the path grant the repo's state at the pin holds for it (P5.24).
    const inherited = role === "editor" ? repoDoc.editors.find((g) => g.did === identity.did) : undefined;
    if (role === "editor" && !inherited) codeError("outside-grant", "NO_PATH_GRANT", `${identity.did} has no path grant in repo version ${repoDoc.versionId} (K7, P5.24)`);

    let commits = await input.source.firstParent(ref);
    const chain = segments.flatMap((seg) => branchChain(seg)).map((c) => c.commit);
    if (chain.length > 0) {
      const same = chain.length <= commits.length && chain.every((c, i) => commits[i] === c);
      if (!same) codeError("stale-parent", "MIRROR_DIVERGED", `${ref} no longer extends the branch's history at ${chain[chain.length - 1]}; nothing is rebased (P4.5)`);
      commits = commits.slice(chain.length);
    }
    if (input.limit !== undefined) commits = commits.slice(0, input.limit);
    const commitObjects: MirrorResult["commitObjects"] = input.commits === false ? "omitted" : input.private && input.commits !== true ? "omitted-private" : "included";
    const converted: MirrorCommit[] = [];
    for (const c of commits) converted.push(await input.source.convert(c, this.objects, { commitObject: commitObjects === "included" }));

    const check = inherited ? this.pathCheck(inherited) : undefined;
    // O1, K13: fill the current segment up to the entry limit (P7.7), then start the next one.
    let current = log;
    let currentDid: string | undefined = branch;
    let remaining = converted;
    let appended = 0;
    const created: string[] = [];
    while (remaining.length > 0) {
      let previous: { did: string; versionId: string } | undefined;
      let prior: { root: string; versionTime: string } | undefined;
      if (current.length >= this.maxEntries) {
        if (role !== "author") codeError("outside-grant", "SEGMENT_AUTHOR_ONLY", `${currentDid} is full (${this.maxEntries} entries); only the branch's author starts its next segment (K13)`);
        const last = current[current.length - 1];
        if (!currentDid) return codeError("invalid-evidence", "SEGMENT_PREVIOUS", "a full segment has no did");
        previous = { did: currentDid, versionId: last.versionId };
        prior = { root: stateOf(last).asset.resource.digest, versionTime: last.versionTime };
        current = [];
        currentDid = undefined;
      }
      const take = remaining.slice(0, this.maxEntries - current.length);
      const fresh = await appendCommits({
        log: current,
        commits: take,
        repo,
        ref,
        pin: repoDoc.versionId,
        signer: { role, ref: identityRef(identity), sign: identitySigner(identity) },
        ...(inherited ? { inherited } : {}),
        clock: this.clock,
        maxEntries: this.maxEntries,
        ...(previous ? { previous, prior: prior! } : {}),
        ...(check ? { check } : {}),
      });
      const all = [...current, ...fresh];
      if (role === "editor") await this.holdScopeObjects(current.at(-1), fresh);
      await this.importLog(all, currentDid);
      if (!currentDid) {
        currentDid = all[0].state.id as string;
        created.push(currentDid);
      }
      current = all;
      remaining = remaining.slice(take.length);
      appended += fresh.length;
    }
    if (!currentDid) return codeError("invalid-evidence", "MIRROR_EMPTY", `${ref} has no commits to start a branch with`);
    const last = current[current.length - 1];
    const result: MirrorResult = {
      branch: currentDid,
      created: !branch,
      appended,
      head: { commit: branchChain([last])[0].commit, versionId: last.versionId },
      commitObjects,
      segments: segments.length + created.length,
      newSegments: created,
    };
    if (input.contribute) {
      if (role !== "author") codeError("outside-grant", "CONTRIBUTION_NOT_OWN", "a contribution is written by its own author (K14)");
      result.contribution = true;
    } else if (currentDid !== branch) {
      // K5: a delegate lists its own new branch (segment) when it alone meets the repo's threshold;
      // otherwise the listing is a repo change the delegates propose and cosign.
      if (repoDoc.document.delegates.includes(identity.did) && repoDoc.threshold === 1) await this.listBranch(repo, identity, { ref, delegate: identity.did, branch: currentDid });
      else result.needsListing = true;
    }
    return result;
  }

  /**
   * Take a repo bundle into this workspace (K14: how a contributor starts):
   * verify it offline first, refuse it unless the repo Original verifies,
   * then import each Original through the SDK (which verifies it again and
   * commits it durably, P6.2) and store every object (checked by digest,
   * P4.3). Returns the repo and the contributions the bundle carried.
   */
  async importBundle(bundle: Uint8Array): Promise<{ repo: string; report: RepositoryReport; contributions: string[] }> {
    const report = await verifyRepository(bundle);
    if (report.repo.code?.history.status !== "valid" || !report.validAsOf.repo) {
      codeError("invalid-evidence", "BUNDLE_REPO_INVALID", "the bundle's repo Original does not verify; nothing is imported");
    }
    const contents = await readBundle(bundle);
    for (const p of contents.packages) {
      const result = report.repo.original === p.original ? report.repo : report.branches.find((b) => b.original === p.original);
      if (!result?.report?.validAsOf) continue; // only what verified
      await this.sdk.import(p.bytes, { original: p.original });
    }
    for (const [digest, bytes] of contents.objects) await this.objects.put(digest, bytes);
    return { repo: report.repo.original, report, contributions: report.contributions.map((c) => c.original) };
  }

  /**
   * Record a release (K15) in the repo's release Original, creating it (and
   * naming it in the repo document) on the first release. The release
   * Original (K17) is a set Original with the repo's members and threshold
   * and a child of the repo: each entry pins the newest repo version held and
   * carries the repo's signer set at that pin, so a delegate change reaches
   * releases with the next release (P5.20, P5.24). `signers` meet the release
   * set's threshold; creating it needs every member, who all sign a set
   * Original's genesis (P5.19).
   *
   * The canonical head of `ref` is computed now, by verifying this
   * workspace's own bundle offline, and recorded with the release. The
   * released commit is that head unless `commit` names another; either way it
   * must be in a listed, verified branch's chain, and the release names that
   * branch (its segment) and entry. A tag is released once.
   */
  async release(repo: string, signers: Signers, input: { tag: string; ref?: string; commit?: string }): Promise<{ releases: string; versionId: string; manifest: ReleaseManifest; created: boolean }> {
    const draft = await this.prepareRelease(repo, this.signers(signers).map((i) => i.did), input);
    let d = draft.draft;
    for (const id of this.signers(signers)) d = await this.cosignRepo(d, id);
    if (draft.created) {
      const did = (await this.sdk.commitDraft(d)).original.did;
      const view = await this.sdk.get(did);
      await this.updateRepo(repo, signers, (doc) => ({ ...doc, releases: did }));
      return { releases: did, versionId: view.checkpoint, manifest: draft.manifest, created: true };
    }
    const committed = await this.sdk.commitDraft(d);
    return { releases: committed.original.did, versionId: committed.original.checkpoint, manifest: draft.manifest, created: false };
  }

  /**
   * The unsigned release entry (K15, K17), for `release` or for members who
   * cosign it in turn. `signers` are the DIDs that will sign: every member to
   * create the release Original, otherwise at least its threshold.
   */
  async prepareRelease(repo: string, signers: readonly string[], input: { tag: string; ref?: string; commit?: string }): Promise<{ draft: Draft; manifest: ReleaseManifest; created: boolean }> {
    const ref = checkRef(input.ref ?? "refs/heads/main");
    const tag = checkTag(input.tag);
    const state = await this.repoState(repo);
    for (const s of signers) if (!state.document.delegates.includes(s)) codeError("outside-grant", "RELEASE_AUTHOR", `${s} is not a delegate; the repo's delegates sign releases (K15)`);
    // Trees and commit objects suffice for the canonical head; blobs are not needed to compute it.
    const report = await verifyRepository(await this.package(repo, { omitBlobs: true }));
    const canonical = report.canonical.find((c) => c.ref === ref);
    if (!canonical) return codeError("invalid-evidence", "RELEASE_REF", `${ref} is not a ref of this repo`);
    const commit = input.commit ?? canonical.head?.commit;
    if (!commit) return codeError("fork", "RELEASE_NO_HEAD", `${ref} has no agreed canonical head (${canonical.status}); name a commit to release`);
    const listed = canonical.delegates.map((d) => d.branch);
    const order = [...canonical.delegates.filter((d) => signers.includes(d.delegate)), ...canonical.delegates.filter((d) => !signers.includes(d.delegate))];
    let link: { original: string; versionId: string } | undefined;
    for (const d of order) {
      const b = report.branches.find((x) => x.original === d.branch);
      if (!b?.code || b.code.history.status !== "valid" || !b.report?.validAsOf || !listed.includes(b.original)) continue;
      link = b.code.chain.find((c) => c.commit === commit);
      if (link) break;
    }
    if (!link) return codeError("invalid-evidence", "RELEASE_NOT_IN_CHAIN", `${commit} is not in a listed, verified branch of ${ref}`);
    const manifest: ReleaseManifest = {
      tag,
      ref,
      commit,
      branch: link.original,
      versionId: link.versionId,
      canonical: { status: canonical.status, head: canonical.head?.commit ?? null, threshold: canonical.threshold, votes: canonical.head ? [...canonical.head.votes].sort() : [] },
    };
    const bytes = encodeReleaseManifest(manifest);
    const refs = sortDids(signers).map((d) => this.refOf(d));
    const set = { threshold: state.threshold, dids: state.document.delegates };
    if (state.document.releases) {
      const view = await this.sdk.get(state.document.releases);
      for (const v of view.resources) {
        const b = await this.sdk.resourceBytes(v.digest);
        if (b && decodeReleaseManifest(b).tag === tag) codeError("invalid-evidence", "RELEASE_TAG_EXISTS", `tag ${tag} is already released`);
      }
      // K17: the entry pins the newest repo version held, with the repo's signer set there.
      const same = view.state.authors && view.state.authors.threshold === set.threshold && view.state.authors.dids.join("\n") === set.dids.join("\n");
      const draft = await this.sdk.prepareEdit(state.document.releases, {
        parent: view.checkpoint,
        resource: { mediaType: RELEASE_MEDIA_TYPE, bytes },
        author: refs,
        pin: state.versionId,
        ...(same ? {} : { authors: set }),
      });
      return { draft, manifest, created: false };
    }
    const missing = set.dids.filter((d) => !signers.includes(d));
    if (missing.length > 0) codeError("unauthorized-key", "AUTHORS_MEMBER_NOT_SIGNED", `the first release creates the release Original, whose genesis every delegate signs (P5.19): ${missing.join(", ")} must sign too`);
    const repoName = (await this.sdk.get(repo)).state.name;
    const created = await this.sdk.create({
      name: `${repoName} releases`,
      metadata: releasesMetadata(repo),
      resource: { mediaType: RELEASE_MEDIA_TYPE, bytes },
      authors: { threshold: set.threshold, members: refs },
      parent: { did: repo, versionId: state.versionId },
    });
    if (created.kind !== "draft") return codeError("invalid-evidence", "RELEASES_NOT_CREATED", "the release Original's genesis was not prepared");
    return { draft: created.draft, manifest, created: true };
  }

  /** Among `branches` (newest segments), the one `author` writes for `ref`, if held (K14). */
  async findBranch(branches: readonly string[], author: string, ref: string): Promise<string | undefined> {
    for (const did of branches) {
      const log = await this.entries(did);
      if (log.length && soleAuthorDid(stateOf(log[0])) === author && metadataOf(log[0]).ref === ref) return did;
    }
    return undefined;
  }

  /**
   * Refuse, before signing, a change outside the editor's path grant (K7; as
   * the SDK refuses outside-grant, P5.28). A grant with no scope allows every
   * path; one of another scope type cannot be checked here, so nothing is
   * signed under it.
   */
  private pathCheck(grant: EditorGrant) {
    return async (before: string | null, after: string) => {
      if (!grant.scope) return;
      if (grant.scope.type !== "paths") codeError("incomplete-evidence", "SCOPE_UNCHECKED", `${grant.did}'s ${grant.scope.type} scope cannot be checked for a code tree (P5.28)`);
      const touched = await diffTrees(before, after, sourceOf(this.objects));
      const outside = covers(grant.scope.paths as string[], touched);
      if (outside.length > 0) codeError("outside-grant", "OUTSIDE_PATH_GRANT", `${outside.length} path(s) outside ${grant.did}'s grant: ${outside.slice(0, 5).join(", ")}`, { outside });
    };
  }

  /**
   * P5.28, P7.1: the subtrees the core's scope check reads for each editor
   * entry (the code tree's path view, reading only changed subtrees), put in
   * the SDK's store, so the import that verifies the branch, and every
   * package of it, holds them.
   */
  private async holdScopeObjects(before: LogEntry | undefined, fresh: readonly LogEntry[]): Promise<void> {
    const cache = new Map<string, Uint8Array>();
    let previous = before;
    for (const e of fresh) {
      const from = previous ? stateOf(previous).asset.resource.digest : undefined;
      const to = stateOf(e).asset.resource.digest;
      previous = e;
      if (!from || from === to) continue;
      for (const d of [from, to]) if (!cache.has(d)) cache.set(d, (await this.objects.get(d)) ?? (await this.sdk.resourceBytes(d))!);
      for (let round = 0; round < 64; round++) {
        const t = codeTreePathView.touched!(cache.get(from)!, cache.get(to)!, (d) => cache.get(d));
        if (t.kind !== "missing") {
          for (const d of t.kind === "touched" ? t.read : []) if (d !== from && d !== to) await this.originals.putResource(d, cache.get(d)!);
          break;
        }
        let found = false;
        for (const d of t.digests) {
          const b = await this.objects.get(d);
          if (b) {
            cache.set(d, b);
            found = true;
          }
        }
        if (!found) break;
      }
    }
  }

  /** Verify a whole branch log through the SDK and commit it (P6.2). */
  private async importLog(entries: LogEntry[], expected?: string): Promise<void> {
    const did = entries[0].state.id as string;
    const bytes: Record<string, Uint8Array> = {};
    for (const e of entries) {
      const digest = stateOf(e).asset.resource.digest;
      if (bytes[digest]) continue;
      const b = (await this.objects.get(digest)) ?? (await this.sdk.resourceBytes(digest));
      if (!b) codeError("unavailable-bytes", "OBJECT_MISSING", `root tree ${digest} is not held`);
      bytes[digest] = b;
    }
    const signers = new Set(entries.map((e) => signerOf(stateOf(e)).ref.did));
    const authors: AuthorDidEvidence[] = [];
    for (const s of signers) {
      const id = this.identities.get(s);
      const evidence = id ? identityEvidence(id) : await this.originals.getAuthorEvidence(s);
      if (!evidence) codeError("incomplete-evidence", "IDENTITY_MISSING", `no DID history for signer ${s}`);
      authors.push(evidence);
    }
    const log = serializeLog(entries);
    const last = entries[entries.length - 1].versionId;
    const zip = writeEvidence({
      manifest: { format: "originals-evidence/0.1", profile: "originals:1.0", original: did, checkpoint: last, head: last, completeness: "complete", missing: [] },
      log,
      authors,
      bytes,
    });
    const imported = await this.sdk.import(zip, expected ? { original: expected } : {});
    if (imported.status !== "imported" && imported.status !== "already-current") {
      codeError("fork", "MIRROR_NOT_COMMITTED", `the branch log was not committed: ${imported.status}`);
    }
  }

  /** Every object reachable from every version of `branches`, and those not held. */
  private async reachable(branches: string[]): Promise<{ objects: Map<string, Uint8Array>; trees: Set<string>; commits: Set<string>; missing: string[] }> {
    const objects = new Map<string, Uint8Array>();
    const trees = new Set<string>();
    const commits = new Set<string>();
    const missing = new Set<string>();
    const seen = new Set<string>();
    const walk = async (digest: string, tree: boolean): Promise<void> => {
      if (seen.has(digest)) return;
      seen.add(digest);
      const b = await this.objects.get(digest);
      if (!b) {
        missing.add(digest);
        return;
      }
      objects.set(digest, b);
      if (!tree) return;
      trees.add(digest);
      for (const child of Object.values((await readTree(digest, () => b)).entries)) await walk(child.digest, child.mode === "40000");
    };
    for (const b of branches) {
      for (const e of await this.entries(b)) {
        await walk(stateOf(e).asset.resource.digest, true);
        const commitObject = metadataOf(e).commitObject;
        if (commitObject) {
          commits.add(commitObject);
          await walk(commitObject, false);
        }
      }
    }
    return { objects, trees, commits, missing: [...missing] };
  }

  /**
   * A repo bundle at the repo's head: the repo Original's and each listed
   * branch's evidence package, as `sdk.package` writes them, and every object
   * they reach. Root trees travel in the packages (they are the resources),
   * so the object pack leaves them out. `omitBlobs` leaves out every blob
   * (a partial bundle: trees and commit objects only). `contributions`
   * names contributor branches (their newest segments) to carry too (K14).
   */
  async package(repo: string, options: { omitBlobs?: boolean; contributions?: readonly string[] } = {}): Promise<Uint8Array> {
    const repoPackage = await this.sdk.package(repo);
    const { document } = await this.repoDocument(repo);
    // Listed branches, then contributions (K14, O7): each by its newest segment.
    const listed = [...new Set([...Object.values(document.refs).flatMap((r) => Object.values(r.branches)), ...(options.contributions ?? [])])].sort();
    // Every segment of each listed branch travels with it (K13).
    const branches: string[] = [];
    for (const b of listed) {
      if (!(await this.originals.get(b))) {
        branches.push(b);
        continue;
      }
      for (const seg of await this.segments(b)) branches.push(seg[0].state.id as string);
    }
    const packages = [{ original: repo, checkpoint: repoPackage.manifest.checkpoint, bytes: repoPackage.bytes }];
    // K15: the release Original the repo names travels with it.
    if (document.releases && (await this.originals.get(document.releases))) {
      const p = await this.sdk.package(document.releases);
      packages.push({ original: document.releases, checkpoint: p.manifest.checkpoint, bytes: p.bytes });
    }
    const roots = new Set<string>();
    for (const b of branches) {
      if (!(await this.originals.get(b))) continue;
      const p = await this.sdk.package(b);
      packages.push({ original: b, checkpoint: p.manifest.checkpoint, bytes: p.bytes });
      for (const e of await this.entries(b)) roots.add(stateOf(e).asset.resource.digest);
    }
    const { objects, trees, commits, missing } = await this.reachable(branches);
    for (const r of roots) objects.delete(r);
    const omitted: string[] = [];
    if (options.omitBlobs) {
      for (const d of [...objects.keys()]) {
        if (trees.has(d) || commits.has(d)) continue;
        objects.delete(d);
        omitted.push(d);
      }
    }
    return writeBundle({ repo, checkpoint: repoPackage.manifest.checkpoint, packages, objects: objects.entries(), missing: [...missing, ...omitted] });
  }
}
