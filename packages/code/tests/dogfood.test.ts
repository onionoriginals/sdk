/**
 * The dogfood pieces (plan 049 §6 milestone 1; CODE-37 to CODE-39): a CI
 * editor identity whose key is held in Turnkey (K21), entries signed through
 * Turnkey and checked before use, and a workspace rebuilt from its signed logs
 * and git (K22). Turnkey is a local test double: no network, no credential.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { localSigner } from "@originals/vh/crypto";
import { MemoryStore } from "@originals/sdk/originals";
import { GitSource } from "../src/git.js";
import {
  CodeWorkspace,
  MemoryObjectStore,
  createRemoteIdentity,
  parseRemoteIdentity,
  rehydrateObjects,
  serializeRemoteIdentity,
  serializeUpdateKey,
  verifyRepository,
} from "../src/index.js";
import { TURNKEY_ENV, turnkeyCredentials, turnkeyEntrySigner, type TurnkeyClientLike } from "../src/turnkey.js";
import { FixtureRepo, NOW, identity, ticking } from "./helpers.js";

const MAIN = "refs/heads/main";
const LATER = NOW + 3_600_000;
const CREDS = { apiPublicKey: "pub", apiPrivateKey: "priv", organizationId: "org-1" };
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

/** A Turnkey double: signs the raw payload with `secret` for `signWith`, as signRawPayload answers. */
function fakeTurnkey(secret: Uint8Array, signWith: string) {
  const calls: Array<{ organizationId: string; signWith: string; hashFunction: string }> = [];
  const key = localSigner("Ed25519", secret);
  const client = {
    apiClient: () => ({
      signRawPayload: async (req: { organizationId: string; signWith: string; payload: string; hashFunction: string }) => {
        calls.push({ organizationId: req.organizationId, signWith: req.signWith, hashFunction: req.hashFunction });
        if (req.signWith !== signWith) throw new Error("unknown key");
        const sig = await key.sign(unhex(req.payload.slice(2)));
        return { activity: { result: { signRawPayloadResult: { r: hex(sig.subarray(0, 32)), s: hex(sig.subarray(32)) } } } };
      },
    }),
  } as unknown as TurnkeyClientLike;
  return { client, calls, publicKeyMultibase: key.publicKeyMultibase };
}

async function source(repo: FixtureRepo) {
  const s = new GitSource(repo.dir);
  cleanup.push(() => s.close());
  return s;
}

/** The dogfood setup: the owner's repo and branch, CI granted `**`, CI's key in (fake) Turnkey. */
async function dogfood() {
  const owner = await identity(1);
  const tk = fakeTurnkey(new Uint8Array(32).fill(77), "tk-key-1");
  const { identity: ci, updateSecret } = await createRemoteIdentity({ kind: "turnkey", signWith: "tk-key-1", publicKeyMultibase: tk.publicKeyMultibase }, { now: NOW - 3_600_000 });
  const originals = new MemoryStore();
  const ws = CodeWorkspace.create({ originals, objects: new MemoryObjectStore(), clock: ticking() });
  ws.addIdentity(ci);
  const up = new FixtureRepo();
  cleanup.push(() => up.remove());
  up.commit({ "README.md": "# Dogfood\n", "src/a.ts": "1\n" });
  const repo = await ws.initRepo({ name: "dogfood", identity: owner });
  const { branch } = await ws.mirror({ repo, ref: MAIN, identity: owner, source: await source(up) });
  await ws.grantPaths(repo, owner, ci.did, ["**"]);
  return { owner, tk, ci, updateSecret, ws, originals, up, repo, branch };
}

describe("CODE-37 a CI identity whose key is held in Turnkey (K21)", () => {
  test("the identity file holds public data and the key reference only", async () => {
    const t = await dogfood();
    const file = serializeRemoteIdentity(t.ci);
    expect(file).not.toContain(hex(t.updateSecret));
    expect(JSON.parse(file)).toMatchObject({ format: "originals-code-remote-identity/0.1", did: t.ci.did, key: { kind: "turnkey", signWith: "tk-key-1", publicKeyMultibase: t.tk.publicKeyMultibase } });
    expect(parseRemoteIdentity(file)).toEqual(t.ci);
    // The update key is separate, private, and not the signing key (P5.11).
    expect(JSON.parse(serializeUpdateKey(t.ci.did, t.updateSecret))).toMatchObject({ format: "originals-code-update-key/0.1", did: t.ci.did });
    expect(localSigner("Ed25519", t.updateSecret).publicKeyMultibase).not.toBe(t.tk.publicKeyMultibase);
  });

  test("a file with a secret, another key, or a non-Ed25519 key is refused", async () => {
    const t = await dogfood();
    const v = JSON.parse(serializeRemoteIdentity(t.ci));
    expect(() => parseRemoteIdentity(JSON.stringify({ ...v, signingSecret: "00" }))).toThrow(/never holds a secret/);
    const other = localSigner("Ed25519", new Uint8Array(32).fill(9)).publicKeyMultibase;
    expect(() => parseRemoteIdentity(JSON.stringify({ ...v, key: { ...v.key, publicKeyMultibase: other } }))).toThrow(/assertion key/);
    const secp = localSigner("secp256k1", new Uint8Array(32).fill(9)).publicKeyMultibase;
    await expect(createRemoteIdentity({ kind: "turnkey", signWith: "k", publicKeyMultibase: secp })).rejects.toMatchObject({ code: "IDENTITY_KEYS" });
  });

  test("credentials: none set is null (mirroring is skipped); some set is an error", () => {
    expect(turnkeyCredentials({})).toBeNull();
    expect(turnkeyCredentials({ TURNKEY_API_PUBLIC_KEY: "a", TURNKEY_API_PRIVATE_KEY: "b", TURNKEY_ORGANIZATION_ID: "c" })).toEqual({ apiPublicKey: "a", apiPrivateKey: "b", organizationId: "c" });
    expect(() => turnkeyCredentials({ TURNKEY_API_PUBLIC_KEY: "a" })).toThrow(/TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID/);
    expect(TURNKEY_ENV).toEqual(["TURNKEY_API_PUBLIC_KEY", "TURNKEY_API_PRIVATE_KEY", "TURNKEY_ORGANIZATION_ID"]);
  });
});

describe("CODE-38 CI mirrors as an editor through Turnkey", () => {
  test("entries signed through Turnkey verify, under the inherited `**` grant", async () => {
    const t = await dogfood();
    t.up.commit({ "src/a.ts": "2\n", "docs/new.md": "n" });
    const head = t.up.commit({ "README.md": "# Dogfood 2\n" });
    const sign = turnkeyEntrySigner(t.ci, CREDS, t.tk.client);
    const r = await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.ci, sign, source: await source(t.up), branch: t.branch });
    expect(r).toMatchObject({ created: false, appended: 2, head: { commit: head } });
    expect(t.tk.calls.length).toBe(2);
    expect(t.tk.calls.every((c) => c.organizationId === "org-1" && c.signWith === "tk-key-1" && c.hashFunction === "HASH_FUNCTION_NOT_APPLICABLE")).toBe(true);
    const report = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    const b = report.branches[0].code!;
    expect(b.history.status).toBe("valid");
    expect(b.grants.map((g) => [g.signer, g.status])).toEqual([[t.ci.did, "allowed"], [t.ci.did, "allowed"]]);
    expect(report.canonical[0]).toMatchObject({ status: "agreed", head: { commit: head } });
  });

  test("a Turnkey key that is not the identity's fails before anything is committed", async () => {
    const t = await dogfood();
    const before = (await t.ws.sdk.get(t.branch)).checkpoint;
    t.up.commit({ "src/a.ts": "2\n" });
    const wrong = fakeTurnkey(new Uint8Array(32).fill(78), "tk-key-1");
    const sign = turnkeyEntrySigner(t.ci, CREDS, wrong.client);
    await expect(t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.ci, sign, source: await source(t.up), branch: t.branch })).rejects.toMatchObject({ code: "TURNKEY_KEY_MISMATCH" });
    expect((await t.ws.sdk.get(t.branch)).checkpoint).toBe(before);
  });

  test("a public identity with no signer is refused", async () => {
    const t = await dogfood();
    t.up.commit({ "src/a.ts": "2\n" });
    await expect(t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.ci, source: await source(t.up), branch: t.branch })).rejects.toMatchObject({ code: "MIRROR_NO_SIGNER" });
  });
});

describe("CODE-39 a workspace rebuilt from its logs and git (K22)", () => {
  test("objects come back from git, checked against the logs; the bundle is complete again", async () => {
    const t = await dogfood();
    t.up.commit({ "src/a.ts": "2\n" });
    await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.ci, sign: turnkeyEntrySigner(t.ci, CREDS, t.tk.client), source: await source(t.up), branch: t.branch });
    // Same logs, no objects: what the mirror branch restores.
    const bare = CodeWorkspace.create({ originals: t.originals, objects: new MemoryObjectStore(), identities: [t.owner, t.ci] });
    const partial = await verifyRepository(await bare.package(t.repo), { now: LATER });
    expect(partial.branches[0].code!.content.status).toBe("partial");
    const r = await rehydrateObjects(bare, t.repo, await source(t.up));
    expect(r).toEqual({ branches: 1, commits: 2 });
    const full = await verifyRepository(await bare.package(t.repo), { now: LATER });
    expect(full.branches[0].code!.content.status).toBe("complete");
    expect(full.branches[0].code!.commitBinding.status).toBe("matches");
  });

  test("a git repository whose history differs from the logs is refused", async () => {
    const t = await dogfood();
    const other = new FixtureRepo();
    cleanup.push(() => other.remove());
    other.commit({ "README.md": "# Something else\n" });
    // Another repository does not hold the logged commits at all.
    const bare = CodeWorkspace.create({ originals: t.originals, objects: new MemoryObjectStore(), identities: [t.owner] });
    await expect(rehydrateObjects(bare, t.repo, await source(other))).rejects.toThrow();
    // A converter that answers with other content is a mismatch.
    const real = await source(t.up);
    const lying = { firstParent: real.firstParent.bind(real), convert: async (c: string, o: MemoryObjectStore) => ({ ...(await real.convert(c, o, { commitObject: true })), root: { digest: "zQmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N", size: 1 } }) };
    await expect(rehydrateObjects(bare, t.repo, lying)).rejects.toMatchObject({ code: "REHYDRATE_MISMATCH" });
  });
});

