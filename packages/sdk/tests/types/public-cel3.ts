// Compile against the installed export map, independently of the SDK source tsconfig.
import SDK, {
  OriginalsSDK,
  OriginalsAsset,
  LifecycleManager,
  createLocalSigner,
  type OriginalsSDKOptions,
  type AssetEnvelope,
  type AssetResource,
} from "@originals/sdk";
import type {
  OriginalsConfig,
  AssetEnvelope as SubpathEnvelope,
  AssetResourceInput,
  CelSigner,
  HostedEvidence,
  AssetVerification,
} from "@originals/sdk/types";
import {
  verifyHistory,
  type AssetState,
  type DeepReadonly,
} from "@originals/sdk/cel";
import { OriginalsSDK as LocalSDK } from "@originals/sdk/v3";

const signer: CelSigner = createLocalSigner(
  "Ed25519",
  new Uint8Array(32).fill(17),
);
const config: OriginalsConfig = { signer, network: "regtest" };
const options: OriginalsSDKOptions = config;
const input: AssetResourceInput = {
  id: "bytes",
  mediaType: "image/png",
  content: new Uint8Array([0, 255]),
};
const lifecycle: LifecycleManager = OriginalsSDK.create(options).lifecycle;
const asset: OriginalsAsset = await lifecycle.createAsset([input]);
const resource: AssetResource = asset.resources[0];
const envelope: AssetEnvelope = asset.serialize();
const hostedEvidence: HostedEvidence | undefined = (await asset.verification()).hosted;
const hostedVerification: AssetVerification['hosted'] = hostedEvidence;
void hostedVerification;
const subpathEnvelope: SubpathEnvelope = envelope;
const loaded: OriginalsAsset = (
  await SDK.create().lifecycle.loadAsset(subpathEnvelope)
).asset;
const state: DeepReadonly<AssetState> = verifyHistory(loaded.celLog).state;
await LocalSDK.create().lifecycle.loadAsset(loaded.serialize());
void resource;
void state;
// The old resource/custody contract must not typecheck against the new API.
const previousInput: AssetResourceInput = {
  id: "bytes",
  // @ts-expect-error CEL 3 computes the digest and uses mediaType.
  contentType: "image/png",
  hash: "caller-asserted",
};
const previousSigner: CelSigner = {
  // @ts-expect-error Previous-format signers omit the selected algorithm and controller.
  verificationMethodId: "did:key:old#key",
  sign: async () => new Uint8Array(64),
};
void previousInput;
void previousSigner;


// Network types must be reachable through the supported /types export map.
import type {
  SatProvider,
  AssetResolution,
  PreparedWebPublication,
  BitcoinPublicationOptions,
  PreparedBitcoinPublication,
  SubmittedBitcoinAsset,
  InscriptionRecoveryStore,
} from "@originals/sdk/types";
declare const satProvider: SatProvider;
declare const publicationOptions: BitcoinPublicationOptions;
declare const recoveryStore: InscriptionRecoveryStore;
const networkSDK = OriginalsSDK.create({ signer, network: "regtest", satProvider });
const hosted: PreparedWebPublication = await networkSDK.lifecycle.prepareWebPublication(asset, { domain: "example.com" });
const prepared: PreparedBitcoinPublication = await networkSDK.lifecycle.prepareBitcoinPublication(asset, publicationOptions);
const submitted: SubmittedBitcoinAsset = await networkSDK.lifecycle.publishPreparedToBitcoin(prepared, { recoveryStore });
const resolved: AssetResolution = await networkSDK.lifecycle.resolveAssetFromSat(prepared.transactions.satoshi);
// Per-resource-version chain-inline vs off-chain-referenced status is part of the public accepted shape.
if (resolved.status === "accepted") {
  const availability: "bitcoin-inline" | "referenced" = resolved.resourceAvailability[0].availability;
  void availability;
}
void hosted; void submitted; void resolved;

// The 3.0 freeze excludes confirmation hooks and event payloads from the former lifecycle.
// @ts-expect-error Previous asset-only quote type is not part of the CEL 3 API.
import type { AppendCostEstimate } from '@originals/sdk';
// @ts-expect-error Previous asset-only append kind is not part of the CEL 3 API.
import type { AppendKind } from '@originals/sdk';
// @ts-expect-error Current publications use explicit preparation and durable submission.
import type { InscribeConfirm } from '@originals/sdk';
// @ts-expect-error CEL 3 lifecycle returns explicit results, not these previous payloads.
import type { AssetTransferredEvent } from '@originals/sdk';
// @ts-expect-error The types subpath must not revive the removed quote contract.
import type { AppendCostEstimate as PreviousQuote } from '@originals/sdk/types';
// @ts-expect-error The types subpath must not revive the removed confirmation contract.
import type { InscribeConfirm as PreviousConfirm } from '@originals/sdk/types';

// SDK 4 identity change: stable offline subpath plus explicit SDK 3 read aliases.
import { parseAssetEnvelope, inspectAssetEnvelope, type AssetEnvelopeInspection } from '@originals/sdk/asset-envelope';
import { inspectAssetEnvelope as inspectRootEnvelope } from '@originals/sdk';
import { inspectAssetEnvelope as inspectLocalEnvelope } from '@originals/sdk/v3';
import { deriveAssetId, deriveDid, normalizeAssetId, assetDigest } from '@originals/sdk/cel';
const currentEnvelope: AssetEnvelope = parseAssetEnvelope(envelope);
const inspected: AssetEnvelopeInspection = inspectAssetEnvelope(envelope);
const inspectedEnvelope: AssetEnvelope = inspected.envelope;
const inspectedState: DeepReadonly<AssetState> = inspected.history.state;
inspectRootEnvelope(envelope);
inspectLocalEnvelope(envelope);
// @ts-expect-error Structural decoding is internal; public readers authenticate history.
import { decodeEnvelope } from '@originals/sdk/asset-envelope';
// @ts-expect-error Authenticated state is immutable.
inspectedState.name = 'replacement';
void inspectedEnvelope;
const currentVersion: 4 = currentEnvelope.version;
const canonicalAssetId: string = state.assetId;
const legacyAlias: string = state.didCel;
const legacyEnvelope = {
  format: 'originals/asset', version: 3, assetDid: legacyAlias,
  eventLog: loaded.celLog, resources: currentEnvelope.resources,
};
await SDK.create().lifecycle.loadAsset(legacyEnvelope);
verifyHistory(loaded.celLog, {expectedDid: legacyAlias, expectedAssetId: canonicalAssetId});
const canonicalFromEvent: string = deriveAssetId(loaded.celLog.log[0].event);
const legacyFromEvent: string = deriveDid(loaded.celLog.log[0].event);
const digest: string = assetDigest(normalizeAssetId(legacyFromEvent));
// @ts-expect-error New envelopes do not expose the removed unsigned field.
currentEnvelope.assetDid;
void currentVersion; void canonicalFromEvent; void digest;
