/**
 * `@originals/sdk/did`: the identity and alias helpers the apps copied. An
 * identity minted here signs Originals that verify with complete identity
 * evidence (P5.2, P5.3); its authorship key is never its update key (P5.11);
 * after a did:webvh move, the author reference keeps the genesis DID and names
 * the new location (P5.14); an alias minted here publishes (P3.6).
 */
import { describe, expect, test } from "bun:test";
import { localSigner } from "@originals/vh/crypto";
import {
  AUTHORSHIP_KEY, IDENTITY_KEY, aliasFromLog, aliasPathSegment, createWebvhAlias, createWebvhIdentity, ensureWebvhIdentity, identityFromLog,
  localWebvhSigner, updateDIDOriginal, userPathSegment,
} from "../../../src/did/index.js";
import { MemoryStore, OriginalsSDK, keySigner } from "../../../src/originals/index.js";

const secret = (n: number) => new Uint8Array(32).fill(n);
const AUTHORSHIP = secret(12);
const identitySigner = localWebvhSigner(secret(11));
const authorshipKey = localSigner("Ed25519", AUTHORSHIP).publicKeyMultibase;
const paths = [userPathSegment("0123456789abcdef-rest")];

async function sign(identity: Awaited<ReturnType<typeof createWebvhIdentity>>) {
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [identity.evidence] });
  const signer = keySigner({ keyType: "Ed25519", secretKey: AUTHORSHIP, verificationMethod: identity.ref.verificationMethod });
  const c = await sdk.create({ name: "By the identity", resource: { mediaType: "text/plain", bytes: new TextEncoder().encode("hello") }, author: identity.ref, signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  return { sdk, signer, view: c.original };
}

describe("createWebvhIdentity", () => {
  test("the originals.build shape: #key-0 updates and authenticates, #key-1 asserts, and it authors Originals", async () => {
    const identity = await createWebvhIdentity({ domain: "example.com", paths, identitySigner, authorshipKey });
    expect(identity.did).toMatch(/^did:webvh:[^:]+:example\.com:user-0123456789abcdef$/);
    expect(identity.location).toBe(identity.did);
    const [genesis] = identity.log.trimEnd().split("\n").map((l) => JSON.parse(l) as { parameters: { updateKeys: string[]; portable: boolean }; state: Record<string, unknown> });
    expect(genesis.parameters.updateKeys).toEqual([identitySigner.getPublicKeyMultibase()]);
    expect(genesis.parameters.portable).toBe(true);
    expect(genesis.state.authentication).toEqual([`#${IDENTITY_KEY}`]);
    expect(genesis.state.assertionMethod).toEqual([`#${AUTHORSHIP_KEY}`]);
    expect(identity.ref).toEqual({ did: identity.did, verificationMethod: `${identity.did}#key-1`, versionId: (JSON.parse(identity.log.split("\n")[0]) as { versionId: string }).versionId });

    const { view } = await sign(identity);
    expect(view.validAsOf).not.toBeNull();
    expect(view.report.identityEvidence.status).toBe("complete");
    expect(view.report.authorBinding.status).toBe("valid");
    expect(view.report.reasons).toEqual(["not-anchored"]);
  });

  test("P5.11: the authorship key may not be the update key", async () => {
    await expect(createWebvhIdentity({ domain: "example.com", paths, identitySigner, authorshipKey: identitySigner.getPublicKeyMultibase() })).rejects.toMatchObject({ code: "AUTHORSHIP_KEY_IS_UPDATE_KEY" });
  });

  test("P5.14: after a move the reference keeps the genesis DID and names the new location, and still signs", async () => {
    const identity = await createWebvhIdentity({ domain: "example.com", paths, identitySigner, authorshipKey });
    const moved = await updateDIDOriginal({
      type: "did", log: identity.log.trimEnd().split("\n").map((l) => JSON.parse(l) as never), signer: identitySigner, verifier: identitySigner, domain: "moved.example",
    });
    const after = identityFromLog(moved.log.map((e) => `${JSON.stringify(e)}\n`).join(""), { obtainedAt: "2026-11-09T00:00:00Z" });
    expect(after.did).toBe(identity.did);
    expect(after.location).toMatch(/:moved\.example:/);
    expect(after.ref.verificationMethod).toBe(`${after.location}#key-1`);
    expect(after.evidence.obtainedAt).toBe("2026-11-09T00:00:00Z");
    const { view } = await sign(after);
    expect(view.validAsOf).not.toBeNull();
    expect(view.report.identityEvidence.status).toBe("complete");
  });
});

describe("ensureWebvhIdentity", () => {
  test("mints and saves once, then loads what was saved", async () => {
    let saved: string | null = null;
    let saves = 0;
    const options = { domain: "example.com", paths, identitySigner, authorshipKey, load: () => Promise.resolve(saved), save: (log: string) => ((saved = log), saves++, Promise.resolve()) };
    const first = await ensureWebvhIdentity(options);
    const second = await ensureWebvhIdentity(options);
    expect(second).toEqual(first);
    expect(saves).toBe(1);
    // A failed save leaves no identity to use.
    await expect(ensureWebvhIdentity({ ...options, load: () => Promise.resolve(null), save: () => Promise.reject(new Error("offline")) })).rejects.toThrow("offline");
  });

  test("two calls at once with a create-if-absent save end with the one stored identity", async () => {
    let stored: string | null = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let loads = 0;
    const options = {
      domain: "example.com", paths, identitySigner, authorshipKey,
      // Both calls find nothing: the second load waits until both are past it.
      load: async () => { if (++loads === 2) release(); await gate; return stored; },
      save: (log: string) => { if (stored !== null) return Promise.resolve(stored); stored = log; return Promise.resolve(); },
    };
    const [a, b] = await Promise.all([ensureWebvhIdentity(options), ensureWebvhIdentity(options)]);
    expect(a.did).toBe(b.did);
    expect(a).toEqual(identityFromLog(stored!));
    expect(b).toEqual(a);
    // The loser gets the stored identity even when it minted a different one.
    const other = await createWebvhIdentity({ domain: "example.com", paths, identitySigner, authorshipKey, portable: false });
    const lost = await ensureWebvhIdentity({ ...options, load: () => Promise.resolve(null), save: () => Promise.resolve(other.log) });
    expect(lost).toEqual(other);
    expect(lost.did).not.toBe(a.did);
  });

  test("a loaded or stored log that is not the identity asked for is refused, and an empty answer from save too", async () => {
    const base = { domain: "example.com", paths, identitySigner, authorshipKey };
    const otherSigner = localWebvhSigner(secret(21));
    const otherAuthorship = localSigner("Ed25519", secret(22)).publicKeyMultibase;
    const foreign = {
      domain: await createWebvhIdentity({ ...base, domain: "other.example" }),
      paths: await createWebvhIdentity({ ...base, paths: [userPathSegment("ffffffffffffffff")] }),
      identityKey: await createWebvhIdentity({ ...base, identitySigner: otherSigner }),
      // Another account's DID that names this account's (public) authorship key: signing under it must still be refused.
      administered: await createWebvhIdentity({ ...base, identitySigner: otherSigner, authorshipKey }),
      authorship: await createWebvhIdentity({ ...base, authorshipKey: otherAuthorship }),
    };
    for (const id of Object.values(foreign)) {
      for (const via of ["load", "save"] as const) {
        const options = { ...base, load: () => Promise.resolve(via === "load" ? id.log : null), save: () => Promise.resolve(via === "save" ? id.log : undefined) };
        await expect(ensureWebvhIdentity(options)).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
      }
    }
    await expect(ensureWebvhIdentity({ ...base, load: () => Promise.resolve(null), save: () => Promise.resolve("") })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  test("an identity at a punycode domain loads again with the options that created it", async () => {
    const options = { domain: "xn--bcher-kva.example", paths, identitySigner, authorshipKey };
    const identity = await createWebvhIdentity(options);
    const loaded = await ensureWebvhIdentity({ ...options, load: () => Promise.resolve(identity.log), save: () => Promise.resolve() });
    expect(loaded).toEqual(identity);
  });

  test("P5.3: the authorship key embedded under assertionMethod is accepted, as the verifier accepts it", async () => {
    const identity = await createWebvhIdentity({ domain: "example.com", paths, identitySigner, authorshipKey });
    const lines = identity.log.trimEnd().split("\n").map((l) => JSON.parse(l) as { state: { verificationMethod: Array<{ id: string }>; assertionMethod: unknown[] } });
    const last = lines[lines.length - 1].state;
    const method = last.verificationMethod.find((m) => m.id === "#key-1")!;
    last.verificationMethod = last.verificationMethod.filter((m) => m !== method);
    last.assertionMethod = [method];
    const log = lines.map((l) => `${JSON.stringify(l)}\n`).join("");
    const loaded = await ensureWebvhIdentity({ domain: "example.com", paths, identitySigner, authorshipKey, load: () => Promise.resolve(log), save: () => Promise.resolve() });
    expect(loaded.did).toBe(identity.did);
    // Embedded with another key, it is refused.
    last.assertionMethod = [{ ...method, publicKeyMultibase: localSigner("Ed25519", secret(30)).publicKeyMultibase }];
    const other = lines.map((l) => `${JSON.stringify(l)}\n`).join("");
    await expect(ensureWebvhIdentity({ domain: "example.com", paths, identitySigner, authorshipKey, load: () => Promise.resolve(other), save: () => Promise.resolve() })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });

  test("a malformed stored log is INPUT_INVALID, never a raw TypeError", async () => {
    const identity = await createWebvhIdentity({ domain: "example.com", paths, identitySigner, authorshipKey });
    const [first] = identity.log.trimEnd().split("\n");
    const withNull = `${first}\nnull\n${first}\n`;
    const genesis = JSON.parse(first) as { state: { verificationMethod: unknown[] } };
    genesis.state.verificationMethod = [null, ...genesis.state.verificationMethod];
    const nullMethod = `${JSON.stringify(genesis)}\n`;
    for (const log of [withNull]) {
      await expect(ensureWebvhIdentity({ domain: "example.com", paths, identitySigner, authorshipKey, load: () => Promise.resolve(log), save: () => Promise.resolve() })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    }
    // A null entry among the methods is skipped, not thrown on: the real #key-1 still names the key.
    await expect(ensureWebvhIdentity({ domain: "example.com", paths, identitySigner, authorshipKey, load: () => Promise.resolve(nullMethod), save: () => Promise.resolve() })).resolves.toMatchObject({ did: identity.did });
  });

  test("P5.14: a moved identity loads when the app gives where it is hosted now", async () => {
    const identity = await createWebvhIdentity({ domain: "example.com", paths, identitySigner, authorshipKey });
    const moved = await updateDIDOriginal({ type: "did", log: identity.log.trimEnd().split("\n").map((l) => JSON.parse(l) as never), signer: identitySigner, verifier: identitySigner, domain: "moved.example" });
    const log = moved.log.map((e) => `${JSON.stringify(e)}\n`).join("");
    const options = { domain: "moved.example", paths, identitySigner, authorshipKey, load: () => Promise.resolve(log), save: () => Promise.resolve() };
    const loaded = await ensureWebvhIdentity(options);
    expect(loaded.did).toBe(identity.did);
    expect(loaded.location).toMatch(/:moved\.example:/);
    await expect(ensureWebvhIdentity({ ...options, domain: "example.com" })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });
});

describe("createWebvhAlias", () => {
  test("P3.6: an alias minted for an Original publishes it, and reads back from its log", async () => {
    const identity = await createWebvhIdentity({ domain: "example.com", paths, identitySigner, authorshipKey });
    const { sdk, signer, view } = await sign(identity);
    const alias = await createWebvhAlias({ domain: "example.com", paths: [...paths, aliasPathSegment(view.did)], signer: identitySigner, original: view.did });
    expect(alias.did).toMatch(new RegExp(`:example\\.com:user-0123456789abcdef:o-${view.did.slice(7, 23)}$`));
    const published = await sdk.publish(view.did, { parent: view.checkpoint, author: identity.ref, signer, alias });
    expect(published.original.report.aliases).toEqual([{ did: alias.did, status: "confirmed" }]);
    expect(aliasFromLog(alias.log as string)).toEqual(alias);
  });

  test("names: refused inputs", () => {
    expect(() => aliasPathSegment("did:webvh:x:example.com")).toThrow();
    expect(() => userPathSegment("")).toThrow();
    expect(() => identityFromLog("not json")).toThrow();
    expect(() => aliasFromLog('{"state":{"id":"did:vh:x"}}')).toThrow();
  });
});

describe("localWebvhSigner", () => {
  test("verifies its own signatures over raw or Multikey-prefixed keys, and nothing else", async () => {
    const s = localWebvhSigner(secret(13));
    const key = localSigner("Ed25519", secret(13));
    const message = new TextEncoder().encode("bytes");
    const signature = await key.sign(message);
    const multikey = s.getPublicKeyMultibase();
    expect(s.getVerificationMethodId()).toBe(`did:key:${multikey}`);
    const { multibaseDecode } = await import("@originals/vh/crypto");
    const prefixed = multibaseDecode(multikey);
    expect(await s.verify(signature, message, prefixed)).toBe(true);
    expect(await s.verify(signature, message, prefixed.slice(2))).toBe(true);
    expect(await s.verify(signature, new TextEncoder().encode("other"), prefixed)).toBe(false);
    expect(await s.verify(signature, message, new Uint8Array(33))).toBe(false);
  });
});
