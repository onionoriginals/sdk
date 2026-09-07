import * as btc from "@scure/btc-signer";
import {
  parseWitness,
  p2tr_ord_reveal,
  parseInscriptions,
} from "micro-ordinals";
import {
  CelError,
  encodeDocument,
  eventDigest,
  parseAssetDid,
  parseDocument,
  signEvent,
  validateDocument,
  verifyHistory,
  type CelDocument,
  type CelSigner,
  type BitcoinNetwork,
  type AssetState,
  type DeepReadonly,
} from "@originals/cel/v3";
import type { OrdinalsProvider } from "../adapters/types.js";
import type { Utxo } from "../types/bitcoin.js";
import type { BitcoinSigner } from "../types/common.js";
import {
  prepareInscriptionOnSat,
  submitPreparedInscriptionOnSat,
  type InscribeOnSatResult,
  type InscriptionRecoveryStore,
  type PreparedInscriptionOnSat,
} from "../bitcoin/inscribe-on-sat.js";
import { OriginalsAsset } from "./OriginalsAsset.js";
import { readEnvelope } from "./envelope.js";
import { captureSigner } from "./options.js";
import { AssetResolver, btcoDid } from "./resolution.js";
import type { AssetEnvelope, OriginalsConfig } from "./types.js";

export interface BitcoinPublicationOptions {
  /** First input must start with the identity sat. Additional inputs fund fees. */
  fundingUtxos: Utxo[];
  satSigner: BitcoinSigner;
  changeAddress: string;
  feeRate: number;
  /** Current-controller custody for a boundary migration. Deltas are already signed proposals. */
  signer?: CelSigner;
  /** Default: first head resource at the boundary, first changed resource for a delta. Null makes a log-only inscription. */
  inlineResourceId?: string | null;
}
/** Persist this complete wrapper to resume asset publication without controller or Bitcoin signing keys. */
export interface PreparedBitcoinPublication {
  format: "originals/bitcoin-publication";
  version: 3;
  kind: "boundary" | "delta";
  asset: AssetEnvelope;
  document: CelDocument;
  transactions: PreparedInscriptionOnSat;
  /** Freshly accepted predecessor, present only for deltas. */
  baseHead?: string;
}
export interface BitcoinSubmissionOptions {
  recoveryStore?: InscriptionRecoveryStore;
}
/** Acknowledged submission or ambiguous delivery, never confirmation or accepted CEL state. */
export interface SubmittedBitcoinAsset {
  status: "submitted" | "broadcast-unknown";
  asset: OriginalsAsset;
  submission: InscribeOnSatResult;
}
function invalid(code: string, message: string): never {
  throw new CelError("invalid", code, message);
}
/** SDK supported serialized script limit, leaving room for the transaction and taproot witness. */
const MAX_INSCRIPTION_SCRIPT_BYTES = 390_000;
function checkedContent(
  document: CelDocument,
  content: Uint8Array,
  contentType: string,
  media: boolean,
) {
  const metadata = media
    ? (JSON.parse(
        new TextDecoder().decode(encodeDocument(document, "json")),
      ) as Record<string, unknown>)
    : undefined;
  const tags = { contentType, ...(metadata ? { metadata } : {}) };
  // Public secp256k1 generator x-coordinate; only script sizing, never reveal-key custody.
  const script = p2tr_ord_reveal(
    Buffer.from(
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      "hex",
    ),
    [{ tags, body: content }],
  ).script;
  if (script.length > MAX_INSCRIPTION_SCRIPT_BYTES)
    invalid(
      "ASSET_INSCRIPTION_LIMIT",
      "The serialized inscription envelope exceeds the SDK supported 390000-byte script limit",
    );
  if (media) {
    encodeDocument(document, "cbor");
    const encoded = parseInscriptions(btc.Script.decode(script));
    if (
      !encoded?.[0].tags.metadata ||
      !equalDocument(validateDocument(encoded[0].tags.metadata), document)
    )
      invalid(
        "ASSET_INSCRIPTION_ENCODING",
        "The inscription metadata encoder could not preserve the exact CEL document",
      );
  }
  return { content, contentType, ...(metadata ? { metadata } : {}) };
}
const equalDocument = (a: CelDocument, b: CelDocument) =>
  Buffer.from(encodeDocument(a, "json")).equals(
    Buffer.from(encodeDocument(b, "json")),
  );

/** Builds exact CEL 3 publications using a fresh accepted sat head and the durable signed-pair transport. */
export class BitcoinPublications {
  constructor(
    private readonly provider: OrdinalsProvider,
    private readonly network: BitcoinNetwork,
    private readonly resolver: AssetResolver,
    private readonly config: OriginalsConfig = {},
  ) {}

  async prepare(
    input: OriginalsAsset,
    options: BitcoinPublicationOptions,
  ): Promise<PreparedBitcoinPublication> {
    // Copy all mutable publication input before any provider/signing await.
    const envelope = readEnvelope(input.serialize());
    const asset = new OriginalsAsset(
      envelope.eventLog,
      envelope.resources,
      this.config,
      envelope.assetId,
      envelope.unverified?.localResources,
      this.resolver,
    );
    const state = asset.state;
    if (
      asset.localResources.length ||
      !["webvh", "btco"].includes(state.layer) ||
      (state.layer === "webvh" && !state.active)
    )
      invalid(
        "ASSET_BITCOIN_STATE",
        "Publish an active hosted boundary or a signed Bitcoin proposal with no unsigned drafts",
      );
    const fundingUtxos = options.fundingUtxos.map((utxo) => ({ ...utxo }));
    const changeAddress = options.changeAddress,
      feeRate = options.feeRate,
      inlineResourceId = options.inlineResourceId;
    if (
      inlineResourceId !== undefined &&
      inlineResourceId !== null &&
      typeof inlineResourceId !== "string"
    )
      invalid(
        "ASSET_INLINE_RESOURCE",
        "inlineResourceId must be a resource id or null",
      );
    const signCommit = options.satSigner.signAndFinalizeCommitPsbt.bind(
      options.satSigner,
    );
    const signer =
      state.layer === "webvh"
        ? captureSigner(
            options.signer ??
              this.config.signer ??
              invalid(
                "NO_SIGNING_KEY",
                "Boundary migration requires current-controller custody",
              ),
          )
        : undefined;
    if (signer && signer.controller !== state.controller)
      invalid(
        "CEL_AUTHORITY",
        "Only the current controller can sign the boundary migration",
      );
    if (state.layer === "webvh") {
      const hosted = await this.resolver.checkWeb(state.alias, state.assetId);
      if (hosted.status !== "verified" || hosted.head !== state.head)
        invalid(
          "ASSET_WEBVH_BINDING",
          "Publish and verify this exact hosted history before the Bitcoin boundary",
        );
    }
    let prepared: Omit<PreparedBitcoinPublication, "transactions"> | undefined;
    const transactions = await prepareInscriptionOnSat({
      fundingUtxos,
      satSigner: { signAndFinalizeCommitPsbt: signCommit },
      changeAddress,
      feeRate,
      network: this.network,
      provider: this.provider,
      buildContent: async (sat) => {
        const { snapshot, resolution } = await this.resolver.observe(sat);
        if (
          !snapshot ||
          (state.layer === "webvh"
            ? resolution.status !== "not-found"
            : resolution.status !== "accepted")
        )
          invalid(
            "ASSET_ACCEPTED_HEAD_REQUIRED",
            "A complete fresh accepted sat observation is required before building a publication",
          );
        const expectedPoint = `${fundingUtxos[0].txid.toLowerCase()}:${fundingUtxos[0].vout}:0`;
        // ord does not track the location of every uninscribed common sat.
        // prepareInscriptionOnSat has already derived this boundary sat from
        // the selected output's exact sat ranges. Later publications must
        // additionally match the accepted inscription's observed location.
        if (
          (state.layer === "btco" || snapshot.ownership.satpoint !== null) &&
          snapshot.ownership.satpoint !== expectedPoint
        )
          invalid(
            "ASSET_SAT_ALIGNMENT",
            "Identity funding input must contain the observed identity sat as its first sat",
          );
        if (snapshot.publications.some((publication) => !publication.confirmed))
          invalid(
            "ASSET_PUBLICATION_PENDING",
            "Wait for pending sat publications before preparing another publication",
          );
        let full = envelope.eventLog,
          document: CelDocument,
          baseHead: string | undefined,
          accepted: DeepReadonly<AssetState> | undefined;
        if (state.layer === "webvh") {
          const migration = await signEvent(
            {
              previousEvent: state.head,
              operation: {
                type: "migrate",
                data: {
                  profile: "originals/cel/3",
                  from: state.alias,
                  to: btcoDid(sat, this.network),
                  layer: "btco",
                  migratedAt: new Date().toISOString(),
                },
              },
            },
            signer!,
          );
          document = full = validateDocument({ log: [...full.log, migration] });
          verifyHistory(full, { expectedDid: asset.id });
        } else {
          const did = parseAssetDid(state.alias);
          if (
            did.method !== "btco" ||
            did.sat !== sat ||
            did.network !== this.network
          )
            invalid(
              "ASSET_SAT_IDENTITY",
              "Funding input does not carry this asset identity sat on the configured network",
            );
          if (resolution.status !== "accepted")
            invalid(
              "ASSET_ACCEPTED_HEAD_REQUIRED",
              "A fresh accepted head is required",
            );
          accepted = resolution.state;
          if (
            accepted.assetId !== state.assetId ||
            full.log.length <= accepted.entryCount ||
            eventDigest(full.log[accepted.entryCount - 1].event) !==
              accepted.head
          )
            invalid(
              "ASSET_DELTA_BASE",
              "The signed proposal must extend the freshly accepted sat head",
            );
          baseHead = accepted.head;
          document = validateDocument({
            log: full.log.slice(accepted.entryCount),
          });
        }
        const proposed = new OriginalsAsset(
          full,
          envelope.resources,
          this.config,
          asset.id,
          [],
          this.resolver,
        );
        prepared = {
          format: "originals/bitcoin-publication",
          version: 3,
          kind: state.layer === "webvh" ? "boundary" : "delta",
          asset: proposed.serialize(),
          document,
          ...(baseHead ? { baseHead } : {}),
        };
        const proposedState = proposed.state;
        const previousResources = new Map(
          accepted?.resources.map((resource) => [resource.id, resource]),
        );
        const candidates = proposedState.resources.filter((resource) => {
          const previous = previousResources.get(resource.id);
          return (
            !previous ||
            previous.digestMultibase !== resource.digestMultibase ||
            previous.mediaType !== resource.mediaType
          );
        });
        if (
          inlineResourceId !== undefined &&
          inlineResourceId !== null &&
          !proposedState.resources.some(
            (resource) => resource.id === inlineResourceId,
          )
        )
          invalid(
            "ASSET_INLINE_RESOURCE",
            "Selected inline resource is not part of the authenticated asset",
          );
        const selected =
          inlineResourceId === null
            ? undefined
            : inlineResourceId === undefined
              ? candidates[0]
              : proposedState.resources.find((resource) => resource.id === inlineResourceId);
        if (!selected)
          return checkedContent(
            document,
            encodeDocument(document, "json"),
            "application/cel",
            false,
          );
        const resource = proposed.resources.find(
          (resource) =>
            resource.id === selected.id &&
            resource.version === selected.version,
        );
        if (!resource?.content)
          invalid(
            "ASSET_RESOURCE_MISSING",
            "Selected inline resource bytes are unavailable",
          );
        return checkedContent(
          document,
          resource.content,
          resource.mediaType,
          true,
        );
      },
    });
    const result = { ...prepared!, transactions };
    this.validate(result);
    return result;
  }

  private validate(input: PreparedBitcoinPublication): OriginalsAsset {
    if (
      input?.format !== "originals/bitcoin-publication" ||
      input.version !== 3 ||
      !["boundary", "delta"].includes(input.kind) ||
      input.transactions?.network !== this.network
    )
      invalid(
        "ASSET_BITCOIN_PUBLICATION",
        "Unsupported prepared Bitcoin publication",
      );
    const envelope = readEnvelope(input.asset),
      document = validateDocument(input.document);
    if (envelope.unverified?.localResources.length)
      invalid(
        "ASSET_BITCOIN_PUBLICATION",
        "Prepared publication cannot include unsigned drafts",
      );
    const asset = new OriginalsAsset(
      envelope.eventLog,
      envelope.resources,
      this.config,
      envelope.assetId,
      [],
      this.resolver,
    );
    const state = asset.state;
    if (
      state.alias !== btcoDid(input.transactions.satoshi, this.network) ||
      state.layer !== "btco"
    )
      invalid(
        "ASSET_BITCOIN_PUBLICATION",
        "Prepared transaction sat differs from the signed asset alias",
      );
    if (input.kind === "boundary") {
      if (
        input.baseHead !== undefined ||
        !equalDocument(document, asset.celLog) ||
        document.log[document.log.length - 1]?.event.operation.type !==
          "migrate"
      )
        invalid(
          "ASSET_BITCOIN_PUBLICATION",
          "Boundary must contain the full history ending exactly at Bitcoin migration",
        );
    } else {
      const start = asset.celLog.log.findIndex(
        (entry) => entry.event.previousEvent === input.baseHead,
      );
      if (
        !input.baseHead ||
        start < 1 ||
        document.log[0]?.event.previousEvent !== input.baseHead ||
        !equalDocument(document, { log: asset.celLog.log.slice(start) }) ||
        verifyHistory({ log: asset.celLog.log.slice(0, start) }).state.layer !==
          "btco"
      )
        invalid(
          "ASSET_BITCOIN_PUBLICATION",
          "Delta does not match its Bitcoin prefix and full proposed asset",
        );
    }
    const reveal = btc.Transaction.fromRaw(
      Buffer.from(input.transactions.revealTxHex, "hex"),
      { allowUnknownInputs: true, allowUnknownOutputs: true },
    );
    const inscriptions = parseWitness(reveal.getInput(0).finalScriptWitness!);
    if (inscriptions?.length !== 1)
      invalid(
        "ASSET_BITCOIN_PUBLICATION",
        "Prepared reveal must carry exactly one inscription",
      );
    const inscription = inscriptions[0];
    if (
      Object.keys(inscription.tags).some(
        (key) => !["contentType", "metadata"].includes(key),
      )
    )
      invalid(
        "ASSET_BITCOIN_PUBLICATION",
        "Prepared reveal has unsupported inscription tags",
      );
    if (inscription.tags.metadata === undefined) {
      if (
        inscription.tags.contentType !== "application/cel" ||
        !equalDocument(parseDocument(inscription.body, "json"), document)
      )
        invalid(
          "ASSET_BITCOIN_PUBLICATION",
          "Prepared reveal CEL body differs from the publication",
        );
    } else {
      if (
        !equalDocument(validateDocument(inscription.tags.metadata), document) ||
        !asset.resources.some(
          (resource) =>
            resource.version ===
              state.resources.find((current) => current.id === resource.id)
                ?.version &&
            resource.mediaType === inscription.tags.contentType &&
            resource.content &&
            Buffer.from(resource.content).equals(Buffer.from(inscription.body)),
        )
      )
        invalid(
          "ASSET_BITCOIN_PUBLICATION",
          "Prepared reveal media or CEL metadata differs from the authenticated publication",
        );
    }
    return asset;
  }

  /** Validate the saved wrapper and submit its exact signed pair. Repeated calls never sign a replacement. */
  async publish(
    input: PreparedBitcoinPublication,
    options: BitcoinSubmissionOptions = {},
  ): Promise<SubmittedBitcoinAsset> {
    const prepared = structuredClone(input),
      asset = this.validate(prepared);
    const submission = await submitPreparedInscriptionOnSat({
      prepared: prepared.transactions,
      provider: this.provider,
      recoveryStore: options.recoveryStore,
    });
    return {
      status: submission.broadcast.endsWith("_unknown")
        ? "broadcast-unknown"
        : "submitted",
      asset,
      submission,
    };
  }
}
