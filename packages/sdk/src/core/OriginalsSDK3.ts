import { BitcoinPublications } from "../v3/bitcoin.js";
import {
  HostedAssets,
  type PublicReachabilityCheck,
} from "../v3/hosted.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import { LifecycleManager } from "../v3/OriginalsSDK.js";
import { AssetDIDManager } from "../did/AssetDIDManager.js";
import { AssetResolver, type SatProvider } from "../v3/resolution.js";
import { CredentialManager } from "../vc/CredentialManager.js";
import { BitcoinManager } from "../bitcoin/BitcoinManager.js";
import { StatusListManager } from "../vc/StatusListManager.js";
import { Logger } from "../utils/Logger.js";
import { MetricsCollector } from "../utils/MetricsCollector.js";
import { StructuredError } from "@originals/cel";
import * as identityOperations from "../did/identity-operations.js";
import type { OriginalsConfig as ManagerConfig } from "../types/common.js";
import type { OriginalsConfig as LocalConfig } from "../v3/types.js";
import { fields, record, requireAsset } from "../v3/envelope.js";
import { mutationOptions } from "../v3/options.js";
import {
  getBitcoinNetworkForWebVH,
  getWebVHNetworkForBitcoin,
} from "../types/network.js";

/** CEL 3 custody plus configuration for independent identity, credential and Bitcoin utilities. */
export interface OriginalsSDKOptions
  extends
    Omit<
      Partial<ManagerConfig>,
      "signer" | "onAppendFailure" | "inscribeConfirm" | "storageAdapter"
    >,
    LocalConfig {
  satProvider?: SatProvider;
  storageAdapter?: StorageAdapter | ManagerConfig["storageAdapter"];
  /** Independent confirmation that a hosted WebVH publication's advertised log is actually public. */
  publicReachability?: PublicReachabilityCheck;
  /** Fail hosted publication rather than label it adapter-asserted when reachability cannot be confirmed. */
  requirePublicReachability?: boolean;
}
export type OriginalsConfig = OriginalsSDKOptions;

/** The default SDK. All asset creation, mutations and recovery use the CEL 3 lifecycle. */
export class OriginalsSDK {
  readonly lifecycle: LifecycleManager;
  readonly did: AssetDIDManager;
  readonly credentials: CredentialManager;
  readonly bitcoin: BitcoinManager;
  readonly statusList: StatusListManager;
  readonly logger: Logger;
  readonly metrics: MetricsCollector;
  private readonly config: ManagerConfig;

  constructor(options: OriginalsSDKOptions = {}) {
    const input = record(options);
    fields(
      input,
      [],
      [
        "satProvider",
        "signer",
        "onAppendFailure",
        "keyStore",
        "network",
        "bitcoinRpcUrl",
        "defaultKeyType",
        "webvhNetwork",
        "storageAdapter",
        "didCache",
        "feeOracle",
        "ordinalsProvider",
        "operationLock",
        "telemetry",
        "logging",
        "metrics",
        "enableLogging",
        "publicReachability",
        "requirePublicReachability",
      ],
    );
    const {
      signer,
      onAppendFailure,
      satProvider,
      storageAdapter,
      publicReachability,
      requirePublicReachability,
      ...utilities
    } = options;
    const local = mutationOptions({ signer, onAppendFailure });
    requireAsset(
      utilities.network === undefined ||
        ["mainnet", "testnet", "regtest", "signet"].includes(utilities.network),
      "SDK_NETWORK",
      "Invalid Bitcoin network",
    );
    requireAsset(
      utilities.webvhNetwork === undefined ||
        ["pichu", "cleffa", "magby"].includes(utilities.webvhNetwork),
      "SDK_NETWORK",
      "Invalid WebVH network",
    );
    requireAsset(
      utilities.defaultKeyType === undefined ||
        ["ES256K", "Ed25519", "ES256"].includes(utilities.defaultKeyType),
      "SDK_KEY_TYPE",
      "Invalid identity key type",
    );
    const network =
      utilities.network ??
      (utilities.webvhNetwork
        ? getBitcoinNetworkForWebVH(utilities.webvhNetwork)
        : "mainnet");
    const webvhNetwork =
      utilities.webvhNetwork ?? getWebVHNetworkForBitcoin(network);
    if (webvhNetwork)
      requireAsset(
        getBitcoinNetworkForWebVH(webvhNetwork) === network,
        "SDK_NETWORK",
        "Bitcoin and WebVH network selections disagree",
      );
    const hostedStorage: StorageAdapter | undefined = !storageAdapter
      ? undefined
      : "putObject" in storageAdapter
        ? storageAdapter
        : {
            putObject: (domain, path, bytes, options) =>
              storageAdapter.put(domain + "/" + path, bytes, options),
            getObject: (domain, path) =>
              storageAdapter.get(domain + "/" + path),
            exists: async (domain, path) =>
              (await storageAdapter.get(domain + "/" + path)) !== null,
          };
    this.config = {
      ...utilities,
      ...(storageAdapter && "put" in storageAdapter ? { storageAdapter } : {}),
      network,
      webvhNetwork,
      defaultKeyType: utilities.defaultKeyType ?? "Ed25519",
      enableLogging: utilities.enableLogging ?? false,
    };
    this.metrics = new MetricsCollector();
    this.logger = new Logger("SDK", this.config);
    const hosted = hostedStorage
      ? new HostedAssets(hostedStorage, local, {
          publicReachability,
          requirePublicReachability,
        })
      : undefined;
    const resolver = new AssetResolver(
      network,
      satProvider ??
        (utilities.ordinalsProvider?.getSatSnapshot
          ? {
              getSatSnapshot: (sat) =>
                utilities.ordinalsProvider!.getSatSnapshot!(sat),
            }
          : undefined),
      local,
      hosted,
    );
    this.lifecycle = new LifecycleManager(
      local,
      resolver,
      hosted,
      utilities.ordinalsProvider
        ? new BitcoinPublications(
            utilities.ordinalsProvider,
            network,
            resolver,
            local,
          )
        : undefined,
    );
    this.did = new AssetDIDManager(this.config, this.metrics, resolver);
    this.credentials = new CredentialManager(
      this.config,
      this.did,
      this.metrics,
    );
    this.bitcoin = new BitcoinManager(this.config);
    this.statusList = new StatusListManager();
  }

  /** Create a SDK with explicit CEL 3 custody; reading and verification need no signer. */
  static create(options: OriginalsSDKOptions = {}): OriginalsSDK {
    return new OriginalsSDK(options);
  }

  /** Validate configuration for the independent low-level Bitcoin utility. */
  validateBitcoinConfig(): void {
    if (!this.config.ordinalsProvider)
      throw new StructuredError(
        "ORD_PROVIDER_REQUIRED",
        "Bitcoin operations require an ordinalsProvider",
      );
  }

  // Stable standalone identity helpers used by @originals/auth. These do not
  // create asset CELs or infer a relationship between a DID identity and an asset.
  static prepareDIDDataForSigning = identityOperations.prepareDIDDataForSigning;
  static verifyDIDSignature = identityOperations.verifyDIDSignature;
  static createOriginal = identityOperations.createOriginal;
  static createDIDOriginal = identityOperations.createDIDOriginal;
  static updateOriginal = identityOperations.updateOriginal;
  static updateDIDOriginal = identityOperations.updateDIDOriginal;
}
