/**
 * A code workspace (plan 049 phases 1–3): a repo Original, its branch
 * Originals and their objects, over any `OriginalsStore` and `ObjectStore`.
 * Browser-safe; `@originals/code/fs` opens one on disk and
 * `@originals/code/git` supplies commits from a git repository.
 *
 * Every Original is written through the SDK: the repo Original with
 * `create`/`edit`, a branch Original by building its entries with the vh
 * builders, signing each once, and importing the resulting log, which the
 * SDK verifies whole and commits durably (P6.2). No `originals:1.0` rule is
 * relaxed anywhere.
 */
import { parseLog, serializeLog, type LogEntry } from "@originals/vh/log";
import { signerOf, type AuthorDidEvidence, type EditorGrant, type EntryState } from "@originals/vh/originals";
import { OriginalsSDK, keySigner, writeEvidence, type OriginalsStore } from "@originals/sdk/originals";
import { appendCommits, branchChain, metadataOf, type MirrorCommit } from "./branch.js";
import { writeBundle } from "./bundle.js";
import { REPO_MEDIA_TYPE, decodeRepoDocument, encodeRepoDocument, repoMetadata, type RepoDocument } from "./documents.js";
import { codeError } from "./errors.js";
import { covers } from "./grants.js";
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
  /** Set when the branch is new and the signer is not the repo's author, who must list it (K5). */
  needsListing?: boolean;
}

const stateOf = (e: LogEntry) => e.state as unknown as EntryState;

export class CodeWorkspace {
  readonly sdk: OriginalsSDK;
  private readonly identities = new Map<string, Pick<LocalIdentity, "did" | "log">>();

  private constructor(
    readonly originals: OriginalsStore,
    readonly objects: ObjectStore,
    private readonly clock: () => number,
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
    const ws = new CodeWorkspace(options.originals, options.objects, options.clock ?? Date.now);
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

  /** Create the repo Original; `identity` is its author and first delegate (K5). */
  async initRepo(input: { name: string; identity: LocalIdentity; document?: Partial<RepoDocument> }): Promise<string> {
    const document: RepoDocument = { delegates: [input.identity.did], refs: {}, grants: [], ...input.document };
    const created = await this.sdk.create({
      name: input.name,
      metadata: repoMetadata(),
      resource: { mediaType: REPO_MEDIA_TYPE, bytes: encodeRepoDocument(document) },
      author: identityRef(input.identity),
      signer: this.signer(input.identity),
    });
    if (created.kind !== "original") return codeError("invalid-evidence", "REPO_NOT_CREATED", "the repo Original was not created");
    return created.original.did;
  }

  /** The repo document at the repo's verified head, or at `checkpoint`. */
  async repoDocument(repo: string, checkpoint?: string): Promise<{ versionId: string; document: RepoDocument }> {
    const view = await this.sdk.get(repo, checkpoint ? { checkpoint } : {});
    const bytes = await this.sdk.resourceBytes(view.state.resource.digest);
    if (!bytes) return codeError("unavailable-bytes", "REPO_DOCUMENT_MISSING", "the repo document's bytes are not held");
    return { versionId: view.checkpoint, document: decodeRepoDocument(bytes) };
  }

  /** Change the repo document. Only the repo's author signs this (P5.2; multi-delegate changes are plan 049 phase 4). */
  async updateRepo(repo: string, identity: LocalIdentity, change: (document: RepoDocument) => RepoDocument): Promise<string> {
    const { versionId, document } = await this.repoDocument(repo);
    const next = change(structuredClone(document));
    // K5: refused before signing, as the verifier would reject it.
    if (!next.delegates.includes(identity.did)) codeError("invalid-evidence", "REPO_AUTHOR", "the repo Original's author must stay one of its delegates");
    const result = await this.sdk.edit(repo, {
      parent: versionId,
      resource: { bytes: encodeRepoDocument(next), mediaType: REPO_MEDIA_TYPE },
      author: identityRef(identity),
      signer: this.signer(identity),
    });
    return result.original.checkpoint;
  }

  /** List `branch` as `delegate`'s branch for `ref` (signed by the repo's author). */
  async listBranch(repo: string, identity: LocalIdentity, input: { ref: string; delegate: string; branch: string; threshold?: number }): Promise<string> {
    return this.updateRepo(repo, identity, (doc) => {
      const rule = doc.refs[input.ref] ?? { threshold: input.threshold ?? 1, branches: {} };
      rule.branches[input.delegate] = input.branch;
      if (input.threshold !== undefined) rule.threshold = input.threshold;
      doc.refs[input.ref] = rule;
      return doc;
    });
  }

  /** Grant editors on a branch Original (P5.15). Signed by the branch's author. */
  async grantEditors(branch: string, identity: LocalIdentity, editors: EditorGrant[] | null): Promise<string> {
    const view = await this.sdk.get(branch);
    const result = await this.sdk.edit(branch, { parent: view.checkpoint, editors, author: identityRef(identity), signer: this.signer(identity) });
    return result.original.checkpoint;
  }

  private async entries(did: string): Promise<LogEntry[]> {
    const stored = await this.originals.get(did);
    return stored ? (parseLog(stored.log) as unknown as LogEntry[]) : [];
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
  }): Promise<MirrorResult> {
    const { repo, ref, identity } = input;
    this.addIdentity(identity);
    const repoDoc = await this.repoDocument(repo);
    const own = repoDoc.document.refs[ref]?.branches[identity.did];
    const branch = input.branch ?? own;
    const log = branch ? await this.entries(branch) : [];
    if (branch && log.length === 0) codeError("incomplete-evidence", "BRANCH_NOT_HELD", `${branch} is not in this workspace`);
    const role: "author" | "editor" = log.length === 0 || stateOf(log[0]).author.did === identity.did ? "author" : "editor";

    let commits = await input.source.firstParent(ref);
    const chain = branchChain(log).map((c) => c.commit);
    if (chain.length > 0) {
      const same = chain.length <= commits.length && chain.every((c, i) => commits[i] === c);
      if (!same) codeError("stale-parent", "MIRROR_DIVERGED", `${ref} no longer extends the branch's history at ${chain[chain.length - 1]}; nothing is rebased (P4.5)`);
      commits = commits.slice(chain.length);
    }
    if (input.limit !== undefined) commits = commits.slice(0, input.limit);
    const commitObjects: MirrorResult["commitObjects"] = input.commits === false ? "omitted" : input.private && input.commits !== true ? "omitted-private" : "included";
    const converted: MirrorCommit[] = [];
    for (const c of commits) converted.push(await input.source.convert(c, this.objects, { commitObject: commitObjects === "included" }));

    const check = role === "editor" ? this.pathCheck(repoDoc.document, identity.did) : undefined;
    const fresh = await appendCommits({
      log,
      commits: converted,
      repo,
      ref,
      repoVersion: repoDoc.versionId,
      signer: { role, ref: identityRef(identity), sign: identitySigner(identity) },
      clock: this.clock,
      ...(check ? { check } : {}),
    });
    const all = [...log, ...fresh];
    if (fresh.length > 0) await this.importLog(all, branch);
    const did = branch ?? (all[0].state.id as string);
    const last = all[all.length - 1];
    const result: MirrorResult = { branch: did, created: !branch, appended: fresh.length, head: { commit: branchChain([last])[0].commit, versionId: last.versionId }, commitObjects };
    if (!branch) {
      const repoAuthor = stateOf((await this.entries(repo))[0]).author.did;
      if (repoAuthor === identity.did) await this.listBranch(repo, identity, { ref, delegate: identity.did, branch: did });
      else result.needsListing = true;
    }
    return result;
  }

  /** Refuse, before signing, a change outside the signer's path grant (K7; as the SDK refuses outside-grant, P5.16). */
  private pathCheck(document: RepoDocument, signer: string) {
    const grant = document.grants.find((g) => g.did === signer);
    return async (before: string | null, after: string) => {
      const touched = await diffTrees(before, after, sourceOf(this.objects));
      if (touched.length === 0) return;
      if (!grant) codeError("outside-grant", "NO_PATH_GRANT", `${signer} has no path grant in this repo`);
      const outside = covers(grant.paths, touched);
      if (outside.length > 0) codeError("outside-grant", "OUTSIDE_PATH_GRANT", `${outside.length} path(s) outside ${signer}'s grant: ${outside.slice(0, 5).join(", ")}`, { outside });
    };
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
   * (a partial bundle: trees and commit objects only).
   */
  async package(repo: string, options: { omitBlobs?: boolean } = {}): Promise<Uint8Array> {
    const repoPackage = await this.sdk.package(repo);
    const { document } = await this.repoDocument(repo);
    const branches = [...new Set(Object.values(document.refs).flatMap((r) => Object.values(r.branches)))].sort();
    const packages = [{ original: repo, checkpoint: repoPackage.manifest.checkpoint, bytes: repoPackage.bytes }];
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
