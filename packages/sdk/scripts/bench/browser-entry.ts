/**
 * The browser half of `scripts/bench-browser.ts`: the same workflow as
 * `bench-originals.ts`, bundled for the browser and run in headless Chromium.
 * The author is a did:vh (no didwebvh-ts in the bundle). Results go to
 * `window.__bench`.
 */
import { localSigner } from "@originals/vh/crypto";
import { createLog, serializeLog, signWith } from "@originals/vh/log";
import { MemoryStore, OriginalsSDK, keySigner } from "../../src/originals/index.js";

const params = new URLSearchParams(location.search);
const SAMPLES = (params.get("versions") ?? "1,25,100").split(",").map(Number);
const SIZE = Number(params.get("size") ?? "680000");

function resource(n: number): Uint8Array {
  const out = new Uint8Array(SIZE);
  let x = (n * 2654435761) >>> 0 || 1;
  for (let i = 0; i < out.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 0xff; }
  return out;
}

async function median(fn: () => Promise<unknown>, n = 3): Promise<number> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); out.push(performance.now() - t); }
  return out.sort((a, b) => a - b)[Math.floor(n / 2)];
}

async function run() {
  const update = localSigner("Ed25519", new Uint8Array(32).fill(5));
  const key = localSigner("Ed25519", new Uint8Array(32).fill(6));
  const k = update.publicKeyMultibase;
  const genesis = await createLog({
    versionTime: "2026-11-01T00:00:00Z",
    parameters: { method: "did:vh:1.0", scid: "{SCID}", updateKeys: [k] },
    state: { "@context": ["https://www.w3.org/ns/did/v1"], id: "did:vh:{SCID}", verificationMethod: [{ id: "did:vh:{SCID}#key-1", type: "Multikey", controller: "did:vh:{SCID}", publicKeyMultibase: key.publicKeyMultibase }], assertionMethod: ["did:vh:{SCID}#key-1"] },
    sign: signWith(update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` }),
  });
  const did0 = genesis.state.id as string;
  const evidence = { did: did0, log: serializeLog([genesis]) };
  const ref = { did: did0, verificationMethod: `${did0}#key-1`, versionId: genesis.versionId };
  let now = Date.parse("2026-11-08T00:00:00Z");
  const clock = () => (now += 1000);
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [evidence], clock });
  const signer = keySigner({ keyType: "Ed25519", secretKey: new Uint8Array(32).fill(6), verificationMethod: ref.verificationMethod });
  const c = await sdk.create({ name: "bench", resource: { mediaType: "image/png", bytes: resource(1) }, author: ref, signer });
  if (c.kind !== "original") throw new Error("no original");
  let view = c.original;
  const rows: Array<Record<string, number>> = [];
  for (const target of SAMPLES) {
    while (view.resources.length < target - 1) view = (await sdk.edit(view.did, { parent: view.checkpoint, author: ref, resource: { bytes: resource(view.resources.length + 1) }, signer })).original;
    let edit = NaN;
    if (target > 1) {
      const bytes = resource(target);
      const t = performance.now();
      view = (await sdk.edit(view.did, { parent: view.checkpoint, author: ref, resource: { bytes }, signer })).original;
      edit = performance.now() - t;
    }
    const get = await median(() => sdk.get(view.did));
    let pkg!: Uint8Array;
    const pack = await median(async () => { pkg = (await sdk.package(view.did)).bytes; });
    const load = await median(() => sdk.load(pkg));
    const importNew = await median(() => OriginalsSDK.create({ store: new MemoryStore(), authors: [evidence], clock }).import(pkg));
    rows.push({ versions: target, edit, get, package: pack, load, importNew });
  }
  return rows;
}

(window as unknown as { __bench: Promise<unknown> }).__bench = run().catch((e: unknown) => ({ error: String((e as Error)?.stack ?? e) }));
