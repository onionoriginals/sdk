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
import type { OrdinalsProvider } from "@originals/sdk";
import type { SatSnapshot } from "@originals/sdk/cel";
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
  if (!provider.getSatSnapshot) return null;
  const sdk = OriginalsSDK.create({ network: "mainnet", ordinalsProvider: provider });
  const result = await sdk.lifecycle.resolveAssetFromSat(receipt.sat, {
    expectedAssetId: receipt.assetDid,
  });
  if (result.status !== "accepted") return null;
  if (result.asset.id !== receipt.assetDid) return null;
  if (result.didDocument?.id !== receipt.didBtco) return null;
  // The receipt's inscription must itself be part of the chain-accepted
  // history (not merely some inscription that happens to sit on this sat).
  if (!result.resolution.publications.some((p) => p.inscriptionId === receipt.inscriptionId))
    return null;
  // Bind the resource-availability claim to the SPECIFIC bytes THAT
  // publication inscribed, read straight from the snapshot, rather than the
  // asset's resource catalog: a resource id can carry more than one
  // authenticated version, and later publications on this same sat can
  // attach content to a *different* version, so "some version of this id
  // has attached bytes" is not proof this particular inscription carried
  // the receipt's declared bytes.
  const snapshot = await provider.getSatSnapshot(receipt.sat);
  const observed = snapshot.publications.find((p) => p.id === receipt.inscriptionId);
  const resourceOnChain = resourceMatchesReceipt(observed, receipt.resource);
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
 * True only when the named publication's own inscribed bytes independently
 * hash to the receipt's declared sha256 — never trusting the receipt's own
 * digest field, or bytes attached to this resource id by a *different*
 * publication, on their say-so.
 */
function resourceMatchesReceipt(
  publication: SatSnapshot["publications"][number] | undefined,
  resource: MainnetReceipt["resource"],
): boolean {
  if (!publication || publication.body.status !== "complete") return false;
  const { body } = publication;
  if (body.mediaType !== resource.mediaType) return false;
  if (body.bytes.length !== resource.byteLength) return false;
  return hex.encode(sha256(body.bytes)) === resource.sha256;
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
