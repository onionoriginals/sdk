import { verifyHistory, type SatResolution } from "@originals/cel/v3";
import type { OriginalsAsset } from "./OriginalsAsset.js";
import type { AssetVerification } from "./types.js";

/** Internal summary after the resolver has checked a snapshot. Never exposed as a caller evidence override. */
export function summarizeVerification(
  asset: OriginalsAsset,
  publication?: SatResolution,
): AssetVerification {
  const history = verifyHistory(asset.celLog);
  const missingResources = asset.resources
    .filter((r) => r.content === undefined)
    .map(({ id, version }) => ({ id, version }));
  const unverifiedLocalResources = asset.localResources.length;
  return {
    verified:
      missingResources.length === 0 &&
      unverifiedLocalResources === 0 &&
      (history.state.layer === "cel" ||
        (publication?.status === "accepted" &&
          publication.state.head === history.state.head &&
          publication.state.didCel === history.state.didCel)),
    history,
    resources: missingResources.length ? "incomplete" : "verified",
    missingResources,
    unverifiedLocalResources,
    ...(publication ? { publication } : {}),
  };
}
