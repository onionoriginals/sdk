/**
 * Builds the did:og PNG/MP4 handoff kit from onionoriginals/sdk at the commit recorded in
 * README.md, using only the SDK's own did:og code:
 *
 * - `createAuthorDid` (`@originals/sdk/og`): a new did:webvh author DID, signed by its update key;
 * - `createGenesis` (`@originals/sdk/og`): each Original's genesis entry, signed by the author's
 *   assertion key;
 * - `buildPackage` (`@originals/vh/og`): the P14.10 evidence package (manifest, asset log, signer
 *   history, resource), and `writePackageZip`, its deterministic ZIP writer, to add SHA256SUMS.
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
import { buildPackage, resourceDigest, serializeLog, writePackageZip } from "../../packages/vh/src/og/index.js";

const KIT = import.meta.dir;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = new TextEncoder();

/** One time for every signature, so a rebuild with the same keys would give the same bytes. */
const NOW = new Date("2026-11-25T08:00:00Z");

const ORIGINALS = [
  { slug: "png", file: "media/test-pattern-1280x720.png", mediaType: "image/png", name: "did:og handoff kit: PNG test pattern (1280x720)" },
  { slug: "mp4", file: "media/test-pattern-4s.mp4", mediaType: "video/mp4", name: "did:og handoff kit: MP4 test pattern (640x360, 4 s, H.264/AAC)" },
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
      name: o.name, bytes, mediaType: o.mediaType, network: "mainnet",
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
    // SHA256SUMS: one "<hex>  <name>" line per member, in the archive's own (byte) order.
    const names = Object.keys(pkg.files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const sums = names.map((n) => `${sha256(pkg.files[n])}  ${n}\n`).join("");
    const archive = writePackageZip({ ...pkg.files, SHA256SUMS: enc.encode(sums) });
    const zipName = `did-og-${o.slug}-evidence.zip`;
    writeFileSync(join(KIT, zipName), archive);
    writeFileSync(join(KIT, `${zipName}.sha256`), `${sha256(archive)}  ${zipName}\n`);
    summary[o.slug] = { zip: zipName, original, versionId: genesis.versionId, resource: { mediaType: o.mediaType, size: bytes.length, digest, sha256: sha256(bytes) }, manifest: pkg.manifest };
  }
  writeFileSync(join(KIT, "kit.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  rmSync(secrets, { recursive: true, force: true });
}
