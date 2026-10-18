# Fixtures

Every fixture here was produced by code other than `@originals/vh`. Regenerating
one from this package's own output would defeat the purpose, so don't.

| Fixture | Source |
|---|---|
| `w3c-eddsa-jcs-2022/` | `w3c/vc-di-eddsa@13e70705` (2026-09-01), `TestVectors/` (key pair and unsigned document) and `TestVectors/eddsa-jcs-2022/` |
| `bip340-jcs-2025.didbtcr2.json` | `generators/gen-bip340.mjs` run against `@did-btcr2/cryptosuite@10.0.1`, installed in a scratch directory outside the repository |
| `didwebvh-ts-2.8.0.json` | `generators/gen-webvh.mjs` run against `didwebvh-ts@2.8.0`. SCIDs, entry hashes, `eddsa-jcs-2022` hashing, pre-rotation and witness proofs all come from that library; the script supplies only seeded Ed25519 keys |

Each generator takes the directory holding the library's `node_modules` as its
argument, for example `node gen-webvh.mjs /path/to/checkout`. All keys are
seeded test keys and must never be used anywhere else.
