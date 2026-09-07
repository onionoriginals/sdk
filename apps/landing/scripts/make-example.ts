/** Regenerate the bundled, independently verifiable CEL 3 example. No network writes. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OriginalsSDK,
  createLocalSigner,
  MemoryStorageAdapter,
} from "@originals/sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { generateArtwork } from "../src/sdk/artwork";

const directory = join(import.meta.dir, "..", "public", "example");
mkdirSync(directory, { recursive: true });
const signer = createLocalSigner(
  "Ed25519",
  crypto.getRandomValues(new Uint8Array(32)),
);
const storage = new MemoryStorageAdapter();
const sdk = OriginalsSDK.create({ signer, storageAdapter: storage });
const artwork = generateArtwork("First Light", "Orbits", 20260706).svg;
const metadata = JSON.stringify(
  { title: "First Light", style: "Orbits", creator: "Originals example" },
  null,
  2,
);
const asset = await sdk.lifecycle.createAsset(
  [
    { id: "artwork.svg", mediaType: "image/svg+xml", content: artwork },
    { id: "metadata.json", mediaType: "application/json", content: metadata },
  ],
  { name: "First Light" },
);
const prepared = await sdk.lifecycle.prepareWebPublication(asset, {
  domain: "magby.originals.build",
  paths: ["example", "cel3"],
});
const published = { did: prepared.did, asset };
const manifest = {
  format: "originals/example",
  version: 3,
  title: "First Light",
  style: "Orbits",
  dids: { "did:cel": asset.id, "did:webvh": published.did },
  resources: published.asset.resources.map((resource) => ({
    id: resource.id,
    contentType: resource.mediaType,
    hash: Array.from(sha256(resource.content!), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  })),
};
writeFileSync(join(directory, "artwork.svg"), artwork);
writeFileSync(join(directory, "metadata.json"), metadata);
writeFileSync(
  join(directory, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
writeFileSync(
  join(directory, "cel-log.json"),
  JSON.stringify(prepared.asset.eventLog, null, 2) + "\n",
);
writeFileSync(
  join(directory, "did-log.jsonl"),
  prepared.didLog.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
);
console.log(`Generated CEL 3 example ${asset.id}`);
