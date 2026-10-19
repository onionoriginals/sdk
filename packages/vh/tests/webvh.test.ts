import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { localSigner } from "../src/crypto/index.js";
import { parseJson, type JsonObject } from "../src/json/index.js";
import { appendEntry, createLog, serializeLog, signWith, type LogEntry } from "../src/log/index.js";
import { didWebvhLogUrl, parseDidWebvh, resolveDidWebvh } from "../src/webvh/index.js";

const fixture = parseJson(readFileSync(new URL("./fixtures/didwebvh-ts-2.8.0.json", import.meta.url), "utf8")) as unknown as {
  did: string; logA: LogEntry[]; witnessA: unknown[]; logC: LogEntry[];
};
const NOW = Date.parse("2026-10-19T00:00:00Z");
const SCID = "QmfKdRx6tJWUu8HmhyiRA7kbLyFCiCcifDpK7k6i3H2CHb";
const resolve = (did: string, options: Parameters<typeof resolveDidWebvh>[1]) => resolveDidWebvh(did, { now: NOW, ...options });

describe("did:webvh identifiers", () => {
  test("parses domains, ports and paths, and maps them to the log URL", () => {
    expect(parseDidWebvh(`did:webvh:${SCID}:example.com`)).toMatchObject({ scid: SCID, host: "example.com", path: [] });
    expect(didWebvhLogUrl(`did:webvh:${SCID}:example.com`)).toBe("https://example.com/.well-known/did.jsonl");
    expect(didWebvhLogUrl(`did:webvh:${SCID}:example.com%3A3000:dids:issuer`)).toBe("https://example.com:3000/dids/issuer/did.jsonl");
    expect(didWebvhLogUrl(`did:webvh:${SCID}:example.com:a%20b`)).toBe("https://example.com/a%20b/did.jsonl");
  });

  test("rejects malformed identifiers", () => {
    for (const did of [
      "did:webvh:short:example.com",
      `did:webvh:${SCID}`,
      `did:webvh:${SCID}:localhost`,
      `did:webvh:${SCID}:127.0.0.1`,
      `did:webvh:${SCID}:[::1]`,
      `did:webvh:${SCID}:example.com%3A0`,
      `did:webvh:${SCID}:example.com%3A70000`,
      `did:webvh:${SCID}:example.com%3A80%3A81`,
      `did:webvh:${SCID}:exa%3Ample.com`,
      `did:webvh:${SCID}:example.com:..`,
      `did:webvh:${SCID}:example.com:a%2Fb`,
      `did:webvh:${SCID}:example.com:%20a`,
      `did:webvh:${SCID}:example.com:a%zz`,
      `did:webvh:${SCID}:bad_label.example.com`,
      `did:webvh:${SCID}:exämple.com`,
      `did:webvh:${SCID}:example.com/path`,
    ]) {
      expect(() => parseDidWebvh(did), did).toThrow();
    }
  });
});

describe("did:webvh resolution", () => {
  test("resolves didwebvh-ts output, with witnesses and the implicit services", async () => {
    const result = await resolve(fixture.did, { didLog: serializeLog(fixture.logA), didWitness: fixture.witnessA });
    expect(result.didResolutionMetadata.error).toBeUndefined();
    expect(result.didDocumentMetadata.versionId).toBe(fixture.logA[3].versionId);
    expect(result.didDocument?.alsoKnownAs).toEqual(["https://example.com/alice"]);
    const services = result.didDocument?.service as JsonObject[];
    expect(services.find((s) => s.id === `${fixture.did}#files`)?.serviceEndpoint).toBe("https://example.com/");
    expect(services.find((s) => s.id === `${fixture.did}#whois`)?.serviceEndpoint).toBe("https://example.com/whois.vp");
  });

  test("a deactivated did:webvh returns no document", async () => {
    const did = (fixture.logC[0].state as JsonObject).id as string;
    const result = await resolve(did, { didLog: fixture.logC });
    expect(result.didDocument).toBeNull();
    expect(result.didDocumentMetadata.deactivated).toBe(true);
  });

  test("the DID must match a state id in the log", async () => {
    const other = fixture.did.replace("example.com", "example.org");
    expect((await resolve(other, { didLog: fixture.logA, didWitness: fixture.witnessA })).didResolutionMetadata.error).toBe("invalidDid");
    expect((await resolve(`did:webvh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ:example.com`, { didLog: fixture.logA, didWitness: fixture.witnessA })).didResolutionMetadata.error).toBe("invalidDid");
  });

  test("resolves the independent didwebvh-ts logs shipped with the vh interop vectors", async () => {
    const dir = new URL("./fixtures/vh-interop/external/didwebvh-ts/", import.meta.url);
    const { scenarios } = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8")) as { scenarios: Array<{ name: string; witness: boolean }> };
    for (const sc of scenarios) {
      const log = readFileSync(new URL(`${sc.name}.jsonl`, dir), "utf8");
      const entries = log.trim().split("\n").map((l) => JSON.parse(l) as LogEntry);
      const did = (entries[entries.length - 1].state as JsonObject).id as string;
      const witness = sc.witness ? JSON.parse(readFileSync(new URL(`${sc.name}.witness.json`, dir), "utf8")) as unknown : undefined;
      const result = await resolve(did, { didLog: log, ...(witness ? { didWitness: witness } : {}), now: Date.parse("2026-10-19T00:00:00Z") });
      expect(result.didResolutionMetadata.error, sc.name).toBeUndefined();
      expect(result.didDocumentMetadata.versionId, sc.name).toBe(entries[entries.length - 1].versionId);
    }
  });
});

describe("did:webvh parameters and portability", () => {
  const key = localSigner("Ed25519", new Uint8Array(32).fill(9));
  const vm = `did:key:${key.publicKeyMultibase}#${key.publicKeyMultibase}`;
  const sign = signWith(key, { cryptosuite: "eddsa-jcs-2022", verificationMethod: vm });
  const genesis = (parameters: JsonObject = {}, id = "did:webvh:{SCID}:example.com") =>
    createLog({ versionTime: "2026-10-18T10:00:00Z", parameters: { method: "did:webvh:1.0", scid: "{SCID}", updateKeys: [key.publicKeyMultibase], ...parameters }, state: { id }, sign });
  const didOf = (e: LogEntry) => (e.state as JsonObject).id as string;
  const error = async (log: LogEntry[], did: string, versionNumber?: number) =>
    (await resolve(did, { didLog: log, ...(versionNumber ? { versionNumber } : {}) })).didResolutionMetadata;

  test("a move needs portable set at genesis and the prior DID in alsoKnownAs", async () => {
    const fixed = await genesis({ portable: false });
    const moved = (e: LogEntry, extra: JsonObject = {}) => appendEntry(e, {
      versionTime: "2026-10-18T10:00:01Z", parameters: {}, state: { id: didOf(e).replace("example.com", "example.org"), ...extra }, sign,
    });
    expect((await error([fixed, await moved(fixed, { alsoKnownAs: [didOf(fixed)] })], didOf(fixed), 2)).problemDetails?.code).toBe("WEBVH_NOT_PORTABLE");
    const portable = await genesis({ portable: true });
    expect((await error([portable, await moved(portable)], didOf(portable), 2)).problemDetails?.code).toBe("WEBVH_MOVE_ALSO_KNOWN_AS");
    const ok = await moved(portable, { alsoKnownAs: [didOf(portable)] });
    const result = await resolve(didOf(ok), { didLog: [portable, ok] });
    expect(result.didResolutionMetadata.error).toBeUndefined();
    const wrongScid = await appendEntry(portable, { versionTime: "2026-10-18T10:00:01Z", parameters: {}, state: { id: `did:webvh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ:example.org`, alsoKnownAs: [didOf(portable)] }, sign });
    expect((await error([portable, wrongScid], didOf(portable), 2)).problemDetails?.code).toBe("WEBVH_STATE_ID");
  });

  test("portable can only be enabled at genesis; logVersion and other methods are rejected", async () => {
    const one = await genesis();
    const later = await appendEntry(one, { versionTime: "2026-10-18T10:00:01Z", parameters: { portable: true }, state: one.state, sign });
    expect((await error([one, later], didOf(one), 2)).problemDetails?.code).toBe("WEBVH_PORTABLE_LATE");
    const logVersion = await genesis({ logVersion: "vh-log:1.0" });
    expect((await error([logVersion], didOf(logVersion))).problemDetails?.code).toBe("PARAMETER_UNKNOWN");
    const vh = await createLog({ versionTime: "2026-10-18T10:00:00Z", parameters: { method: "did:vh:1.0", scid: "{SCID}", updateKeys: [key.publicKeyMultibase] }, state: { id: "did:webvh:{SCID}:example.com" }, sign });
    expect((await error([vh], didOf(vh))).problemDetails?.code).toBe("VERSION_UNSUPPORTED");
    const badId = await genesis({}, "did:webvh:{SCID}:127.0.0.1");
    expect((await error([badId], `did:webvh:${badId.parameters.scid as string}:example.com`)).error).toBe("invalidDid");
  });
});
