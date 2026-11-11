/**
 * Repeatable benchmark of the Originals workflow (create, prepareEdit, sign,
 * commit, get, package, load, import) as an Original's history grows.
 *
 *   bun scripts/bench-originals.ts [--versions 1,25,100] [--size 680000] [--json out.json]
 *
 * One Original is built with an author whose DID is a did:webvh written by
 * didwebvh-ts (the shape originals.build mints). Each edit is a new resource
 * version of `--size` incompressible bytes (a PNG is near enough
 * incompressible). At each sample point every operation is timed `--repeat`
 * times and the median is reported, except the edit that reaches it: an edit
 * adds a version, so it runs once, and `commit` is that edit less the
 * prepareEdit and sign medians. Nothing here touches the network.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { localSigner, multibaseEncode } from "@originals/vh/crypto";
import { serializeLog, type LogEntry } from "@originals/vh/log";
import * as W from "didwebvh-ts";
import { MemoryStore, OriginalsSDK, keySigner, type OriginalsSigner, type SigningRequest } from "../src/originals/index.js";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SAMPLES = arg("versions", "1,25,100").split(",").map(Number).sort((a, b) => a - b);
const SIZE = Number(arg("size", "680000"));
const REPEAT = Number(arg("repeat", "3"));
const JSON_OUT = arg("json", "");

/** Deterministic incompressible bytes (xorshift), different per version. */
function resource(n: number): Uint8Array {
  const out = new Uint8Array(SIZE);
  let x = (n * 2654435761) >>> 0 || 1;
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

const seed = (n: number) => new Uint8Array(32).fill(n);

/** A did:webvh author: #key-0 is the update key, #key-1 the authorship key (as originals.build mints). */
async function webvhAuthor() {
  const update = localSigner("Ed25519", seed(7));
  const author = localSigner("Ed25519", seed(8));
  const k = update.publicKeyMultibase;
  const signer = {
    getVerificationMethodId: () => `did:key:${k}#${k}`,
    sign: async ({ document, proof }: { document: Record<string, unknown>; proof: Record<string, unknown> }) =>
      ({ proofValue: multibaseEncode(await update.sign(await W.prepareDataForSigning(document, proof))) }),
  };
  const verifier = { verify: (s: Uint8Array, m: Uint8Array, p: Uint8Array) => Promise.resolve(ed25519.verify(s, m, p)) };
  const vm = [
    { id: "#key-0", type: "Multikey", controller: "{DID}", publicKeyMultibase: update.publicKeyMultibase },
    { id: "#key-1", type: "Multikey", controller: "{DID}", publicKeyMultibase: author.publicKeyMultibase },
  ];
  const created = await W.createDID({
    address: "bench.example", paths: ["user-0123456789abcdef"], signer, verifier, updateKeys: [k], portable: true, created: "2026-11-01T00:00:00Z",
    didDocument: { "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"], id: "{DID}", controller: "{DID}", verificationMethod: vm, authentication: ["#key-0"], assertionMethod: ["#key-1"] } as never,
  });
  const log = created.log as unknown as LogEntry[];
  const did = created.did;
  const versionId = log[log.length - 1].versionId;
  const ref = { did, verificationMethod: `${did}#key-1`, versionId };
  return { evidence: { did, log: serializeLog(log), obtainedAt: "2026-11-01T00:00:00Z" }, ref, secret: seed(8) };
}

/** Wraps a signer to count round trips (a remote signer pays one per call). */
function counting(inner: OriginalsSigner) {
  let calls = 0;
  const s: OriginalsSigner & { calls: () => number } = {
    verificationMethod: inner.verificationMethod,
    cryptosuite: inner.cryptosuite,
    sign: (r: SigningRequest) => { calls++; return inner.sign(r); },
    calls: () => calls,
  };
  return s;
}

async function time<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t = performance.now();
  const v = await fn();
  return [performance.now() - t, v];
}

/** The median of `n` timed runs of `fn`, each after an untimed `setup`. */
async function median<S>(fn: (s: S) => Promise<unknown>, setup: () => Promise<S> = async () => undefined as S, n = REPEAT): Promise<number> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = await setup();
    out.push((await time(() => fn(s)))[0]);
  }
  out.sort((a, b) => a - b);
  return out[Math.floor(out.length / 2)];
}

const fmt = (ms: number) => (ms < 10 ? ms.toFixed(1) : Math.round(ms).toString());

async function main() {
  const author = await webvhAuthor();
  let now = Date.parse("2026-11-08T00:00:00Z");
  const clock = () => (now += 1000);
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: [author.evidence], clock });
  const signer = counting(keySigner({ keyType: "Ed25519", secretKey: author.secret, verificationMethod: author.ref.verificationMethod }));

  const [createMs, created] = await time(() => sdk.create({ name: "bench", resource: { mediaType: "image/png", bytes: resource(1) }, author: author.ref, signer }));
  if (created.kind !== "original") throw new Error("create did not sign");
  const did = created.original.did;
  let head = created.original.checkpoint;
  let versions = 1;
  const rows: Array<Record<string, number>> = [];
  console.log(`resource ${SIZE} bytes; samples at ${SAMPLES.join(", ")} versions; median of ${REPEAT}, except edit and commit (one run: an edit adds a version)`);
  console.log(`create (1 version): ${fmt(createMs)} ms`);
  const header = ["versions", "edit(1 run)", "prepareEdit", "sign", "commit(derived)", "get", "package", "pkgMB", "load", "import(new)", "import(+1)", "signer calls/edit"];
  console.log(header.join("\t"));

  const edit = async () => {
    versions++;
    const before = signer.calls();
    const r = await sdk.edit(did, { parent: head, author: author.ref, resource: { bytes: resource(versions) }, signer });
    head = r.original.checkpoint;
    return signer.calls() - before;
  };

  for (const target of SAMPLES) {
    while (versions < target - 1) await edit();
    // The edit that reaches `target`, timed, split into its parts.
    let editMs = 0, prepMs = 0, signMs = 0, commitMs = 0, calls = 0; // commit = edit - median prepareEdit - median sign
    if (target > 1) {
      versions++;
      const bytes = resource(versions);
      // prepareEdit and sign on their own, medians (neither stores anything), then the full edit an app makes, once.
      let draft!: Awaited<ReturnType<typeof sdk.prepareEdit>>;
      const p = await median(async () => { draft = await sdk.prepareEdit(did, { parent: head, author: author.ref, resource: { bytes } }); });
      const s = await median(() => sdk.sign(draft, signer));
      const before = signer.calls();
      const [e, r] = await time(() => sdk.edit(did, { parent: head, author: author.ref, resource: { bytes }, signer }));
      editMs = e; prepMs = p; signMs = s; commitMs = Math.max(0, e - p - s);
      head = r.original.checkpoint;
      calls = signer.calls() - before;
    }
    const getMs = await median(() => sdk.get(did));
    let pkg!: Uint8Array;
    const packageMs = await median(async () => { pkg = (await sdk.package(did)).bytes; });
    const loadMs = await median(() => sdk.load(pkg));
    // Server side: a fresh store importing the whole package, and a store one version behind importing the next.
    const importNewMs = await median(async () => {
      const server = OriginalsSDK.create({ store: new MemoryStore(), authors: [author.evidence], clock });
      await server.import(pkg);
    });
    let importNextMs = NaN;
    if (target > 1) {
      // A store holding everything but the newest entry (set up untimed, afresh for each run) imports the newest package.
      const log = await sdk.committedLog(did);
      const prefixHead = log.trimEnd().split("\n").slice(-2, -1)[0];
      const prefix = (JSON.parse(prefixHead) as { versionId: string }).versionId;
      const prefixPkg = (await sdk.package(did, { checkpoint: prefix })).bytes;
      importNextMs = await median((behind) => behind.import(pkg), async () => {
        const behind = OriginalsSDK.create({ store: new MemoryStore(), authors: [author.evidence], clock });
        await behind.import(prefixPkg).catch(() => undefined);
        return behind;
      });
    }
    const row = { versions: target, edit: editMs, prepareEdit: prepMs, sign: signMs, commit: commitMs, get: getMs, package: packageMs, pkgMB: pkg.length / 1e6, load: loadMs, importNew: importNewMs, importNext: importNextMs, signerCalls: calls };
    rows.push(row);
    console.log([target, fmt(editMs), fmt(prepMs), fmt(signMs), fmt(commitMs), fmt(getMs), fmt(packageMs), row.pkgMB.toFixed(1), fmt(loadMs), fmt(importNewMs), fmt(importNextMs), calls].join("\t"));
  }
  if (JSON_OUT) await Bun.write(JSON_OUT, JSON.stringify({ size: SIZE, repeat: REPEAT, createMs, rows }, null, 2));
}

await main();
