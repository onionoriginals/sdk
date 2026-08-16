/**
 * Mint the landing page's real example Original — run with:
 *   bun scripts/make-example.ts
 *
 * Uses the actual @originals/sdk (workspace source) to create a genuine
 * asset: real Ed25519 keys, a real did:cel genesis, the asset's own did:webvh with
 * a signed DID log, and a signed publication credential. The artifacts are
 * written to public/example/ and shipped statically; the landing page then
 * re-verifies all of it cryptographically in the visitor's browser.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OriginalsSDK, MemoryStorageAdapter } from '@originals/sdk';
import { OrdMockProvider } from '@originals/sdk/testing';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateArtwork } from '../src/sdk/artwork';

const outDir = join(import.meta.dir, '..', 'public', 'example');
mkdirSync(outDir, { recursive: true });

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The signed did:webvh log exactly as the SDK hosted it — read back from the
 * storage adapter rather than reconstructed here, so the shipped did-log.jsonl
 * is the published DID's log by construction and cannot drift from it.
 */
async function readHostedDidLog(did: string): Promise<string> {
  const parts = did.split(':');
  const domain = decodeURIComponent(parts[3]);
  const pathParts = parts.slice(4);
  const relativePath = pathParts.length
    ? `${pathParts.join('/')}/did.jsonl`
    : '.well-known/did.jsonl';
  const stored = await storage.getObject(domain, relativePath);
  if (!stored) {
    throw new Error(`No hosted DID log at ${domain}/${relativePath} for ${did}`);
  }
  return new TextDecoder().decode(stored.content);
}

const keys = new Map<string, string>();
const storage = new MemoryStorageAdapter();
const DOMAIN = 'magby.originals.build';
const sdk = OriginalsSDK.create({
  network: 'regtest',
  webvhNetwork: 'magby',
  defaultKeyType: 'Ed25519',
  ordinalsProvider: new OrdMockProvider(),
  storageAdapter: storage,
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

// 2 · Real did:cel genesis asset.
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

// 3 · Real publication. publishToWeb mints the asset's OWN did:webvh (genuine
//     SCID, signed genesis log); the argument contributes only the domain. Pass
//     the bare domain: minting a separate "publisher" did:webvh here and
//     shipping ITS log produced an example whose manifest/DID-log named one
//     did:webvh while the CEL migrate event and the credential named the
//     asset's — a green verifier checking two unrelated identities.
await sdk.lifecycle.publishToWeb(asset, DOMAIN);

if (asset.credentials.length === 0) {
  throw new Error('No credential was issued — the example must ship a real signed credential');
}

// 4 · The asset's published did:webvh and the signed log the SDK hosted for it.
const publishedDid = (asset.bindings as Record<string, string> | undefined)?.['did:webvh'];
if (!publishedDid) {
  throw new Error('publishToWeb did not bind a did:webvh to the asset');
}
const didLogJsonl = await readHostedDidLog(publishedDid);

// One identity, or nothing ships. Every artifact must name the SAME published
// did:webvh — a manifest/DID-log pair describing one identity while the CEL
// migrate event and credential describe another still verifies green, because
// each check only ever compares an artifact against itself.
const eventLog = asset.serialize().eventLog as unknown as {
  events: Array<{ type: string; data?: Record<string, unknown> }>;
};
const migrateTarget = eventLog.events.find((e) => e.type === 'migrate')?.data?.targetDid;
const credentialTarget = (
  asset.credentials[0] as unknown as { credentialSubject?: { migratedTo?: string } }
).credentialSubject?.migratedTo;
const logDid = (JSON.parse(didLogJsonl.trim().split('\n')[0]) as { state?: { id?: string } }).state
  ?.id;
for (const [source, value] of [
  ['did-log.jsonl', logDid],
  ['cel-log migrate.targetDid', migrateTarget],
  ['credential migratedTo', credentialTarget]
] as const) {
  if (value !== publishedDid) {
    throw new Error(
      `Inconsistent example: ${source} is ${String(value)}, expected ${publishedDid}`
    );
  }
}

// 5 · Ship the artifacts.
writeFileSync(join(outDir, 'artwork.svg'), art.svg);
writeFileSync(join(outDir, 'metadata.json'), metadata);
writeFileSync(join(outDir, 'credential.json'), JSON.stringify(asset.credentials[0], null, 2));
writeFileSync(
  join(outDir, 'did-log.jsonl'),
  didLogJsonl.endsWith('\n') ? didLogJsonl : `${didLogJsonl}\n`
);
// The CEL event log (create + migrate) — the browser re-derives the did:cel
// genesis identity from it (resolveDidCel verifies the whole signed chain and
// binds the DID) to check the publication credential, which is issued and
// self-signed by the did:cel.
writeFileSync(
  join(outDir, 'cel-log.json'),
  JSON.stringify(asset.serialize().eventLog, null, 2) + '\n'
);
writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify(
    {
      title: TITLE,
      medium: MEDIUM,
      dids: {
        'did:cel': (asset.bindings as Record<string, string>)['did:cel'] ?? asset.id,
        'did:webvh': publishedDid
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
console.log('  did:cel  :', asset.bindings?.['did:cel'] ?? asset.id);
console.log('  did:webvh:', publishedDid);
console.log('  artwork  :', svgHash);
console.log('  credential types:', asset.credentials[0].type.join(', '));
