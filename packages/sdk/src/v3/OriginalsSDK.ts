import type {
  BitcoinPublications,
  BitcoinPublicationOptions,
  PreparedBitcoinPublication,
  BitcoinSubmissionOptions,
  SubmittedBitcoinAsset,
} from "./bitcoin.js";
import type {
  HostedAssets,
  WebPublicationOptions,
  PreparedWebPublication,
  PublishedWebAsset,
} from "./hosted.js";
import type {
  AssetResolver,
  AssetResolution,
  AssetResolutionOptions,
} from "./resolution.js";
import { createNonce, signEvent, CelError } from "@originals/cel/v3";
import { OriginalsAsset } from "./OriginalsAsset.js";
import { readEnvelope, record, fields, requireAsset } from "./envelope.js";
import { mutationOptions, captureSigner } from "./options.js";
import { prepareResources } from "./resources.js";
import type {
  AssetResourceInput,
  CreateAssetOptions,
  LoadAssetOptions,
  LoadedAsset,
  OriginalsConfig,
} from "./types.js";

/** CEL 3 creation, authenticated interchange and explicit hosted/Bitcoin publication. */
export class LifecycleManager {
  constructor(
    private readonly config: OriginalsConfig = {},
    private readonly resolver?: AssetResolver,
    private readonly hosted?: HostedAssets,
    private readonly bitcoin?: BitcoinPublications,
  ) {}

  private requireBitcoin(): BitcoinPublications {
    if (!this.bitcoin)
      throw new CelError(
        "unsupported",
        "ASSET_BITCOIN_REQUIRED",
        "Configure an ordinalsProvider on the full SDK",
      );
    return this.bitcoin;
  }
  /** Build and sign an exact boundary or delta without broadcasting. */
  prepareBitcoinPublication(
    asset: OriginalsAsset,
    options: BitcoinPublicationOptions,
  ): Promise<PreparedBitcoinPublication> {
    return this.requireBitcoin().prepare(asset, options);
  }
  /** Submit the saved pair, preserving ambiguous delivery and requiring durable recovery. */
  publishPreparedToBitcoin(
    prepared: PreparedBitcoinPublication,
    options: BitcoinSubmissionOptions = {},
  ): Promise<SubmittedBitcoinAsset> {
    return this.requireBitcoin().publish(prepared, options);
  }
  /** Prepare and durably submit. Chain acceptance must be checked through a fresh sat resolution. */
  async publishToBitcoin(
    asset: OriginalsAsset,
    options: BitcoinPublicationOptions & BitcoinSubmissionOptions,
  ): Promise<SubmittedBitcoinAsset> {
    return this.publishPreparedToBitcoin(
      await this.prepareBitcoinPublication(asset, options),
      options,
    );
  }

  private requireHosted(): HostedAssets {
    if (!this.hosted)
      throw new CelError(
        "unsupported",
        "ASSET_STORAGE_REQUIRED",
        "Configure a storageAdapter for hosted assets",
      );
    return this.hosted;
  }
  /** Prepare a retryable, signed hosted publication without storage side effects. */
  prepareWebPublication(
    asset: OriginalsAsset,
    options: WebPublicationOptions,
  ): Promise<PreparedWebPublication> {
    return this.requireHosted().prepare(asset, options);
  }
  /** Publish the exact prepared method history, CEL and bytes; safe to retry after a partial upload. */
  publishPreparedToWeb(
    prepared: PreparedWebPublication,
  ): Promise<PublishedWebAsset> {
    return this.requireHosted().publish(prepared, this.resolver);
  }
  /** Publish using an explicitly supplied permanent DNS host. Returns a new published asset. */
  async publishToWeb(
    asset: OriginalsAsset,
    options: WebPublicationOptions,
  ): Promise<PublishedWebAsset> {
    return this.publishPreparedToWeb(
      await this.prepareWebPublication(asset, options),
    );
  }
  /** Cold-read separate method and asset histories and every authenticated resource version. */
  resolveAssetFromWeb(did: string): Promise<LoadedAsset> {
    if (!this.resolver)
      throw new CelError(
        "unsupported",
        "ASSET_RESOLUTION_UNAVAILABLE",
        "Use the full SDK for hosted resolution",
      );
    return this.requireHosted().resolve(did, this.resolver);
  }

  /** Recover accepted on-sat history and byte attachments from a fresh complete provider snapshot. */
  async resolveAssetFromSat(
    sat: string,
    options: AssetResolutionOptions = {},
  ): Promise<AssetResolution> {
    if (!this.resolver)
      throw new CelError(
        "unsupported",
        "ASSET_RESOLUTION_UNAVAILABLE",
        "Configure a sat provider on the full SDK",
      );
    return this.resolver.resolve(sat, options);
  }

  /** Create a new identity using copied bytes and explicit controller custody. */
  async createAsset(
    inputs: AssetResourceInput[],
    options: CreateAssetOptions = {},
  ): Promise<OriginalsAsset> {
    fields(record(options), [], ["signer", "name", "metadata"]);
    const { descriptors, attachments } = prepareResources(inputs);
    const custody = options.signer ?? this.config.signer;
    if (!custody)
      throw new CelError(
        "invalid",
        "NO_CUSTODY",
        "Pass a CEL 3 signer per call or configure one before creating an asset",
      );
    const signer = captureSigner(custody);
    const entry = await signEvent(
      {
        operation: {
          type: "create",
          data: {
            profile: "originals/cel/3",
            controller: signer.controller,
            createdAt: new Date().toISOString(),
            nonce: createNonce(),
            resources: descriptors,
            ...(options.name !== undefined ? { name: options.name } : {}),
            ...(options.metadata !== undefined
              ? { metadata: options.metadata }
              : {}),
          },
        },
      },
      signer,
    );
    return new OriginalsAsset(
      { log: [entry] },
      attachments,
      this.config,
      undefined,
      [],
      this.resolver,
    );
  }

  /** Authenticate the same state and byte bindings as asset.verify(); no legacy fallback. */
  async loadAsset(
    input: unknown,
    options: LoadAssetOptions = {},
  ): Promise<LoadedAsset> {
    fields(record(options), [], ["allowPartial"]);
    requireAsset(
      options.allowPartial === undefined ||
        typeof options.allowPartial === "boolean",
      "ASSET_OPTIONS",
      "allowPartial must be a boolean",
    );
    const envelope = readEnvelope(input);
    const asset = new OriginalsAsset(
      envelope.eventLog,
      envelope.resources,
      this.config,
      envelope.assetDid,
      envelope.unverified?.localResources,
      this.resolver,
    );
    const verification = await asset.verification();
    if (!verification.verified && !options.allowPartial)
      throw new CelError(
        "invalid",
        "ASSET_LOAD_VERIFICATION_FAILED",
        "Asset is not fully verified; allowPartial retains authenticated history with explicitly incomplete verification",
      );
    return { asset, verification };
  }
}

/** SDK entry point for the selected CEL 3 profile. Never invokes previous-format writers or resolvers. */
export class OriginalsSDK {
  readonly lifecycle: LifecycleManager;
  private constructor(config: OriginalsConfig) {
    this.lifecycle = new LifecycleManager(mutationOptions(config));
  }
  /** Construct a fresh CEL 3 SDK; a signer is required only for creation and mutation. */
  static create(config: OriginalsConfig = {}): OriginalsSDK {
    return new OriginalsSDK(config);
  }
}
