import { test, expect, afterEach } from "bun:test";
import { installCel3Host, engineWithSigner } from "./cel3-test-helpers";
import {
  localPublicationRecoveries,
  recoverLocalPublication,
} from "./local-publication-recovery";

let host: ReturnType<typeof installCel3Host>;
afterEach(() => host?.restore());

for (const switchAt of ["before-publication", "during-publication", "during-account-record"] as const) {
  test(`account change ${switchAt} stops recovery side effects and retains the signed wrapper`, async () => {
    host = installCel3Host("sub-1");
    globalThis.fetch = (async () => new Response("temporarily unavailable", { status: 503 })) as typeof fetch;
    const { engine } = engineWithSigner("sub-1");
    await engine.create("Retained Original", "Text", "exact bytes");
    await expect(engine.publish()).rejects.toThrow(/incomplete/);
    const [item] = localPublicationRecoveries("sub-1");
    const retained = localStorage.getItem(item.key);
    let current = true;
    let writes = 0;
    let records = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        writes++;
        if (switchAt === "during-publication") current = false;
      }
      if (String(input) === "/api/originals" && init?.method === "POST") {
        records++;
        if (switchAt === "during-account-record") current = false;
      }
      return host.fetch(input, init);
    }) as typeof fetch;
    const outcome = recoverLocalPublication("sub-1", item.key, localStorage, () => current);
    if (switchAt === "before-publication") current = false;
    await expect(outcome).rejects.toThrow(/account is no longer active/);
    expect(localStorage.getItem(item.key)).toBe(retained);
    expect(records).toBe(switchAt === "during-account-record" ? 1 : 0);
    if (switchAt === "before-publication") expect(writes).toBe(0);
  });
}

test("a browser restart retries the same partially uploaded WebVH identity without custody", async () => {
  host = installCel3Host("sub-1");
  const originalFetch = host.fetch;
  let fail = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (
      fail &&
      init?.method === "PUT" &&
      decodeURIComponent(String(input)).endsWith("/cel.json")
    )
      return new Response("lost", { status: 503 });
    return originalFetch(input, init);
  }) as typeof fetch;
  const { engine } = engineWithSigner("sub-1");
  await engine.create("Recover PNG", "Upload", {
    filename: "mine.png",
    mediaType: "image/png",
    contentType: "image/png",
    content: Uint8Array.from([137, 80, 78, 71, 255]),
  } as never);
  await expect(engine.publish()).rejects.toThrow(/incomplete/);
  const saved = localPublicationRecoveries("sub-1");
  expect(saved).toHaveLength(1);
  expect(localPublicationRecoveries("other-account")).toEqual([]);
  const prepared = JSON.parse(localStorage.getItem(saved[0].key)!);
  fail = false;
  // No engine, signer or key is passed to this cold recovery operation.
  expect(await recoverLocalPublication("sub-1", saved[0].key)).toContain(
    "recovered",
  );
  expect(host.store.list("sub-1")[0].did).toBe(prepared.did);
  expect(host.store.list("sub-1")[0].resourceContentType).toBe("image/png");
  expect(localPublicationRecoveries("sub-1")).toEqual([]);
});

test("a storage failure prevents every publication upload", async () => {
  host = installCel3Host("sub-1");
  const { engine } = engineWithSigner("sub-1");
  await engine.create("Original", "Text", "bytes");
  localStorage.setItem = () => {
    throw new Error("quota");
  };
  await expect(engine.publish()).rejects.toThrow("quota");
  expect(host.writes).toEqual([]);
});

test("a cold retry after a lost submission response reuses both exact signed transactions", async () => {
  host = installCel3Host("sub-1");
  const { OriginalsSDK } = await import("@originals/sdk");
  const { DurableHostingStorageAdapter } =
    await import("./durable-hosting-adapter");
  const { recoveryStorageKey } = await import("./local-publication-recovery");
  const btc = await import("@scure/btc-signer");
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  const { engine, signer } = engineWithSigner("sub-1");
  await engine.create("Recover Bitcoin", "Text", "exact bytes");
  await engine.publish();
  const key = new Uint8Array(32).fill(1);
  const network = {
    bech32: "bcrt",
    pubKeyHash: 111,
    scriptHash: 196,
    wif: 239,
  };
  const payment = btc.p2wpkh(secp256k1.getPublicKey(key), network);
  const funding = {
    txid: "12".repeat(32),
    vout: 0,
    value: 100000,
    scriptPubKey: Buffer.from(payment.script).toString("hex"),
  };
  const tip = { height: 100, hash: "ab".repeat(32) };
  const provider = {
    getFirstSatOfOutput: async () => "1250000000",
    getSatSnapshot: async () => ({
      network: "regtest",
      sat: "1250000000",
      tipBefore: tip,
      tipAfter: tip,
      indexTip: tip,
      indexHealthy: true,
      enumerationComplete: true,
      blocks: [],
      publications: [],
      ownership: { owner: payment.address, satpoint: funding.txid + ":0:0" },
    }),
  };
  const sdk = OriginalsSDK.create({
    network: "regtest",
    signer,
    ordinalsProvider: provider as never,
    storageAdapter: new DurableHostingStorageAdapter(),
  });
  let signatures = 0;
  const prepared = await sdk.lifecycle.prepareBitcoinPublication(
    engine.asset!,
    {
      fundingUtxos: [funding],
      changeAddress: payment.address!,
      feeRate: 2,
      satSigner: {
        signAndFinalizeCommitPsbt: async (raw) => {
          signatures++;
          const transaction = btc.Transaction.fromPSBT(
            Buffer.from(raw, "base64"),
            { allowUnknownOutputs: true },
          );
          transaction.sign(key);
          transaction.finalize();
          return transaction.hex;
        },
      },
    },
  );
  const storageKey = recoveryStorageKey("bitcoin", "sub-1", engine.asset!.id);
  localStorage.setItem(storageKey, JSON.stringify(prepared));
  const submissions: Array<{ signedCommitHex: string; revealTxHex: string }> =
    [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/btc/inscribe") {
      submissions.push(JSON.parse(init!.body as string));
      if (submissions.length === 1) throw new Error("response lost");
      return Response.json({
        status: "reveal_broadcast",
        commitTxId: prepared.transactions.commitTxId,
        revealTxId: prepared.transactions.revealTxId,
      });
    }
    return host.fetch(input, init);
  }) as typeof fetch;
  expect(await recoverLocalPublication("sub-1", storageKey)).toContain(
    "commit_broadcast_unknown",
  );
  expect(localPublicationRecoveries("sub-1")[0].commitTxId).toBe(
    prepared.transactions.commitTxId,
  );
  expect(await recoverLocalPublication("sub-1", storageKey)).toContain(
    "reveal_broadcast",
  );
  expect(submissions).toHaveLength(2);
  expect(submissions[1].signedCommitHex).toBe(submissions[0].signedCommitHex);
  expect(submissions[1].revealTxHex).toBe(submissions[0].revealTxHex);
  expect(signatures).toBe(1);
});
