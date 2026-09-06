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
