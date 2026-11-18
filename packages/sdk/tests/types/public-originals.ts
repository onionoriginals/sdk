// Compile against the installed export map, independently of the SDK source tsconfig.
import SDK, {
  OriginalsSDK,
  MemoryStore,
  keySigner,
  readZip,
  writeZip,
  headOf,
  createDIDOriginal,
  updateDIDOriginal,
  verifyDIDSignature,
  prepareDIDDataForSigning,
  StructuredError,
  multikey,
  canonicalDidKeyVm,
  signingInput,
  encoding,
  validateSatoshiNumber,
  isValidBitcoinAddress,
  normalizeInscriptionId,
  normalizeSatpoint,
  prepareInscriptionOnSat,
  validateInscriptionReveal,
  base58AddressToEd25519Multikey,
  Ed25519Verifier,
  MemoryStorageAdapter,
  RegtestProvider,
  QuickNodeProvider,
  createBitcoinCoreChainValidator,
  type OriginalsSDKOptions,
  type OriginalsSigner,
  type OriginalView,
  type CreateDIDOriginalOptions,
  type UpdateDIDOriginalOptions,
  type OriginalResult,
  type ExternalSigner,
  type ExternalVerifier,
  type BitcoinSigner,
  type StorageAdapter,
  type OrdinalsProvider,
  type SatSnapshot,
  type InscribeOnSatResult,
} from "@originals/sdk";
import type { OriginalsSDKOptions as SubpathOptions, SatSnapshot as SubpathSnapshot } from "@originals/sdk/types";
import { OrdMockProvider, FeeOracleMock } from "@originals/sdk/testing";
import { OriginalsSDK as Subpath } from "@originals/sdk/originals";
import { FileStore } from "@originals/sdk/originals/fs";

const sameClass: typeof OriginalsSDK = SDK;
const sameSubpath: typeof OriginalsSDK = Subpath;
// There is no freshness option: an unanchored Original is never current (P7.10; originals-spec #46).
const options: OriginalsSDKOptions = { store: new MemoryStore(), authors: [] };
const subpathOptions: SubpathOptions = options;
const sdk: OriginalsSDK = OriginalsSDK.create(options);
const signer: OriginalsSigner = keySigner({ keyType: "Ed25519", secretKey: new Uint8Array(32), verificationMethod: "did:webvh:z:example.com#orig-1" });
const maybeView: Promise<OriginalView> = sdk.get("did:vh:example");
const validAsOf: Promise<string | undefined> = maybeView.then((v) => v.validAsOf?.signers[0]?.obtainedAt ?? undefined);
const zip: Uint8Array = writeZip(new Map([["a.txt", new Uint8Array([1])]]));
const files: Map<string, Uint8Array> = readZip(zip);
const head: string | null = headOf(undefined);

declare const didSigner: ExternalSigner;
declare const didVerifier: ExternalVerifier;
const createOptions: CreateDIDOriginalOptions = { type: "did", domain: "example.com", signer: didSigner, verifier: didVerifier, updateKeys: [], verificationMethods: [] };
const created: Promise<OriginalResult> = createDIDOriginal(createOptions);
declare const updateOptions: UpdateDIDOriginalOptions;
const updated: Promise<OriginalResult> = updateDIDOriginal(updateOptions);
const verified: Promise<boolean> = verifyDIDSignature(new Uint8Array(64), new Uint8Array(1), new Uint8Array(32));
const prepared: Promise<Uint8Array> = prepareDIDDataForSigning({}, {});

const error: StructuredError = new StructuredError("CODE", "message", { detail: 1 });
const code: string = error.code;
const vm: string = canonicalDidKeyVm("z6Mk");
const preimage: Promise<Uint8Array> = signingInput.didWebvh({}, {});
const bytes: Uint8Array = encoding.hexToBytes("00");
const mk: string = multikey.encodePublicKey(new Uint8Array(32), "Ed25519");
const sat: boolean = validateSatoshiNumber("1").valid;
const address: boolean = isValidBitcoinAddress("bc1q", "mainnet");
const id: string = normalizeInscriptionId("x");
const satpoint: string | null = normalizeSatpoint(null);
const custody: string = base58AddressToEd25519Multikey("1");
const verifier = new Ed25519Verifier();
const storage = new MemoryStorageAdapter();
declare const hostAdapter: StorageAdapter;
const provider: OrdinalsProvider = new OrdMockProvider();
const fees = new FeeOracleMock();
const snapshot = (s: SatSnapshot): SubpathSnapshot => s;
declare const bitcoinSigner: BitcoinSigner;
declare const result: InscribeOnSatResult;
const validator = createBitcoinCoreChainValidator({ endpoint: "http://127.0.0.1:8332" });
const fileStore: Promise<FileStore> = FileStore.open("/tmp/originals");

void [hostAdapter, sameClass, sameSubpath, subpathOptions, signer, maybeView, files, head, created, updated, verified, prepared, code, vm, preimage, bytes, mk, sat, address, id, satpoint, custody, verifier, storage, provider, fees, snapshot, bitcoinSigner, result, validator, fileStore, prepareInscriptionOnSat, validateInscriptionReveal, RegtestProvider, QuickNodeProvider];
