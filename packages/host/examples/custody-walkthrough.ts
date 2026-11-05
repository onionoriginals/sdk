/**
 * Custody walkthrough (issue #1024; plan 048 §2, §6, §8): devices and an agent
 * under one author, verified end to end. docs/CUSTODY_WALKTHROUGH.md pastes this
 * script's output and tests/custody-walkthrough.test.ts keeps it current.
 *
 *   cd packages/host && bun examples/custody-walkthrough.ts [--raw]
 *
 * Nothing here is new protocol surface. The devices and the agent use only the
 * public SDK (`@originals/sdk`, `@originals/sdk/originals`) and `@originals/vh`;
 * the shared host is this package's real server (`buildFetch` with the durable
 * Originals routes), answering in process on a temporary data directory.
 *
 * Output is labelled: every DID, versionId, digest and time is replaced by a
 * stable name (`<original>`, `<entry 2>`, `<time>`) so the transcript is the
 * same on every run. `--raw` prints the real values instead.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { base64 } from "@scure/base";
import { createDIDOriginal, prepareDIDDataForSigning, updateDIDOriginal, verifyDIDSignature } from "@originals/sdk";
import {
  MemoryStore,
  OriginalsSDK,
  hostedFiles,
  keySigner,
  signerPath,
  type HostAnswer,
  type OriginalsSigner,
  type SharedHost,
  type SubmitResult,
  type Submission,
} from "@originals/sdk/originals";
import { localSigner, multibaseEncode } from "@originals/vh/crypto";
import { createLog, serializeLog, signWith } from "@originals/vh/log";
import type { AuthorDidEvidence, AuthorRef, EditorGrant, EditorRef, OriginalsReport } from "@originals/vh/originals";
import { didWebvhFilesUrl } from "@originals/vh/webvh";
import { OriginalsError } from "@originals/vh";
import { buildFetch, createOriginalsRoutes, createOriginalsStore } from "../src/index.js";

const RAW = process.argv.includes("--raw");
const here = dirname(fileURLToPath(import.meta.url));
const enc = (s: string) => new TextEncoder().encode(s);
const svg = (shape: string) => enc(`<svg xmlns="http://www.w3.org/2000/svg">${shape}</svg>`);

// ------------------------------------------------------------------ output

const labels = new Map<string, string>();
function label(value: string, name: string): string {
  if (!labels.has(value)) labels.set(value, name);
  return value;
}
function redact(text: string): string {
  if (RAW) return text;
  let out = text;
  for (const [value, name] of [...labels].sort((a, b) => b[0].length - a[0].length)) out = out.split(value).join(name);
  return out.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>");
}
const print = (text = "") => process.stdout.write(`${redact(text)}\n`);
const step = (title: string) => print(`\n## ${title}\n`);
const show = (name: string, value: unknown) => print(`${name}: ${JSON.stringify(value, null, 2)}`);

/** The parts of a report this walkthrough reads, kept separate as section 7 requires. */
function summary(report: OriginalsReport) {
  return {
    history: report.history.status,
    entries: report.history.entries,
    authorBinding: report.authorBinding.status,
    identityEvidence: {
      status: report.identityEvidence.status,
      author: report.identityEvidence.author,
      latestVersionId: report.identityEvidence.latestVersionId,
      freshness: report.identityEvidence.freshness,
      editors: report.identityEvidence.editors.map((e) => ({ did: e.did, latestVersionId: e.latestVersionId, freshness: e.freshness })),
    },
    resources: report.resources.status,
    ordering: report.ordering,
    fork: report.fork,
    historicallyAuthorizedOnly: report.historicallyAuthorizedOnly,
    validAsOf: report.validAsOf ? { checkpoint: report.validAsOf.checkpoint, signers: report.validAsOf.signers.map((s) => ({ did: s.did, role: s.role, versionId: s.versionId })) } : null,
    current: report.current,
  };
}

/** Who signed each entry: the proof's verification method and the signer DID version it names. */
function signers(log: string) {
  return log.trimEnd().split("\n").map((line) => {
    const e = JSON.parse(line) as { versionId: string; state: { author: AuthorRef; editor?: EditorRef }; proof: Array<{ verificationMethod: string }> };
    const by = e.state.editor ?? e.state.author;
    return `${e.versionId}  ${e.state.editor ? "editor" : "author"}  ${e.proof[0].verificationMethod} @ ${by.versionId}`;
  });
}

/** The checkpoint of a save the walkthrough expects the host to accept; anything else stops the run. */
function acceptedAt(result: SubmitResult): string {
  if (result.status === "stale-parent") throw new Error(`expected the host to accept, got stale-parent at ${result.hostHead}`);
  return result.checkpoint;
}

/** The committed asset log a device holds. */
const logOf = async (s: MemoryStore) => (await s.get(did))?.log ?? "";

function refusal(error: unknown) {
  if (error instanceof OriginalsError) return { category: error.category, code: error.code, message: error.message };
  if (error instanceof HostRefused) return { http: error.status, body: error.body };
  throw error;
}

// ------------------------------------------------------------------ keys (fixed, so the run repeats)

const secret = (n: number) => new Uint8Array(32).fill(n);
const KEYS = {
  identity: secret(1), // the author did:webvh update key: administers the DID, never signs an entry (P5.11)
  device1: secret(2),
  device2: secret(3),
  agentUpdate: secret(4), // the agent did:vh's own update key
  agent: secret(5),
};
const pub = (k: Uint8Array) => localSigner("Ed25519", k).publicKeyMultibase;

/** A did:webvh signer for didwebvh-ts, through the SDK's wrappers. */
function webvhSigner(key: Uint8Array) {
  const signer = localSigner("Ed25519", key);
  return {
    async sign({ document, proof }: { document: Record<string, unknown>; proof: Record<string, unknown> }) {
      return { proofValue: multibaseEncode(await signer.sign(await prepareDIDDataForSigning(document, proof))) };
    },
    verify: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => verifyDIDSignature(signature, message, publicKey.length === 34 ? publicKey.slice(2) : publicKey),
    getVerificationMethodId: () => `did:key:${signer.publicKeyMultibase}`,
    getPublicKeyMultibase: () => signer.publicKeyMultibase,
  };
}

// ------------------------------------------------------------------ the host

const DOMAIN = "custody.example";
const SUB = "custody-walkthrough-owner";
const SLUG = `user-${SUB.slice(0, 16)}`;

class HostRefused extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`the host refused the save: ${status} ${JSON.stringify(body)}`);
  }
}

const dataDir = mkdtempSync(join(tmpdir(), "custody-walkthrough-"));
const work = mkdtempSync(join(tmpdir(), "custody-package-"));
label(work, "<tmp>");
process.on("exit", () => {
  for (const dir of [dataDir, work]) rmSync(dir, { recursive: true, force: true });
});
const store = createOriginalsStore({ dataDir });
const originalsRoutes = createOriginalsRoutes({ authenticate: () => SUB, store });
const noHostStore = { async handlePut() { return new Response(null, { status: 501 }); }, read() { return new Response(null, { status: 404 }); }, serve() { return null as Response | null; } };
const serve = buildFetch({ apiRoutes: null, hostStore: noHostStore, distDir: "/nonexistent/", originals: originalsRoutes });
const call = (path: string, init: RequestInit) => serve(new Request(`http://app.local${path}`, init));

/** The owner's upload (PUT), into their own namespace. */
async function upload(key: string, body: Uint8Array | string) {
  const res = await call(`/api/originals/host/${encodeURIComponent(key)}`, { method: "PUT", body });
  if (res.status !== 200) throw new Error(`upload of ${key} answered ${res.status} ${await res.text()}`);
}

/** A reader's HTTPS fetch of a hosted file, answered by the same server. */
async function read(url: string): Promise<Uint8Array> {
  const res = await serve(new Request(url.replace(/^https:/, "http:")));
  if (!res.ok) throw new OriginalsError("unavailable-bytes", "FETCH_STATUS", `${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** One device's client for the host's submit route (P6.7). Anything but 200 or 409 is an error, never an answer. */
function sharedHost(sdk: OriginalsSDK, aliasDid: string): SharedHost {
  const siteKey = didWebvhFilesUrl(aliasDid).slice("https://".length).replace(/\/$/, "");
  return {
    async submit(s: Submission): Promise<HostAnswer> {
      const body = JSON.stringify({
        original: s.original,
        entry: s.entry,
        resources: Object.fromEntries(Object.entries(s.resources).map(([d, b]) => [d, base64.encode(b)])),
        identities: s.identities.flatMap((i) => (typeof i.log === "string" ? [{ did: i.did, log: i.log, ...(i.witness !== undefined ? { witness: i.witness } : {}) }] : [])),
      });
      const res = await call(`/api/originals/submit/${encodeURIComponent(siteKey)}`, { method: "POST", headers: { "content-type": "application/json" }, body });
      const answer = (await res.json()) as HostAnswer;
      if (res.status === 200 || (res.status === 409 && answer.status === "stale-parent")) return answer;
      throw new HostRefused(res.status, answer);
    },
    accepted: () => sdk.retrieveHosted(aliasDid, read),
  };
}

// ------------------------------------------------------------------ the run

// Real time, strictly increasing: didwebvh-ts stamps author DID versions with the real time, and an
// entry can only name a version that exists at its own time.
let t = 0;
const clock = () => (t = Math.max(Date.now(), t + 1));

/** What one party knows of each signer DID: its own copy, updated only when it is told. */
function knowledge() {
  const known = new Map<string, AuthorDidEvidence>();
  return { known, authors: (did: string) => Promise.resolve(known.get(did)) };
}

step("1. The author: one did:webvh, an update key that never signs entries, one assertionMethod key per device");

const identity = webvhSigner(KEYS.identity);
const keyZero = { id: "#key-0", type: "Multikey" as const, publicKeyMultibase: pub(KEYS.identity) };
const device = (n: 1 | 2) => ({ id: `#device-${n}`, type: "Multikey" as const, publicKeyMultibase: pub(n === 1 ? KEYS.device1 : KEYS.device2) });
const v1 = await createDIDOriginal({
  type: "did",
  domain: DOMAIN,
  paths: [SLUG],
  signer: identity,
  verifier: identity,
  updateKeys: [identity.getVerificationMethodId()],
  verificationMethods: [keyZero, device(1)],
  authentication: ["#key-0"],
  assertionMethod: ["#device-1"],
  portable: false,
});
const authorDid = label(v1.did, "<author>");
let authorLog = v1.log as unknown as Array<Record<string, unknown>>;
const versionOf = () => authorLog[authorLog.length - 1].versionId as string;
const authorEvidence = (): AuthorDidEvidence => ({ did: authorDid, log: serializeLog(authorLog as never) });
const v1Id = label(versionOf(), "<author v1>");

/** An author DID update by the identity key alone: no asset entry follows it (P5.10). */
async function updateAuthor(assertion: Array<1 | 2>, name: string) {
  const r = await updateDIDOriginal({
    type: "did",
    log: authorLog as never,
    signer: identity,
    verifier: identity,
    verificationMethods: [keyZero, ...assertion.map(device)],
    authentication: ["#key-0"],
    assertionMethod: assertion.map((n) => `#device-${n}`),
  } as never);
  authorLog = r.log as unknown as Array<Record<string, unknown>>;
  return label(versionOf(), name);
}

const v2Id = await updateAuthor([1, 2], "<author v2>");
const doc = (v: number) => authorLog[v - 1].state as { assertionMethod: string[]; authentication: string[] };
const params = authorLog[0].parameters as { updateKeys: string[] };
label(pub(KEYS.identity), "<identity key>");
show("author DID", {
  did: authorDid,
  updateKeys: params.updateKeys.map((k) => (k === pub(KEYS.identity) ? `${k} (#key-0)` : k)),
  [v1Id]: { authentication: doc(1).authentication, assertionMethod: doc(1).assertionMethod },
  [v2Id]: { authentication: doc(2).authentication, assertionMethod: doc(2).assertionMethod },
});

const ref = (n: 1 | 2, versionId: string): AuthorRef => ({ did: authorDid, verificationMethod: `${authorDid}#device-${n}`, versionId });
const deviceSigner = (n: 1 | 2): OriginalsSigner => keySigner({ keyType: "Ed25519", secretKey: n === 1 ? KEYS.device1 : KEYS.device2, verificationMethod: `${authorDid}#device-${n}` });

step("2. Genesis by device 1, then a seal by device 2 naming the newer author version; no asset-log rotation");

const k1 = knowledge();
k1.known.set(authorDid, authorEvidence());
const store1 = new MemoryStore();
const device1 = OriginalsSDK.create({ store: store1, authors: k1.authors, clock });
const SVG1 = svg('<circle r="4"/>');
const created = await device1.create({ name: "Harbor at dawn", resource: { mediaType: "image/svg+xml", bytes: SVG1 }, author: ref(1, v1Id), signer: deviceSigner(1) });
if (created.kind !== "original") throw new Error("expected an Original");
const did = label(created.original.did, "<original>");
label(created.original.checkpoint, "<entry 1>");

// The identity key administers the author DID only. Named as an entry's signer, it is refused (P5.3, P5.11).
try {
  const asIdentity: AuthorRef = { did: authorDid, verificationMethod: `${authorDid}#key-0`, versionId: v2Id };
  const draft = await device1.prepareEdit(did, { parent: created.original.checkpoint, name: "Harbor, by the identity key", author: asIdentity });
  await device1.commit(draft, keySigner({ keyType: "Ed25519", secretKey: KEYS.identity, verificationMethod: asIdentity.verificationMethod }));
  print("an entry signed by the identity key: committed (unexpected)");
} catch (error) {
  show("an entry signed by the identity key (#key-0) is refused", refusal(error));
}

// Device 2 gets the Original from device 1 as an evidence package.
const k2 = knowledge();
k2.known.set(authorDid, authorEvidence());
const device2 = OriginalsSDK.create({ store: new MemoryStore(), authors: k2.authors, clock });
print(`device 2 imports device 1's package: ${(await device2.import((await device1.package(did)).bytes)).status}`);

// The seal: publishing this version to the web is an ordinary author entry listing the alias (P3.6; plan 048 §6).
// The alias did:webvh is administered by the identity key, like the author DID; it never signs an asset entry.
const aliasResult = await createDIDOriginal({
  type: "did",
  domain: DOMAIN,
  paths: [SLUG, `o-${did.slice("did:vh:".length, "did:vh:".length + 16)}`],
  signer: identity,
  verifier: identity,
  updateKeys: [identity.getVerificationMethodId()],
  verificationMethods: [keyZero],
  authentication: ["#key-0"],
  portable: true,
  alsoKnownAs: [did],
});
const alias = { did: label(aliasResult.did, "<alias>"), log: serializeLog(aliasResult.log as never) };
const seal = await device2.publish(did, { parent: (await device2.get(did)).checkpoint, author: ref(2, v2Id), signer: deviceSigner(2), alias });
label(seal.original.checkpoint, "<entry 2>");

// Upload the hosted snapshot to the owner's namespace: alias log, asset log, then the rest (hosted-layout.ts).
const base = didWebvhFilesUrl(alias.did).slice("https://".length);
label(base.replace(/\/$/, ""), "<site>");
const rank = (p: string) => (!p.startsWith("originals/") ? 0 : p === "originals/asset/did.jsonl" ? 1 : p.startsWith("originals/resources/") ? 3 : 2);
for (const [path, bytes] of [...(await hostedFiles(device2, did, alias))].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))) await upload(`${base}${path}`, bytes);
const host1 = sharedHost(device1, alias.did);
const host2 = sharedHost(device2, alias.did);

print(`device 1 syncs from the host: ${(await device1.sync(did, host1)).status}`);
const afterSeal = await device1.get(did);
print("entries (versionId, role, proof verificationMethod @ the signer DID version it names):");
for (const line of signers(await logOf(store1))) print(`  ${line}`);
show("device 1's report", summary(afterSeal.report));

step("3. An agent with its own did:vh and an editor grant; then the grant removed");

// The agent's DID: a did:vh of its own, with its own update key and one assertionMethod key (P5.15).
const agentUpdate = localSigner("Ed25519", KEYS.agentUpdate);
const agentGenesis = await createLog({
  versionTime: new Date(clock()).toISOString().replace(/\.\d{3}Z$/, "Z"),
  parameters: { method: "did:vh:1.0", scid: "{SCID}", updateKeys: [agentUpdate.publicKeyMultibase] },
  state: {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    id: "did:vh:{SCID}",
    verificationMethod: [{ id: "did:vh:{SCID}#agent", type: "Multikey", controller: "did:vh:{SCID}", publicKeyMultibase: pub(KEYS.agent) }],
    assertionMethod: ["did:vh:{SCID}#agent"],
  },
  sign: signWith(agentUpdate, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${agentUpdate.publicKeyMultibase}#${agentUpdate.publicKeyMultibase}` }),
});
const agentDid = label(agentGenesis.state.id as string, "<agent>");
label(agentGenesis.versionId, "<agent v1>");
const agentEvidence: AuthorDidEvidence = { did: agentDid, log: serializeLog([agentGenesis]) };
const agentRef: EditorRef = { did: agentDid, verificationMethod: `${agentDid}#agent`, versionId: agentGenesis.versionId };
const agentSigner = keySigner({ keyType: "Ed25519", secretKey: KEYS.agent, verificationMethod: agentRef.verificationMethod });

// Device 1 grants the agent new versions of the resource only (P5.15): an author entry, saved through the host.
k1.known.set(agentDid, agentEvidence);
const grant: EditorGrant = { did: agentDid, name: false, metadata: false, resource: true };
const granted = await device1.submit(await device1.sign(await device1.prepareEdit(did, { parent: (await device1.get(did)).checkpoint, editors: [grant], author: ref(1, v2Id) }), deviceSigner(1)), host1);
label(acceptedAt(granted), "<entry 3>");
show("device 1 grants the agent (author entry)", { status: granted.status, grant });

// The agent reads the Original from the host and signs a new resource version as an editor (P5.16).
const ka = knowledge();
ka.known.set(authorDid, authorEvidence());
ka.known.set(agentDid, agentEvidence);
const storeA = new MemoryStore();
const agent = OriginalsSDK.create({ store: storeA, authors: ka.authors, clock });
const hostA = sharedHost(agent, alias.did);
print(`agent syncs from the host: ${(await agent.sync(did, hostA)).status}`);
const SVG3 = svg('<circle r="4" fill="navy"/>');
const editorDraft = await agent.prepareEdit(did, { parent: (await agent.get(did)).checkpoint, resource: { bytes: SVG3 }, editor: agentRef });
print(`what the agent's signer is shown: ${editorDraft.display}`);
const edited = await agent.submit(await agent.sign(editorDraft, agentSigner), hostA);
label(acceptedAt(edited), "<entry 4>");
print(`agent's editor entry: ${edited.status}`);

// Device 1 removes every grant (P5.17): from the next entry on, the agent has none.
await device1.sync(did, host1);
const revoked = await device1.submit(await device1.sign(await device1.prepareEdit(did, { parent: (await device1.get(did)).checkpoint, editors: null, author: ref(1, v2Id) }), deviceSigner(1)), host1);
label(acceptedAt(revoked), "<entry 5>");
print(`device 1 removes the grant (author entry): ${revoked.status}`);

await agent.sync(did, hostA);
try {
  await agent.prepareEdit(did, { parent: (await agent.get(did)).checkpoint, resource: { bytes: svg('<circle r="5"/>') }, editor: agentRef });
  print("agent's further entry: prepared (unexpected)");
} catch (error) {
  show("agent's further entry is refused before anything is signed", refusal(error));
}
const afterAgent = await agent.get(did);
print("entries:");
for (const line of signers(await logOf(storeA))) print(`  ${line}`);
show("the agent's report after the revocation", { authorBinding: afterAgent.report.authorBinding.status, editors: summary(afterAgent.report).identityEvidence.editors, historicallyAuthorizedOnly: afterAgent.report.historicallyAuthorizedOnly, validAsOf: summary(afterAgent.report).validAsOf?.checkpoint });

step("4. Device 2's key removed from the author DID; its offline entry refused by the host, re-signed by device 1");

// Device 2 last synced before the revocation, then went offline.
await device2.sync(did, host2);
const v3Id = await updateAuthor([1], "<author v3>");
show("author DID", { [v3Id]: { assertionMethod: doc(3).assertionMethod } });
k1.known.set(authorDid, authorEvidence());
// The owner sends the newer author DID log to the host, so it refuses entries that log makes historical (P7.8).
await upload(`${base}originals/${signerPath(authorDid)}/did.jsonl`, authorEvidence().log as string);
print("the owner uploads the author DID log through v3 to the host");

// Device 1, holding v3, reads the host: the seal is still part of a valid checkpoint, historically authorized only.
print(`device 1 syncs from the host: ${(await device1.sync(did, host1)).status}`);
show("device 1's report", summary((await device1.get(did)).report));

// Device 2, still holding v2, signs an entry offline with its removed key and submits it once back online.
const SVG6 = svg('<circle r="4" fill="teal"/>');
const offline = await device2.sign(await device2.prepareEdit(did, { parent: (await device2.get(did)).checkpoint, resource: { bytes: SVG6 }, author: ref(2, v2Id) }), deviceSigner(2));
label(offline.versionId, "<device 2's offline entry>");
print(`device 2 signs offline against ${offline.parent}: ${offline.versionId}`);
try {
  const answer = await device2.submit(offline, host2);
  show("device 2 submits (unexpected answer)", answer);
} catch (error) {
  show("the host refuses device 2's entry", refusal(error));
}
show("device 2 afterwards", {
  refused: (await device2.refused(did)).map((r) => r.versionId),
  pending: (await device2.pending(did))?.versionId ?? null,
  localHead: (await device2.get(did)).checkpoint,
});

// Device 2 hands its change (the bytes) to device 1, which re-signs it against the host's head with a current key.
const reconciled = await device1.reconcile(did, { host: host1, author: ref(1, v3Id), signer: deviceSigner(1), change: { resource: { bytes: SVG6 } } });
label(acceptedAt(reconciled), "<entry 6>");
show("device 1 reconciles", { status: reconciled.status, checkpoint: acceptedAt(reconciled) });
print("entries:");
for (const line of signers(await logOf(store1))) print(`  ${line}`);

step("5. Package the evidence; load it in a fresh process with no key and no network");

const final = await device1.package(did);
const zipPath = join(work, "custody.zip");
writeFileSync(zipPath, final.bytes);
print(`device 1 writes ${zipPath} (${final.manifest.completeness}, checkpoint ${final.manifest.checkpoint})`);
// No secret, in any encoding the walkthrough uses, is in the package.
const zipText = Buffer.from(final.bytes).toString("latin1");
const leaked = Object.entries(KEYS).filter(([, k]) => [Buffer.from(k).toString("hex"), Buffer.from(k).toString("base64"), multibaseEncode(k)].some((s) => zipText.includes(s)) || Buffer.from(final.bytes).includes(Buffer.from(k)));
print(`secret keys in the package: ${leaked.length === 0 ? "none" : leaked.map(([n]) => n).join(", ")}`);

const sdkDir = dirname(createRequire(import.meta.url).resolve("@originals/sdk/package.json"));
const cli = join(sdkDir, "dist/originals/cli.js");
const preload = join(here, "no-network.mjs");
for (const args of [["verify", zipPath], ["verify", zipPath, "--json"]]) {
  print(`\n$ node --import ./no-network.mjs originals ${args.map((a) => (a === zipPath ? "custody.zip" : a)).join(" ")}`);
  const r = spawnSync("node", ["--import", preload, cli, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  if (r.error) throw new Error(`step 5 runs the SDK's CLI with node, which could not be started: ${r.error.message}`);
  const out = args.includes("--json") ? JSON.stringify(pickJson(JSON.parse(r.stdout)), null, 2) : r.stdout.trimEnd();
  print(out);
  if (r.stderr.trim()) print(`stderr: ${r.stderr.trim()}`);
  print(`exit ${r.status}`);
}

function pickJson(j: OriginalsReport & { verified: boolean; reasons: string[] }) {
  return { verified: j.verified, ...summary(j), reasons: j.reasons };
}

