import { describe, expect, test } from "bun:test";
import { localSigner } from "../src/crypto/index.js";
import { OriginalsError } from "../src/errors.js";
import type { JsonObject } from "../src/json/index.js";
import { appendEntry, createLog, createWitnessProof, serializeLog, signWith, type LogEntry } from "../src/log/index.js";
import { resolveDidVh, type DidVhExtension } from "../src/didvh/index.js";

const NOW = Date.parse("2026-10-19T00:00:00Z");
const key = localSigner("Ed25519", new Uint8Array(32).fill(7));
const vm = `did:key:${key.publicKeyMultibase}#${key.publicKeyMultibase}`;
const sign = signWith(key, { cryptosuite: "eddsa-jcs-2022", verificationMethod: vm });
const witnesses = [61, 62, 63].map((seed) => localSigner("Ed25519", new Uint8Array(32).fill(seed)));
const witnessParam = { threshold: 2, witnesses: witnesses.map((w) => ({ id: `did:key:${w.publicKeyMultibase}` })) };

const doc = (extra: JsonObject = {}): JsonObject => ({
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
  id: "did:vh:{SCID}",
  verificationMethod: [{ id: "did:vh:{SCID}#k", type: "Multikey", controller: "did:vh:{SCID}", publicKeyMultibase: key.publicKeyMultibase }],
  assertionMethod: ["did:vh:{SCID}#k"],
  ...extra,
});

async function genesis(parameters: JsonObject = {}, state = doc()): Promise<LogEntry> {
  return createLog({ versionTime: "2026-10-18T10:00:00Z", parameters: { method: "did:vh:1.0", scid: "{SCID}", updateKeys: [key.publicKeyMultibase], ...parameters }, state, sign });
}
const didOf = (entry: LogEntry) => `did:vh:${entry.parameters.scid as string}`;
const next = (previous: LogEntry, seconds: number, parameters: JsonObject = {}, state?: JsonObject) =>
  appendEntry(previous, { versionTime: `2026-10-18T10:00:${String(seconds).padStart(2, "0")}Z`, parameters, state: state ?? previous.state, sign });

const resolve = (did: string, options: Parameters<typeof resolveDidVh>[1]) => resolveDidVh(did, { now: NOW, ...options });

describe("did:vh resolution", () => {
  test("resolves a log passed directly, with the did:vh metadata", async () => {
    const one = await genesis();
    const two = await next(one, 1, { ttl: 60 }, { ...one.state, alsoKnownAs: ["https://example.com/a"] });
    const did = didOf(one);
    expect((one.state as JsonObject).id).toBe(did);
    const result = await resolve(did, { didLog: serializeLog([one, two]) });
    expect(result.didResolutionMetadata.error).toBeUndefined();
    expect(result.didDocument?.alsoKnownAs).toEqual(["https://example.com/a"]);
    expect(result.didDocumentMetadata).toMatchObject({
      versionId: two.versionId, versionTime: two.versionTime, created: one.versionTime, updated: two.versionTime,
      scid: one.parameters.scid, deactivated: false, ttl: "60", watchers: [],
    });
    const first = await resolve(did, { didLog: [one, two], versionNumber: 1 });
    expect(first.didDocument?.alsoKnownAs).toBeUndefined();
    expect(first.didDocumentMetadata.updated).toBe(two.versionTime);
    expect((await resolve(did, { didLog: [one, two], versionId: one.versionId })).didDocumentMetadata.versionId).toBe(one.versionId);
    expect((await resolve(did, { didLog: [one, two], versionTime: "2026-10-18T10:00:00Z" })).didDocumentMetadata.versionId).toBe(one.versionId);
    expect((await resolve(did, { didLog: [one, two], versionNumber: 3 })).didResolutionMetadata.error).toBe("notFound");
  });

  test("witnessed logs need the witness file, with the threshold as a string in metadata", async () => {
    const one = await genesis({ witness: witnessParam });
    const proofs = await Promise.all(witnesses.slice(0, 2).map((w) => createWitnessProof(w, one.versionId)));
    const did = didOf(one);
    expect((await resolve(did, { didLog: [one] })).didResolutionMetadata.error).toBe("invalidDid");
    const result = await resolve(did, { didLog: [one], didWitness: [{ versionId: one.versionId, proof: proofs }] });
    expect(result.didResolutionMetadata.error).toBeUndefined();
    expect(result.didDocumentMetadata.witness).toEqual({ threshold: "2", witnesses: witnessParam.witnesses });
  });

  test("a deactivated DID returns no document, and reports deactivation for earlier versions too", async () => {
    const one = await genesis();
    const two = await next(one, 1, { deactivated: true });
    const did = didOf(one);
    const latest = await resolve(did, { didLog: [one, two] });
    expect(latest.didDocument).toBeNull();
    expect(latest.didDocumentMetadata.deactivated).toBe(true);
    const earlier = await resolve(did, { didLog: [one, two], versionNumber: 1 });
    expect(earlier.didDocument?.id).toBe(did);
    expect(earlier.didDocumentMetadata.deactivated).toBe(true);
  });

  test("later invalid entries leave the earlier ones resolvable, with a warning", async () => {
    const one = await genesis();
    const bad = await next(one, 1, { portable: true });
    const did = didOf(one);
    const result = await resolve(did, { didLog: [one, bad] });
    expect(result.didDocumentMetadata.versionId).toBe(one.versionId);
    expect(result.didResolutionMetadata.warnings?.map((w) => w.code)).toEqual(["invalid-entries"]);
    const requested = await resolve(did, { didLog: [one, bad], versionNumber: 2 });
    expect(requested.didResolutionMetadata.error).toBe("invalidDid");
  });

  test("did:vh-specific rejections", async () => {
    const one = await genesis();
    const did = didOf(one);
    const code = async (log: LogEntry[], d = did) => (await resolve(d, { didLog: log })).didResolutionMetadata;
    expect((await code([one], "did:vh:abc")).error).toBe("invalidDid");
    expect((await code([one], "did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ")).error).toBe("invalidDid");
    const webvh = await createLog({ versionTime: "2026-10-18T10:00:00Z", parameters: { method: "did:webvh:1.0", scid: "{SCID}", updateKeys: [key.publicKeyMultibase] }, state: doc(), sign });
    expect((await code([webvh], didOf(webvh))).problemDetails?.code).toBe("VERSION_UNSUPPORTED");
    const wrongId = await genesis({}, doc({ id: "did:webvh:{SCID}:example.com" }));
    expect((await code([wrongId], didOf(wrongId))).problemDetails?.code).toBe("DIDVH_STATE_ID");
    const logVersion = await genesis({ logVersion: "vh-log:1.0" });
    expect((await code([logVersion], didOf(logVersion))).problemDetails?.code).toBe("PARAMETER_UNKNOWN");
    const badWitness = await genesis({ witness: { threshold: 1, witnesses: [{ id: "did:web:witness.example" }] } });
    expect((await code([badWitness], didOf(badWitness))).error).toBe("invalidDid");
  });

  test("resolution options are validated", async () => {
    const one = await genesis();
    const did = didOf(one);
    const error = async (options: Parameters<typeof resolveDidVh>[1]) => (await resolve(did, options)).didResolutionMetadata.error;
    expect(await error({})).toBe("invalidOptions");
    expect(await error({ didLog: [one], src: "https://example.com/dids/a" })).toBe("invalidOptions");
    expect(await error({ src: "https://example.com/dids/a", didWitness: [] })).toBe("invalidOptions");
    expect(await error({ didLog: [one], versionNumber: 1, versionId: one.versionId })).toBe("invalidOptions");
    expect(await error({ didLog: [one], versionNumber: 0 })).toBe("invalidOptions");
    expect(await error({ didLog: "not json\n" })).toBe("invalidDid");
    expect(await error({ src: "https://example.com/dids/a" })).toBe("featureNotSupported");
    expect(await error({ src: "ftp://example.com/x" })).toBe("featureNotSupported");
    expect(await error({ src: "not a url" })).toBe("invalidOptions");
    expect(await error({ didLog: [one], checkWatchers: 1 })).toBe("featureNotSupported");
  });
});

describe("did:vh extensions (did:vh PR 3)", () => {
  const record: DidVhExtension = {
    name: "test record extension",
    methods: { "test-record:1.0": { vhLog: "vh-log:1.0", rank: 1, entrySuites: ["eddsa-jcs-2022"], witnessSuites: ["eddsa-jcs-2022"] } },
    keys: { kind: "updateKeys" },
    validateEntry: ({ entry, scid }) => {
      if ((entry.state as JsonObject).id !== `did:vh:${scid}`) {
        throw new OriginalsError("invalid-evidence", "TEST_STATE_ID", "record id must be the did:vh");
      }
    },
    deriveDocument: (entries) => {
      const last = entries[entries.length - 1].entry;
      return { "@context": ["https://www.w3.org/ns/did/v1"], id: (last.state as JsonObject).id as string, alsoKnownAs: [(last.state as JsonObject).title as string] };
    },
  };
  const recordGenesis = () =>
    createLog({ versionTime: "2026-10-18T10:00:00Z", parameters: { method: "test-record:1.0", scid: "{SCID}", updateKeys: [key.publicKeyMultibase] }, state: { id: "did:vh:{SCID}", title: "urn:example:record" }, sign });

  test("an extension's document is derived from the log, with id did:vh:<SCID>", async () => {
    const one = await recordGenesis();
    const result = await resolve(didOf(one), { didLog: [one], extensions: [record] });
    expect(result.didResolutionMetadata.error).toBeUndefined();
    expect(result.didDocument).toEqual({ "@context": ["https://www.w3.org/ns/did/v1"], id: didOf(one), alsoKnownAs: ["urn:example:record"] });
  });

  test("C12-70: a resolver without the extension rejects the log by its method value", async () => {
    const one = await recordGenesis();
    const result = await resolve(didOf(one), { didLog: [one] });
    expect(result.didResolutionMetadata.error).toBe("invalidDid");
    expect(result.didResolutionMetadata.problemDetails?.code).toBe("VERSION_UNSUPPORTED");
    expect(result.didDocument).toBeNull();
  });

  test("C12-71: a later entry cannot move the log between plain did:vh and an extension", async () => {
    const plain = await genesis();
    const toExtension = await next(plain, 1, { method: "test-record:1.0" });
    expect((await resolve(didOf(plain), { didLog: [plain, toExtension], extensions: [record], versionNumber: 2 })).didResolutionMetadata.error).toBe("invalidDid");
    const ext = await recordGenesis();
    const toPlain = await next(ext, 1, { method: "did:vh:1.0" });
    expect((await resolve(didOf(ext), { didLog: [ext, toPlain], extensions: [record], versionNumber: 2 })).didResolutionMetadata.error).toBe("invalidDid");
  });

  test("an extension cannot claim did:vh's own method values", async () => {
    const clash = { ...record, methods: { "did:vh:1.0": record.methods["test-record:1.0"] } };
    const one = await genesis();
    expect((await resolve(didOf(one), { didLog: [one], extensions: [clash] })).didResolutionMetadata.error).toBe("invalidOptions");
  });
});
