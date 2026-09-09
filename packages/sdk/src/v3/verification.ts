import type { HostedEvidence } from "./hosted.js";
import { verifyHistory, type SatResolution } from "@originals/cel/v3";
import type { OriginalsAsset } from "./OriginalsAsset.js";
import type { AssetVerification } from "./types.js";

/** Internal summary after the resolver has checked a snapshot. Never exposed as a caller evidence override. */
export function summarizeVerification(
  asset: OriginalsAsset,
  publication?: SatResolution,
  hosted?: HostedEvidence,
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
        (hosted?.status === "verified" && hosted.head === history.state.head) ||
        (publication?.status === "accepted" &&
          publication.state.head === history.state.head &&
          publication.state.assetId === history.state.assetId)),
    history,
    resources: missingResources.length ? "incomplete" : "verified",
    missingResources,
    unverifiedLocalResources,
    ...(publication ? { publication } : {}),
    ...(hosted ? { hosted } : {}),
  };
}
