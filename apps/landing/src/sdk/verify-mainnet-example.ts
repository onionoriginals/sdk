/**
 * Live-check the retained owner mainnet Original (did:btco:321959825743820)
 * against this deploy's Bitcoin indexer, falling back to the last
 * independently verified receipt when a live check disagrees or is not
 * available — for instance to a signed-out visitor, since the sat-snapshot
 * proxy this uses is the same signed-in-only `/api/btc/*` surface as the
 * rest of the money path. Never claims more than the mock/local checks in
 * verify-example.ts: a failed or unavailable live check degrades to the
 * static receipt rather than showing a broken panel.
 */
import "../shims/buffer-global";
import { OriginalsSDK } from "@originals/sdk";
import type { OrdinalsProvider, OriginalsAsset } from "@originals/sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { HttpOrdinalsProvider } from "./http-ordinals-provider";
import defaultReceiptJson from "../../public/example/mainnet-receipt.json";

/** The retained, independently verified proof this checks a live read against. */
export interface MainnetReceipt {
  assetDid: string;
  didBtco: string;
  sat: string;
  inscriptionId: string;
  revealTxId: string;
  resource: { id: string; mediaType: string; byteLength: number; sha256: string };
  observedAt: string;
  sourceHref: string;
}

export interface MainnetExampleResult {
  /** True when this result came from a fresh check just now; false for the retained receipt. */
  live: boolean;
  network: "mainnet";
  didBtco: string;
  inscriptionId: string;
  sat: string;
  revealTxId: string;
  resource: MainnetReceipt["resource"];
  /** Whether the declared resource's bytes were found inline in the accepted publication (vs. off-chain). */
  resourceOnChain: boolean;
  observedAt: string;
  sourceHref: string;
}

const defaultReceipt: MainnetReceipt = defaultReceiptJson;

function retainedResult(receipt: MainnetReceipt): MainnetExampleResult {
  return {
    live: false,
    network: "mainnet",
    didBtco: receipt.didBtco,
    inscriptionId: receipt.inscriptionId,
    sat: receipt.sat,
    revealTxId: receipt.revealTxId,
    resource: receipt.resource,
    resourceOnChain: true,
    observedAt: receipt.observedAt,
    sourceHref: receipt.sourceHref,
  };
}

async function checkLive(
  receipt: MainnetReceipt,
  provider: OrdinalsProvider,
): Promise<MainnetExampleResult | null> {
  const sdk = OriginalsSDK.create({ network: "mainnet", ordinalsProvider: provider });
  const result = await sdk.lifecycle.resolveAssetFromSat(receipt.sat, {
    expectedAssetId: receipt.assetDid,
  });
  if (result.status !== "accepted") return null;
  if (result.asset.id !== receipt.assetDid) return null;
  if (result.didDocument?.id !== receipt.didBtco) return null;
  // Bind the resource-availability claim to the SAME accepted publication the
  // receipt names, not to the asset's current aggregate state: the sat's
  // history can carry other, later publications by the time this runs, and
  // `inscriptionId` alone is not proof that publication is what carried this
  // resource inline (it might be a log-only delta, or predate the resource).
  const publication = result.resolution.publications.find(
    (p) => p.inscriptionId === receipt.inscriptionId,
  );
  if (!publication) return null;
  const resourceOnChain = resourceMatchesReceipt(result.asset, publication, receipt.resource);
  return {
    live: true,
    network: "mainnet",
    didBtco: receipt.didBtco,
    inscriptionId: receipt.inscriptionId,
    sat: receipt.sat,
    revealTxId: receipt.revealTxId,
    resource: receipt.resource,
    resourceOnChain,
    observedAt: new Date().toISOString(),
    sourceHref: receipt.sourceHref,
  };
}

/**
 * True only when the named publication itself inlined this exact resource id
 * AND the asset's attached bytes for that resource independently hash to the
 * receipt's declared sha256 — never trusting the receipt's own digest field,
 * or a resource made available by a *different* publication, on its say-so.
 */
function resourceMatchesReceipt(
  asset: OriginalsAsset,
  publication: { inlineResourceIds: readonly string[] },
  resource: MainnetReceipt["resource"],
): boolean {
  if (!publication.inlineResourceIds.includes(resource.id)) return false;
  const attached = asset.resources.find((r) => r.id === resource.id && r.content);
  if (!attached?.content) return false;
  return hex.encode(sha256(attached.content)) === resource.sha256;
}

/** Never throws: any live-check failure (auth, network, chain mismatch) yields the retained receipt. */
export async function verifyMainnetExample(opts?: {
  receipt?: MainnetReceipt;
  provider?: OrdinalsProvider;
}): Promise<MainnetExampleResult> {
  const receipt = opts?.receipt ?? defaultReceipt;
  try {
    const live = await checkLive(receipt, opts?.provider ?? new HttpOrdinalsProvider());
    if (live) return live;
  } catch (err) {
    console.warn(
      "[originals-demo] mainnet example live check unavailable, showing retained receipt",
      err,
    );
  }
  return retainedResult(receipt);
}
