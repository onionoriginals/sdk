import type {
  PreparedBitcoinPublication,
  PreparedWebPublication,
} from "@originals/sdk";
import { verifyHistory, validateDocument } from "@originals/sdk/cel";
import { digestMultibaseSha256Hex } from "../pages/original-detail-data";

export interface LocalPublicationRecovery {
  key: string;
  kind: "web" | "bitcoin";
  title: string;
  assetDid: string;
  commitTxId?: string;
}
export function recoveryStorageKey(
  kind: "web" | "bitcoin",
  account: string,
  assetDid: string,
): string {
  return `originals:${kind}-publication:${account}:${assetDid}`;
}
/** Only this signed-in account's authenticated, signed proposals are offered. */
export function localPublicationRecoveries(
  account: string,
  storage: Storage = localStorage,
): LocalPublicationRecovery[] {
  const results: LocalPublicationRecovery[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key) continue;
    const kind = key.startsWith(recoveryStorageKey("web", account, "did:cel:"))
      ? "web"
      : key.startsWith(recoveryStorageKey("bitcoin", account, "did:cel:"))
        ? "bitcoin"
        : null;
    if (!kind) continue;
    try {
      const prepared = JSON.parse(storage.getItem(key)!) as
        PreparedBitcoinPublication | PreparedWebPublication;
      if (
        prepared.version !== 3 ||
        prepared.format !== `originals/${kind}-publication`
      )
        continue;
      const state = verifyHistory(validateDocument(prepared.asset.eventLog), {
        expectedDid: prepared.asset.assetDid,
      }).state;
      if (key !== recoveryStorageKey(kind, account, state.didCel)) continue;
      results.push({
        key,
        kind,
        title: state.name ?? "Original",
        assetDid: state.didCel,
        ...(prepared.format === "originals/bitcoin-publication"
          ? { commitTxId: prepared.transactions.commitTxId }
          : {}),
      });
    } catch {
      /* Malformed retained data cannot become a signing or broadcast action. */
    }
  }
  return results;
}

/** Retry exact signed artifacts. This path neither requests a signer nor rebuilds transactions. */
export async function recoverLocalPublication(
  account: string,
  key: string,
  storage: Storage = localStorage,
  isCurrentAccount: () => boolean = () => true,
): Promise<string> {
  const assertCurrentAccount = () => {
    if (!isCurrentAccount())
      throw new DOMException("The recovery account is no longer active.", "AbortError");
  };
  assertCurrentAccount();
  const item = localPublicationRecoveries(account, storage).find(
    (record) => record.key === key,
  );
  if (!item)
    throw new Error(
      "The retained publication could not be authenticated for this account.",
    );
  const prepared = JSON.parse(storage.getItem(key)!);
  const { OriginalsSDK } = await import("@originals/sdk");
  const { DurableHostingStorageAdapter } =
    await import("./durable-hosting-adapter");
  const { HttpOrdinalsProvider } = await import("./http-ordinals-provider");
  assertCurrentAccount();
  const sdk = OriginalsSDK.create({
    storageAdapter: new DurableHostingStorageAdapter(),
    ...(item.kind === "bitcoin"
      ? {
          network: (prepared as PreparedBitcoinPublication).transactions
            .network,
          ordinalsProvider: new HttpOrdinalsProvider(),
        }
      : {}),
  });
  const published =
    item.kind === "web"
      ? await sdk.lifecycle.publishPreparedToWeb(prepared)
      : await sdk.lifecycle.publishPreparedToBitcoin(prepared);
  assertCurrentAccount();
  const asset = published.asset;
  const did = asset.state.aliases.find((alias) =>
    alias.startsWith("did:webvh:"),
  );
  const submission = "submission" in published ? published.submission : null;
  const response = await fetch("/api/originals", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      did,
      title: asset.state.name ?? item.title,
      resourceHash: asset.resources[0]
        ? (digestMultibaseSha256Hex(asset.resources[0].digestMultibase) ?? "")
        : "",
      ...(submission
        ? {
            btcoDid: asset.state.alias,
            commitTxId: submission.commitTxId,
            revealTxId: submission.revealTxId,
            inscriptionId: submission.inscriptionId,
            satoshi: submission.satoshi,
            status: "pending",
          }
        : {}),
    }),
  });
  assertCurrentAccount();
  if (!response.ok)
    throw new Error(
      "Publication retained. Your account record could not be saved; retry is safe.",
    );
  // Bitcoin wrappers stay available until the server reports its retained pair.
  if (item.kind === "web") storage.removeItem(key);
  return submission
    ? `Submission outcome: ${submission.broadcast}. The same signed transactions remain available for recovery.`
    : "Hosted publication recovered and added to your Originals.";
}
