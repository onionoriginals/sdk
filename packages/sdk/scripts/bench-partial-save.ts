/**
 * An app's save of version N+1 to a server that holds versions 1..N, the way
 * Easel did it by hand and with `omitResources` / `requireResources`:
 *
 *   bun scripts/bench-partial-save.ts [--versions 25,100] [--size 680000]
 *
 * Client: hand-rolled = package(did) (complete), then readEvidence and
 * writeEvidence without the held bytes; built-in = package(did, {omitResources}).
 * Server: hand-rolled = load(zip), resourceBytes for each left-out version, then
 * import(zip); built-in =
 * import(zip, { original, requireResources: true }).
 */
import { localSigner } from "@originals/vh/crypto";
import { createLog, serializeLog, signWith } from "@originals/vh/log";
import { MemoryStore, OriginalsSDK, keySigner, readEvidence, writeEvidence, type OriginalView } from "../src/originals/index.js";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SAMPLES = arg("versions", "25,100").split(",").map(Number);
const SIZE = Number(arg("size", "680000"));

function resource(n: number): Uint8Array {
  const out = new Uint8Array(SIZE);
  let x = (n * 2654435761) >>> 0 || 1;
  for (let i = 0; i < out.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 0xff; }
  return out;
}

async function author() {
  const update = localSigner("Ed25519", new Uint8Array(32).fill(5));
  const key = localSigner("Ed25519", new Uint8Array(32).fill(6));
  const k = update.publicKeyMultibase;
  const genesis = await createLog({
    versionTime: "2026-11-01T00:00:00Z",
    parameters: { method: "did:vh:1.0", scid: "{SCID}", updateKeys: [k] },
    state: { "@context": ["https://www.w3.org/ns/did/v1"], id: "did:vh:{SCID}", verificationMethod: [{ id: "did:vh:{SCID}#key-1", type: "Multikey", controller: "did:vh:{SCID}", publicKeyMultibase: key.publicKeyMultibase }], assertionMethod: ["did:vh:{SCID}#key-1"] },
    sign: signWith(update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` }),
  });
  const did = genesis.state.id as string;
  return { evidence: { did, log: serializeLog([genesis]) }, ref: { did, verificationMethod: `${did}#key-1`, versionId: genesis.versionId }, secret: new Uint8Array(32).fill(6) };
}

async function time<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t = performance.now();
  const v = await fn();
  return [performance.now() - t, v];
}

function handRolled(zip: Uint8Array, view: OriginalView, known: number): Uint8Array {
  const contents = readEvidence(zip);
  const keep = new Set(view.resources.filter((r) => r.version > known).map((r) => r.digest));
  for (const r of view.resources.filter((r) => r.version <= known && !keep.has(r.digest))) {
    delete contents.bytes[r.digest];
    contents.manifest.missing.push({ kind: "resource", version: r.version, digest: r.digest, versionId: r.versionId });
  }
  contents.manifest.completeness = "partial";
  return writeEvidence(contents);
}

const a = await author();
let now = Date.parse("2026-11-08T00:00:00Z");
const clock = () => (now += 1000);
const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [a.evidence], clock });
const signer = keySigner({ keyType: "Ed25519", secretKey: a.secret, verificationMethod: a.ref.verificationMethod });
const c = await sdk.create({ name: "bench", resource: { mediaType: "image/png", bytes: resource(1) }, author: a.ref, signer });
if (c.kind !== "original") throw new Error("no original");
let view = c.original;
console.log(`resource ${SIZE} bytes; ms`);
console.log(["versions", "client hand-rolled", "client built-in", "upload MB before", "upload MB after", "server load+check+import", "server import(requireResources)"].join("\t"));
for (const target of SAMPLES) {
  while (view.resources.length < target) view = (await sdk.edit(view.did, { parent: view.checkpoint, author: a.ref, resource: { bytes: resource(view.resources.length + 1) }, signer })).original;
  const known = target - 1;
  const [clientOld, oldZip] = await time(async () => handRolled((await sdk.package(view.did)).bytes, view, known));
  const [clientNew, newPkg] = await time(() => sdk.package(view.did, { omitResources: { throughVersion: known } }));
  const prefix = view.resources[known - 1].versionId;
  const held = async () => {
    const s = OriginalsSDK.create({ store: new MemoryStore(), authors: [a.evidence], clock });
    await s.import((await sdk.package(view.did, { checkpoint: prefix })).bytes);
    return s;
  };
  const s1 = await held();
  // As Easel's server did: load, check each left-out version is held (resourceBytes), then import.
  const [serverOld] = await time(async () => {
    const loaded = await s1.load(oldZip);
    for (const v of loaded.report.resources.versions) if (v.bytes !== "verified" && !(await s1.resourceBytes(v.digest))) throw new Error("missing");
    await s1.import(oldZip);
  });
  const s2 = await held();
  const [serverNew] = await time(() => s2.import(newPkg.bytes, { original: view.did, requireResources: true }));
  const full = (await sdk.package(view.did)).bytes.length;
  console.log([target, clientOld.toFixed(0), clientNew.toFixed(0), (full / 1e6).toFixed(1), (newPkg.bytes.length / 1e6).toFixed(1), serverOld.toFixed(0), serverNew.toFixed(0)].join("\t"));
}
