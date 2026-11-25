/**
 * Builds the did:og PNG/MP4 handoff kit from onionoriginals/sdk at the commit recorded in
 * README.md, using only the SDK's own did:og code:
 *
 * - `createAuthorDid` (`@originals/sdk/og`): a new did:webvh author DID, signed by its update key;
 * - `createGenesis` (`@originals/sdk/og`): each Original's genesis entry, signed by the author's
 *   assertion key;
 * - `buildPackage` (`@originals/vh/og`): the P14.10 evidence package. Each ZIP is exactly the
 *   archive it returns, with only the members P14.10 defines.
 *
 * Checksums are written next to each ZIP, never inside it:
 * - `<zip>.sha256`: the ZIP itself;
 * - `<zip>.contents.sha256`: each member, by its path inside the ZIP.
 *
 * The author's secret keys are generated into a temporary directory outside the repository and
 * deleted when the build ends. They are never printed or written to the kit.
 *
 * Run from the repository root: bun handoff/did-og-png-mp4-kit/build-kit.ts
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthorDid, createGenesis } from "../../packages/sdk/src/og/index.js";
import { generateKeyFile } from "../../packages/sdk/src/og/keys.js";
import { buildPackage, resourceDigest, serializeLog } from "../../packages/vh/src/og/index.js";

const KIT = import.meta.dir;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = new TextEncoder();
const byName = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** One time for every signature. */
const NOW = new Date("2026-11-25T09:00:00Z");

const ORIGINALS = [
  {
    slug: "png", file: "media/mars-curiosity-hazcam-2012-08-07.png", mediaType: "image/png",
    name: "Mars, Gale Crater: one of the first Curiosity rear Hazcam images (NASA/JPL-Caltech, 2012-08-07)",
    metadata: { source: "https://commons.wikimedia.org/wiki/File:Landscape-MarsCuriosity.png", author: "NASA/JPL-Caltech", licence: "Public domain (PD-NASA)" },
  },
  {
    slug: "mp4", file: "media/pangong-tso-waves-720p.mp4", mediaType: "video/mp4",
    name: "Small waves on the shore of Pangong Tso (Satalah, July 2021), 3.8 s",
    metadata: { source: "https://commons.wikimedia.org/wiki/File:Pangong_Tso_Waves.webm", author: "Satalah", licence: "CC0 1.0", note: "transcoded from the source WebM (VP9, 1080p) to H.264 MP4, 720p; no trim" },
  },
] as const;

const secrets = mkdtempSync(join(tmpdir(), "og-handoff-keys-"));
try {
  const keys = generateKeyFile(join(secrets, "author-keys.json"));
  // Not hosted anywhere: a verifier reads this DID's log from the package, never from its URL.
  const author = await createAuthorDid(keys, { domain: "example.com", path: ["authors", "og-handoff-kit"], now: NOW });
  const authorLog = enc.encode(author.log);
  const summary: Record<string, unknown> = { author: { did: author.did, versionId: author.versionId, url: author.url } };

  for (const o of ORIGINALS) {
    const bytes = new Uint8Array(readFileSync(join(KIT, o.file)));
    const genesis = await createGenesis({
      name: o.name, bytes, mediaType: o.mediaType, network: "mainnet", metadata: { ...o.metadata },
      author: { did: author.did, verificationMethod: author.verificationMethod, versionId: author.versionId, log: author.log, signer: keys.assertion },
      now: () => NOW,
    });
    const original = (genesis.state as { id: string }).id;
    const digest = resourceDigest(bytes);
    const pkg = buildPackage({
      original,
      assetLog: enc.encode(serializeLog([genesis])),
      versionIds: [genesis.versionId],
      signers: [{ did: author.did, log: authorLog }],
      resources: { [digest]: bytes },
      missing: [],
    });
    const zipName = `did-og-${o.slug}-evidence.zip`;
    writeFileSync(join(KIT, zipName), pkg.archive);
    writeFileSync(join(KIT, `${zipName}.sha256`), `${sha256(pkg.archive)}  ${zipName}\n`);
    const members = Object.keys(pkg.files).sort(byName);
    writeFileSync(join(KIT, `${zipName}.contents.sha256`), members.map((n) => `${sha256(pkg.files[n])}  ${n}\n`).join(""));
    summary[o.slug] = { zip: zipName, original, versionId: genesis.versionId, members, resource: { file: o.file, mediaType: o.mediaType, size: bytes.length, digest, sha256: sha256(bytes) }, manifest: pkg.manifest };
  }
  writeFileSync(join(KIT, "kit.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  rmSync(secrets, { recursive: true, force: true });
}
