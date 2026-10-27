/**
 * Shared-host saves, client side (P6.4, P6.7, P6.8). The host here is a small
 * in-memory stand-in that applies P6.7's acceptance order; the real route and
 * durable store live in packages/host (@originals/host) and are exercised by
 * its tests and the landing's shared-host tests.
 * Rows cited are the section 12 matrix rows 131-137 (spec a432aa67).
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { parseJson } from "@originals/vh/json";
import { resourceDigest } from "@originals/vh/originals";
import { readEvidence, readZip } from "../../../src/originals/index.js";
import {
  MemoryStore,
  OriginalsSDK,
  type HostAnswer,
  type SharedHost,
  type SigningRequest,
  type Submission,
} from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(21);
const B1 = bytes("harbor at dawn, first crop");
const MINE = bytes("harbor at dawn, device B's crop");
const THEIRS = bytes("harbor at dawn, device A's crop");

/** One accepted log per Original; byte-identical retries first, then exact parent (P6.7). */
class FakeHost implements SharedHost {
  readonly submissions: Submission[] = [];
  constructor(private readonly source: OriginalsSDK, public lines: string[]) {}

  submit(s: Submission): Promise<HostAnswer> {
    this.submissions.push(s);
    const head = (this.lines[this.lines.length - 1] ? (parseJson(this.lines[this.lines.length - 1]) as { versionId: string }).versionId : "");
    const entry = parseJson(s.entry) as { versionId: string };
    if (this.lines.includes(s.entry)) return Promise.resolve({ status: "already-accepted", checkpoint: entry.versionId, head });
    const n = Number(entry.versionId.split("-")[0]);
    if (n !== this.lines.length + 1) return Promise.resolve({ status: "stale-parent", head });
    this.lines.push(s.entry);
    return Promise.resolve({ status: "accepted", checkpoint: entry.versionId, head: entry.versionId });
  }

  async accepted(): Promise<ReturnType<typeof readEvidence>> {
    // The source device's package carries the evidence; the log is the host's.
    const did = (parseJson(this.lines[0]) as { state: { id: string } }).state.id;
    const contents = readEvidence((await this.source.package(did)).bytes);
    const head = (parseJson(this.lines[this.lines.length - 1]) as { versionId: string }).versionId;
    return { ...contents, log: `${this.lines.join("\n")}\n`, manifest: { ...contents.manifest, checkpoint: head, head } };
  }
}

async function rejects(promise: Promise<unknown>, category: string, code?: string) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected a rejection").toBeInstanceOf(OriginalsError);
  expect((caught as OriginalsError).category).toBe(category as never);
  if (code) expect((caught as OriginalsError).code).toBe(code);
}

/** Two devices of one author with the same Original at the same checkpoint, and a host holding it. */
async function twoDevices() {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const author = alice.ref("orig");
  const signer = alice.signer("orig", KEY);
  const a = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: clock() });
  const storeB = new MemoryStore();
  const b = OriginalsSDK.create({ store: storeB, authors: [alice.evidence()], clock: clock(Date.parse("2026-10-18T12:00:00.100Z")) });
  const created = await a.create({ name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author, signer });
  if (created.kind !== "original") throw new Error("expected an Original");
  await b.import((await a.package(created.original.did)).bytes);
  const did = created.original.did;
  const parent = created.original.checkpoint;
  const store = (await a.package(did)).bytes;
  const host = new FakeHost(a, readEvidence(store).log.trimEnd().split("\n"));
  return { alice, author, signer, a, b, storeB, did, parent, host };
}

/** Device A saves first; device B's save from the same parent is refused. */
async function refusedOnB() {
  const env = await twoDevices();
  const { a, b, did, parent, author, signer, host } = env;
  const theirs = await a.submit(await a.sign(await a.prepareEdit(did, { parent, resources: [{ id: "photo", bytes: THEIRS }], author }), signer), host);
  const mine = await b.sign(await b.prepareEdit(did, { parent, resources: [{ id: "photo", bytes: MINE }], author }), signer);
  const refused = await b.submit(mine, host);
  return { ...env, theirs, mine, refused };
}

describe("shared-host saves (P6.7, P6.8)", () => {
  test("a signed candidate is verified against the exact parent and is not history until the host accepts it (P6.1, P6.4)", async () => {
    const { a, did, parent, author, signer, host } = await twoDevices();
    const candidate = await a.sign(await a.prepareEdit(did, { parent, resources: [{ id: "photo", bytes: THEIRS }], author }), signer);
    expect(candidate.kind).toBe("candidate");
    expect(candidate.parent).toBe(parent);
    expect(candidate.line).toBe(JSON.stringify(candidate.entry));
    expect((await a.get(did)).checkpoint).toBe(parent);
    const result = await a.submit(candidate, host);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.checkpoint).toBe(candidate.versionId);
    expect(result.behind).toBe(false);
    expect(result.original.checkpoint).toBe(candidate.versionId);
    // The submission carries the exact signed line, the new bytes and the signer's DID history.
    const sent = host.submissions[0];
    expect(sent.entry).toBe(candidate.line);
    expect(Object.keys(sent.resources)).toEqual([resourceDigest(THEIRS)]);
    expect(sent.identities.map((i) => i.did)).toEqual([author.did]);
  });

  test("C12-125: a stale-parent answer keeps the draft and the refused candidate, labelled refused; local history does not advance (P6.8)", async () => {
    const { b, did, parent, mine, refused } = await refusedOnB();
    expect(refused.status).toBe("stale-parent");
    if (refused.status !== "stale-parent") return;
    expect(refused.hostHead).not.toBe(parent);
    expect(refused.refused.label).toBe("refused");
    expect(refused.refused.versionId).toBe(mine.versionId);
    expect(refused.refused.entry).toEqual(mine.entry);
    expect(refused.refused.draft.signed).toBe(false);
    expect(refused.refused.draft.entry.versionId).toBe(mine.versionId);
    expect(refused.refused.draft.bytes.get(resourceDigest(MINE))).toEqual(MINE);
    const kept = await b.refused(did);
    expect(kept.map((r) => [r.label, r.versionId, r.hostHead])).toEqual([["refused", mine.versionId, refused.hostHead]]);
    // Local history stays at the parent; nothing the SDK packages carries the refused entry.
    expect((await b.get(did)).checkpoint).toBe(parent);
    const pkg = await b.package(did);
    const log = new TextDecoder().decode(readZip(pkg.bytes).get("asset/did.jsonl"));
    expect(log).not.toContain(mine.versionId);
    expect([...readZip(pkg.bytes).keys()]).not.toContain(`resources/${resourceDigest(MINE)}`);
  });

  test("C12-125: the refused candidate is never submitted again, committed or re-signed as history (P6.8)", async () => {
    const { b, did, mine, signer, host, refused } = await refusedOnB();
    if (refused.status !== "stale-parent") throw new Error("expected a refusal");
    const before = host.submissions.length;
    await rejects(b.submit(mine, host), "stale-parent", "CANDIDATE_REFUSED");
    await rejects(b.commit(refused.refused.draft, signer), "stale-parent", "CANDIDATE_REFUSED");
    await rejects(b.sign(refused.refused.draft, signer), "stale-parent", "CANDIDATE_REFUSED");
    expect(host.submissions.length).toBe(before);
    expect((await b.refused(did)).length).toBe(1);
  });

  test("C12-126: reconcile fetches the new head, shows the signer the change from it, and the reconciled candidate is accepted (P6.8, P5.11)", async () => {
    const { b, did, author, signer, host, refused, theirs } = await refusedOnB();
    if (refused.status !== "stale-parent" || theirs.status !== "accepted") throw new Error("expected one acceptance and one refusal");
    const requests: SigningRequest[] = [];
    const watching = { ...signer, sign: (r: SigningRequest) => (requests.push(r), signer.sign(r)) };
    const result = await b.reconcile(did, {
      host,
      refused: refused.refused.versionId,
      author,
      signer: watching,
      change: ({ head, refused: kept }) => {
        expect(head.checkpoint).toBe(theirs.checkpoint);
        return { resources: [{ id: "photo", bytes: kept!.draft.bytes.get(resourceDigest(MINE))! }] };
      },
    });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    // Signed against the new head, and the signer was shown the change from it.
    expect(requests).toHaveLength(1);
    expect(requests[0].summary.changes).toEqual([{ resource: "photo", from: resourceDigest(THEIRS), to: resourceDigest(MINE) }]);
    expect(result.original.checkpoint).toBe(host.lines.length === 3 ? (parseJson(host.lines[2]) as { versionId: string }).versionId : "");
    expect(result.original.report.history.entries).toBe(3);
    // The refused candidate is kept, labelled with the entry that carried its change; it is still never history (P6.8).
    const kept = await b.refused(did);
    expect(kept.map((r) => [r.label, r.reconciledAs])).toEqual([["refused", result.original.checkpoint]]);
    await rejects(b.sign(kept[0].draft, signer), "stale-parent", "CANDIDATE_REFUSED");
  });

  test("C12-126: reconcile never merges or signs on its own (P6.8)", async () => {
    const { b, did, author, signer, host, refused } = await refusedOnB();
    if (refused.status !== "stale-parent") throw new Error("expected a refusal");
    await rejects(b.reconcile(did, { host, author, signer, change: undefined as never }), "invalid-evidence", "RECONCILE_CHANGE_REQUIRED");
    await rejects(b.reconcile(did, { host, author, signer: undefined as never, change: { name: "x" } }), "unauthorized-key", "SIGNER_REQUIRED");
    const refusing = { ...signer, sign: () => Promise.reject(new Error("the signer declined")) };
    let caught: unknown;
    try {
      await b.reconcile(did, { host, author, signer: refusing, change: { name: "Harbor, reconciled" } });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("declined");
    // The host's head was fetched (it extends local history), nothing else was committed or sent.
    expect(host.lines.length).toBe(2);
    expect((await b.refused(did)).length).toBe(1);
    await rejects(b.reconcile(did, { host, refused: "9-unknown", author, signer, change: { name: "x" } }), "invalid-evidence", "REFUSED_NOT_FOUND");
  });

  test("C12-128: a retry after a lost acknowledgement returns the existing checkpoint and the current head; no second append (P6.4, P6.7)", async () => {
    const { a, b, did, parent, author, signer, host } = await twoDevices();
    const candidate = await b.sign(await b.prepareEdit(did, { parent, resources: [{ id: "photo", bytes: MINE }], author }), signer);
    // The host accepts, but the answer never reaches device B.
    await host.submit({ original: did, entry: candidate.line, resources: {}, identities: [] });
    expect((await b.get(did)).checkpoint).toBe(parent);
    // Device A syncs and saves on top, moving the head on.
    await a.sync(did, host);
    const later = await a.submit(await a.sign(await a.prepareEdit(did, { parent: candidate.versionId, name: "Harbor at noon", author }), signer), host);
    if (later.status !== "accepted") throw new Error("expected acceptance");
    const retry = await b.submit(candidate, host);
    expect(retry.status).toBe("already-accepted");
    if (retry.status !== "already-accepted") return;
    expect(retry.checkpoint).toBe(candidate.versionId);
    expect(retry.hostHead).toBe(later.checkpoint);
    expect(retry.behind).toBe(true);
    expect(retry.original.checkpoint).toBe(candidate.versionId);
    expect(host.lines.length).toBe(3);
    expect(await b.refused(did)).toEqual([]);
    // Retrying once more locally is still the same answer.
    expect((await b.submit(candidate, host)).status).toBe("already-accepted");
  });

  test("sync keeps a host branch that diverges from local history as a fork, never replacing it (P6.6)", async () => {
    const { b, did, parent, author, signer, host, refused } = await refusedOnB();
    if (refused.status !== "stale-parent") throw new Error("expected a refusal");
    // Device B commits locally anyway (a different edit), so its history diverges from the host's.
    await b.edit(did, { parent, name: "Harbor, local only", author, signer });
    const synced = await b.sync(did, host);
    expect(synced.status).toBe("conflict");
    expect(synced.original.report.fork).not.toBeNull();
    expect(synced.original.current).toBe(false);
    await rejects(b.reconcile(did, { host, author, signer, change: { name: "x" } }), "fork", "HOST_DIVERGES");
  });

  test("a host answer that does not name the candidate is refused, and nothing is committed", async () => {
    const { b, did, parent, author, signer } = await twoDevices();
    const candidate = await b.sign(await b.prepareEdit(did, { parent, name: "x", author }), signer);
    const liar: SharedHost = { submit: () => Promise.resolve({ status: "accepted", checkpoint: "2-other", head: "2-other" }), accepted: () => Promise.reject(new Error("unused")) };
    await rejects(b.submit(candidate, liar), "invalid-evidence", "HOST_ANSWER_INVALID");
    const odd: SharedHost = { submit: () => Promise.resolve({ status: "weird" } as never), accepted: () => Promise.reject(new Error("unused")) };
    await rejects(b.submit(candidate, odd), "invalid-evidence", "HOST_ANSWER_INVALID");
    expect((await b.get(did)).checkpoint).toBe(parent);
  });

  test("a candidate whose parent is no longer the local head is a conflict before anything is sent (P6.4)", async () => {
    const { b, did, parent, author, signer, host } = await twoDevices();
    const candidate = await b.sign(await b.prepareEdit(did, { parent, name: "one", author }), signer);
    await b.edit(did, { parent, name: "two", author, signer });
    await rejects(b.submit(candidate, host), "stale-parent", "STALE_PARENT");
    expect(host.submissions).toHaveLength(0);
  });
});

describe("review of the shared-host PR (C3, P2, committed candidates)", () => {
  /** B's candidate refused by the host after A saved first. */
  async function refusedOnB() {
    const env = await twoDevices();
    const theirs = await env.a.sign(await env.a.prepareEdit(env.did, { parent: env.parent, resources: [{ id: "photo", bytes: THEIRS }], author: env.author }), env.signer);
    expect((await env.a.submit(theirs, env.host)).status).toBe("accepted");
    const mine = await env.b.sign(await env.b.prepareEdit(env.did, { parent: env.parent, resources: [{ id: "photo", bytes: MINE }], author: env.author }), env.signer);
    expect((await env.b.submit(mine, env.host)).status).toBe("stale-parent");
    return { ...env, theirs, mine };
  }

  test("C12-129: a package carrying a refused candidate is kept as a branch, never committed as history (P6.8)", async () => {
    const env = await refusedOnB();
    // B's other device packages the refused branch: B's committed log plus the refused entry.
    const pkg = readEvidence((await env.b.package(env.did)).bytes);
    const log = `${pkg.log}${env.mine.line}\n`;
    const contents = { ...pkg, log, manifest: { ...pkg.manifest, checkpoint: env.mine.versionId, head: env.mine.versionId }, bytes: { ...pkg.bytes, [resourceDigest(MINE)]: MINE } };
    const { writeEvidence } = await import("../../../src/originals/index.js");
    const imported = await env.b.import(writeEvidence(contents));
    expect(imported.status).toBe("conflict");
    expect((await env.b.get(env.did)).checkpoint).toBe(env.parent);
    expect(new TextDecoder().decode((await env.b.package(env.did)).bytes)).not.toContain(env.mine.versionId);
    expect((await env.b.refused(env.did)).map((r) => r.versionId)).toEqual([env.mine.versionId]);
  });

  test("C12-128: a candidate is kept as pending before it is sent, so a lost acknowledgement is retried byte-identical (P6.4)", async () => {
    const env = await twoDevices();
    const candidate = await env.a.sign(await env.a.prepareEdit(env.did, { parent: env.parent, resources: [{ id: "photo", bytes: THEIRS }], author: env.author }), env.signer);
    // The host accepts, but the acknowledgement is lost.
    const lossy: SharedHost = { submit: async (s) => { await env.host.submit(s); throw new Error("connection reset"); }, accepted: () => env.host.accepted() };
    await expect(env.a.submit(candidate, lossy)).rejects.toThrow("connection reset");
    const pending = await env.a.pending(env.did);
    expect(pending?.line).toBe(candidate.line);
    expect(pending?.bytes.get(resourceDigest(THEIRS))).toEqual(THEIRS);
    // A fresh SDK on the same store (after a crash) retries the same bytes; the host recognises them.
    const retried = await env.a.submit(pending!, env.host);
    expect(retried.status).toBe("already-accepted");
    expect((await env.a.get(env.did)).checkpoint).toBe(candidate.versionId);
    expect(await env.a.pending(env.did)).toBeUndefined();
    expect(env.host.lines.filter((l) => l === candidate.line)).toHaveLength(1);
  });

  test("a candidate already committed locally that the host refuses is a fork with the host, not a refused candidate (P6.6, P6.8)", async () => {
    const env = await twoDevices();
    const theirs = await env.a.sign(await env.a.prepareEdit(env.did, { parent: env.parent, resources: [{ id: "photo", bytes: THEIRS }], author: env.author }), env.signer);
    expect((await env.a.submit(theirs, env.host)).status).toBe("accepted");
    // B commits its own change locally first, then shares that same entry.
    const mine = await env.b.sign(await env.b.prepareEdit(env.did, { parent: env.parent, resources: [{ id: "photo", bytes: MINE }], author: env.author }), env.signer);
    const draft = await env.b.prepareEdit(env.did, { parent: env.parent, resources: [{ id: "photo", bytes: MINE }], author: env.author });
    const committed = await env.b.commit(draft, env.signer);
    const storedLine = readEvidence((await env.b.package(env.did)).bytes).log.trimEnd().split("\n").at(-1)!;
    const entry = parseJson(storedLine) as unknown as typeof mine.entry;
    const candidate = { ...mine, entry, line: storedLine, versionId: entry.versionId };
    await rejects(env.b.submit(candidate, env.host), "fork", "HOST_DIVERGES");
    expect(await env.b.refused(env.did)).toEqual([]);
    expect((await env.b.get(env.did)).checkpoint).toBe(committed.original.checkpoint);
  });
});
