import { DIDManager } from "./DIDManager.js";
import type { AssetResolver, AssetDIDResolution } from "../v3/resolution.js";
import type { OriginalsConfig } from "../types/common.js";
import type { MetricsCollector } from "../utils/MetricsCollector.js";
import type { DIDDocument } from "../types/did.js";
import { CelError } from "@originals/cel/v3";

/** Identity utilities plus CEL 3 Bitcoin resolution. Raw on-chain DID documents are never authority. */
export class AssetDIDManager extends DIDManager {
  constructor(
    config: OriginalsConfig,
    metrics: MetricsCollector,
    private readonly assets: AssetResolver,
  ) {
    super(config, metrics, undefined, { assetResolution: "unavailable" });
  }
  override async resolveDID(
    did: string,
    options?: { skipCache?: boolean },
  ): Promise<DIDDocument | null> {
    if (!did.startsWith("did:btco:")) return super.resolveDID(did, options);
    const result = await this.resolveDIDWithMetadata(did);
    if (
      !["accepted", "not-found"].includes(result.didResolutionMetadata.status)
    )
      throw new CelError(
        "invalid",
        "ASSET_RESOLUTION_INCOMPLETE",
        result.didResolutionMetadata.error ?? "Incomplete Bitcoin evidence",
      );
    return result.didDocument;
  }
  /** Return accepted head, deactivation and observed ownership separately from controller authority. */
  resolveDIDWithMetadata(did: string): Promise<AssetDIDResolution> {
    return this.assets.resolveDID(did);
  }
}
