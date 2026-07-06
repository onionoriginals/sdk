/**
 * Mint the landing page's real example Original — run with:
 *   bun scripts/make-example.ts
 *
 * Uses the actual @originals/sdk (workspace source) to create a genuine
 * asset: real Ed25519 keys, real did:peer, a real did:webvh publisher with
 * a signed DID log, and a signed publication credential. The artifacts are
 * written to public/example/ and shipped statically; the landing page then
 * re-verifies all of it cryptographically in the visitor's browser.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OriginalsSDK,
  OrdMockProvider,
  MemoryStorageAdapter,
  Ed25519Signer,
  Ed25519Verifier,
  KeyManager
} from '@originals/sdk';
import { multikey } from '@originals/sdk/crypto/Multikey';
import { prepareDataForSigning } from 'didwebvh-ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateArtwork } from '../src/sdk/artwork';

const outDir = join(import.meta.dir, '..', 'public', 'example');
mkdirSync(outDir, { recursive: true });

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const keys = new Map<string, string>();
const sdk = OriginalsSDK.create({
  network: 'regtest',
  webvhNetwork: 'magby',
  defaultKeyType: 'Ed25519',
  ordinalsProvider: new OrdMockProvider(),
  storageAdapter: new MemoryStorageAdapter(),
  enableLogging: false,
  keyStore: {
    async getPrivateKey(id: string) {
      return keys.get(id) ?? null;
    },
    async setPrivateKey(id: string, key: string) {
      keys.set(id, key);
    },
    getAllVerificationMethodIds() {
      return [...keys.keys()];
    }
  }
} as unknown as Parameters<typeof OriginalsSDK.create>[0]);

const TITLE = 'First Light';
const MEDIUM = 'Artwork';
const NONCE = 20260706;
// Pinned so re-runs produce byte-identical metadata (and therefore the same
// resource hash). Keys and DIDs are still freshly generated on every run —
// this script is a minting operation, not a reproducible build; regenerate
// all artifacts together and commit them together.
const MINTED_AT = '2026-07-06T06:42:31.217Z';

// 1 · The artwork — same generator the interactive demo uses.
const art = generateArtwork(TITLE, MEDIUM, NONCE);
const svgBytes = new TextEncoder().encode(art.svg);
const svgHash = toHex(sha256(svgBytes));

const metadata = JSON.stringify(
  {
    title: TITLE,
    medium: MEDIUM,
    creator: 'Originals SDK',
    created: MINTED_AT,
    artwork: { file: 'artwork.svg', sha256: svgHash }
  },
  null,
  2
);
const metaBytes = new TextEncoder().encode(metadata);

// 2 · Real did:peer asset.
const asset = await sdk.lifecycle.createAsset([
  {
    id: 'artwork.svg',
    type: 'image',
    content: art.svg,
    contentType: 'image/svg+xml',
    hash: svgHash,
    size: svgBytes.length
  },
  {
    id: 'metadata.json',
    type: 'data',
    content: metadata,
    contentType: 'application/json',
    hash: toHex(sha256(metaBytes)),
    size: metaBytes.length
  }
]);

// 3 · Real did:webvh publisher with a signed log. An explicit external
//     signer lets us pin the verification-method id to '#key-0' so the
//     document's authentication/assertionMethod relationships (which the
//     SDK emits as ['#key-0']) reference the actual key — required for
//     third-party credential verification to pass its proof-purpose check.
const keyPair = await new KeyManager().generateKeyPair('Ed25519');
const signer = new Ed25519Signer();
const updateKeyVmId = `did:key:${keyPair.publicKey}#${keyPair.publicKey}`;
const externalSigner = {
  async sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }) {
    const data = await prepareDataForSigning(input.document, input.proof);
    const signature = await signer.sign(Buffer.from(data), keyPair.privateKey);
    return { proofValue: multikey.encodeMultibase(signature) };
  },
  getVerificationMethodId() {
    return updateKeyVmId;
  }
};

const webvh = await sdk.did.createDIDWebVH({
  paths: ['examples', 'first-light'],
  externalSigner,
  externalVerifier: new Ed25519Verifier(),
  updateKeys: [keyPair.publicKey],
  verificationMethods: [
    { id: '#key-0', type: 'Multikey', publicKeyMultibase: keyPair.publicKey }
  ] as never
});
const result = webvh as unknown as {
  did: string;
  didDocument: { id: string; verificationMethod?: Array<{ id: string }> };
  log: unknown;
};
await sdk.lifecycle.registerKey(`${result.did}#key-0`, keyPair.privateKey);
await sdk.did.cache.set(result.did, result.didDocument as never);

// 4 · Real publication — migrates to did:webvh and signs the credential.
await sdk.lifecycle.publishToWeb(asset, result.did);

if (asset.credentials.length === 0) {
  throw new Error('No credential was issued — the example must ship a real signed credential');
}

// 5 · Ship the artifacts.
writeFileSync(join(outDir, 'artwork.svg'), art.svg);
writeFileSync(join(outDir, 'metadata.json'), metadata);
writeFileSync(join(outDir, 'credential.json'), JSON.stringify(asset.credentials[0], null, 2));
writeFileSync(
  join(outDir, 'did-log.jsonl'),
  (result.log as unknown[]).map((entry) => JSON.stringify(entry)).join('\n') + '\n'
);
writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify(
    {
      title: TITLE,
      medium: MEDIUM,
      dids: {
        'did:peer': (asset.bindings as Record<string, string>)['did:peer'] ?? asset.id,
        'did:webvh': result.did
      },
      resources: asset.resources.map((r) => ({
        id: r.id,
        contentType: r.contentType,
        hash: r.hash
      })),
      provenance: asset.getProvenance(),
      generator: { seed: { title: TITLE, medium: MEDIUM, nonce: NONCE } }
    },
    null,
    2
  )
);

console.log('Example Original written to public/example/');
console.log('  did:peer :', asset.bindings?.['did:peer'] ?? asset.id);
console.log('  did:webvh:', result.did);
console.log('  artwork  :', svgHash);
console.log('  credential types:', asset.credentials[0].type.join(', '));
