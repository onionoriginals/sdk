import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Official release artifacts, pinned independently of the download response.
const releases = {
  'darwin-arm64': [
    ['bitcoin-31.1-arm64-apple-darwin.tar.gz', 'https://bitcoincore.org/bin/bitcoin-core-31.1/', '16a097c09fbd7eb78b240ce1dae123663ea2e5e377cfd6a951e71e227e23cf2f'],
    ['ord-0.29.0-aarch64-apple-darwin.tar.gz', 'https://github.com/ordinals/ord/releases/download/0.29.0/', '9360e97054a1d96624190634882c187126b02647a889b344cb601627ed1bd80c'],
  ],
  'linux-x64': [
    ['bitcoin-31.1-x86_64-linux-gnu.tar.gz', 'https://bitcoincore.org/bin/bitcoin-core-31.1/', 'b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e'],
    ['ord-0.29.0-x86_64-unknown-linux-gnu.tar.gz', 'https://github.com/ordinals/ord/releases/download/0.29.0/', 'f65c758d71549954470aa7fe23b197478688fb4f910e84c2956cf9144078a94e'],
  ],
} as const;

export async function installRegtestTools() {
  const platform = `${process.platform}-${process.arch}`;
  const artifacts = releases[platform as keyof typeof releases];
  if (!artifacts) throw new Error(`No pinned binaries for ${platform}; set BITCOIND_BIN and ORD_BIN explicitly.`);
  const directory = resolve(process.env.REGTEST_TOOLS_DIR ?? join(homedir(), '.cache', 'originals-regtest', 'core31.1-ord0.29.0'));
  await mkdir(directory, { recursive: true });
  for (const [filename, base, expected] of artifacts) {
    const archive = Bun.file(join(directory, filename));
    if (!await archive.exists()) {
      console.log(`Downloading ${filename}`);
      const response = await fetch(base + filename, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Download failed: ${response.status} ${filename}`);
      await Bun.write(archive, response);
    }
    const actual = createHash('sha256').update(new Uint8Array(await archive.arrayBuffer())).digest('hex');
    if (actual !== expected) throw new Error(`SHA256 mismatch: ${archive.name}; remove it before retrying.`);
    const extract = Bun.spawn(['tar', '-xzf', archive.name!, '-C', directory], { stdout: 'ignore', stderr: 'inherit' });
    if (await extract.exited) throw new Error(`Extraction failed: ${filename}`);
  }
  return { BITCOIND_BIN: join(directory, 'bitcoin-31.1', 'bin', 'bitcoind'), ORD_BIN: join(directory, 'ord-0.29.0', 'ord') };
}

if (import.meta.main) console.log(JSON.stringify(await installRegtestTools(), null, 2));
