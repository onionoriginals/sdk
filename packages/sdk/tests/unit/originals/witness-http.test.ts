/**
 * Witnesses over HTTP (plan 011, PR 8a): the client and the request handler
 * speak the PROVISIONAL originals-witness/0.1 protocol, refusals keep their
 * spec section 6 category and code, and the ledger survives a restart.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginalsError } from "@originals/vh";
import { localSigner } from "@originals/vh/crypto";
import { FileWitnessLedger } from "../../../src/originals/fs-store.js";
import {
  MemoryStore,
  OriginalsSDK,
  OriginalsWitness,
  fetchWebvhEvidence,
  httpWitnessClient,
  witnessHandler,
  type WitnessLedger,
} from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(21);
const SEEDS = [31, 32, 33];

/** A fetch that routes each witness URL to its handler, as a network would. */
function network(handlers: Map<string, (r: Request) => Promise<Response>>): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const handler = handlers.get(new URL(request.url).origin);
    return handler ? handler(request) : Promise.reject(new TypeError("connection refused"));
  }) as typeof fetch;
}

async function setup(ledgers?: WitnessLedger[]) {
  const ids = SEEDS.map((n) => `did:key:${localSigner("Ed25519", seed(n)).publicKeyMultibase}`);
  const alice = await Author.create([{ fragment: "orig", secret: KEY }], { threshold: 2, witnesses: ids.map((id) => ({ id })) });
  let time = Date.parse("2026-10-18T12:00:00Z");
  const now = clock();
  const tick = () => (time = now());
  const handlers = new Map<string, (r: Request) => Promise<Response>>();
  const clients = SEEDS.map((n, i) => {
    const witness = OriginalsWitness.create({
      secretKey: seed(n),
      authors: async () => ({ evidence: alice.evidence(), retrievedAt: time }),
      clock: () => time,
      ...(ledgers ? { ledger: ledgers[i] } : {}),
    });
    const origin = `https://w${i + 1}.example`;
    handlers.set(origin, witnessHandler(witness));
    return httpWitnessClient({ id: witness.id, endpoint: `${origin}/witness`, fetch: network(handlers) });
  });
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: tick, witnesses: clients });
  const signer = alice.signer("orig", KEY);
  const c = await sdk.create({ name: "Harbor", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("one") }], author: alice.ref("orig"), signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  return { alice, sdk, signer, clients, handlers, tick, time: () => time, did: c.original.did, v1: c.original.checkpoint };
}

describe("witnesses over HTTP (originals-witness/0.1, PROVISIONAL)", () => {
  test("a witnessed commit collects approvals through the HTTP client and handler", async () => {
    const { sdk, alice, signer, did, v1 } = await setup();
    const r = await sdk.activateWitnesses(did, { parent: v1, author: alice.ref("orig"), signer });
    expect(r.original.report.ordering).toBe("witnessed");
    expect(r.original.current).toBe(true);
  });

  test("a refusal keeps its category and code across HTTP", async () => {
    const { sdk, alice, signer, did, v1 } = await setup();
    const activated = await sdk.activateWitnesses(did, { parent: v1, author: alice.ref("orig"), signer });
    await alice.deactivate();
    const error = await sdk.edit(did, { parent: activated.original.checkpoint, name: "x", author: alice.ref("orig"), signer }).catch((e: unknown) => e);
    const refusals = ((error as OriginalsError).details as { refusals: Array<{ category: string; code: string }> }).refusals;
    expect(refusals[0]).toMatchObject({ category: "deactivated", code: "AUTHOR_DEACTIVATED" });
  });

  test("the handler announces its witness id and refuses malformed or oversized requests", async () => {
    const { handlers, clients } = await setup();
    const handler = handlers.get("https://w1.example")!;
    const info = await handler(new Request("https://w1.example/witness"));
    expect(await info.json()).toEqual({ protocol: "originals-witness/0.1", id: clients[0].id });
    const bad = await handler(new Request("https://w1.example/witness", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("REQUEST_INVALID");
    const shape = await handler(new Request("https://w1.example/witness", { method: "POST", body: JSON.stringify({ original: 1 }) }));
    expect(shape.status).toBe(400);
    const big = await witnessHandler(OriginalsWitness.create({ secretKey: seed(31), authors: async () => undefined }), { maxBodyBytes: 10 })(
      new Request("https://w1.example/witness", { method: "POST", body: JSON.stringify({ original: "did:vh:x", log: "", witness: [] }) }),
    );
    expect(big.status).toBe(413);
    expect((await handler(new Request("https://w1.example/witness", { method: "PUT", body: "" }))).status).toBe(405);
  });

  test("an unreachable witness is a refusal, never an approval", async () => {
    const { alice, did, v1, signer, handlers, sdk } = await setup();
    handlers.delete("https://w1.example");
    handlers.delete("https://w2.example");
    const error = await sdk.activateWitnesses(did, { parent: v1, author: alice.ref("orig"), signer }).catch((e: unknown) => e);
    expect((error as OriginalsError).code).toBe("WITNESS_APPROVALS_INSUFFICIENT");
    const codes = ((error as OriginalsError).details as { refusals: Array<{ code: string }> }).refusals.map((r) => r.code);
    expect(codes).toContain("WITNESS_UNREACHABLE");
  });

  test("a proof signed by another key than the witness's id is rejected by the client", async () => {
    const impostor = OriginalsWitness.create({ secretKey: seed(99), authors: async () => undefined });
    const fake = network(new Map([["https://w1.example", (r: Request) => (r.method === "GET" ? witnessHandler(impostor)(r) : Promise.resolve(Response.json({ proof: { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", verificationMethod: `${impostor.id}#x`, proofPurpose: "assertionMethod", proofValue: "z1" } })))]]));
    const client = httpWitnessClient({ id: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", endpoint: "https://w1.example/witness", fetch: fake });
    const error = await client.approve({ original: "did:vh:x", log: "", witness: [] }).catch((e: unknown) => e);
    expect((error as OriginalsError).code).toBe("WITNESS_PROOF_MISMATCH");
  });
});

describe("FileWitnessLedger (P9.8)", () => {
  test("C12-42: the last approval survives a restart, so a sibling is still refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "originals-ledger-"));
    try {
      const open = () => Promise.all(SEEDS.map((_, i) => FileWitnessLedger.open(join(dir, `w${i}`))));
      const first = await setup(await open());
      const activated = await first.sdk.activateWitnesses(first.did, { parent: first.v1, author: first.alice.ref("orig"), signer: first.signer });
      const pkg = await first.sdk.package(first.did);
      await first.sdk.edit(first.did, { parent: activated.original.checkpoint, name: "Approved first", author: first.alice.ref("orig"), signer: first.signer });
      // The witnesses restart with their ledgers; another copy builds a sibling of the approved entry.
      const reopened = await open();
      const ledgerIds = await reopened[0].get(first.did);
      expect(ledgerIds?.length).toBe(3);
      const elsewhere = OriginalsSDK.create({
        store: new MemoryStore(), authors: async () => first.alice.evidence(), freshness: "asserted", clock: first.tick,
        witnesses: SEEDS.map((n, i) => OriginalsWitness.create({ secretKey: seed(n), authors: async () => ({ evidence: first.alice.evidence(), retrievedAt: first.time() }), clock: first.time, ledger: reopened[i] })),
      });
      await elsewhere.import(pkg.bytes);
      const error = await elsewhere.edit(first.did, { parent: activated.original.checkpoint, name: "Competing", author: first.alice.ref("orig"), signer: first.signer }).catch((e: unknown) => e);
      const codes = ((error as OriginalsError).details as { refusals: Array<{ code: string }> }).refusals.map((r) => r.code);
      expect(codes).toContain("NOT_EXTENDING_LAST_APPROVED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fetching a did:webvh log for evidence", () => {
  test("the log is required and its witness file optional", async () => {
    const did = "did:webvh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ:example.com:alice";
    const files = new Map([["https://example.com/alice/did.jsonl", bytes("{}\n")]]);
    const fetch = (url: string) => {
      const data = files.get(url);
      return data ? Promise.resolve(data) : Promise.reject(new OriginalsError("unavailable-bytes", "FETCH_STATUS", "404"));
    };
    expect(await fetchWebvhEvidence(did, fetch)).toEqual({ did, log: "{}\n" });
    files.set("https://example.com/alice/did-witness.json", bytes("[]"));
    expect(await fetchWebvhEvidence(did, fetch)).toEqual({ did, log: "{}\n", witness: [] });
    files.clear();
    await expect(fetchWebvhEvidence(did, fetch)).rejects.toMatchObject({ category: "unavailable-bytes" });
  });
});
