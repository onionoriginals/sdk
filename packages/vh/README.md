# @originals/vh

Verifiable History for the [Originals Protocol](../../specs/README.md): the
layers under each Original's `did:vh` asset log. The package is private and
unpublished while plan 011 is in progress. It is browser-safe, with no Node
builtins or `Buffer` in any entry.

| Subpath | Contents |
|---|---|
| `@originals/vh/json` | Strict JSON and JSON Lines parsing (duplicate keys, lone surrogates, lossy integers and `-0` rejected), JCS (RFC 8785) |
| `@originals/vh/crypto` | base58btc multibase, sha2-256 multihash, Ed25519 and compressed secp256k1 Multikeys, did:key verification methods, `eddsa-jcs-2022` and `bip340-jcs-2025` proofs |
| `@originals/vh/log` | The generic VH-Log engine: SCID, entry hashes, parameters, update keys and pre-rotation, keys from a controller (VH-Log PR 11), witness thresholds, versionTime precision (PR 8), version selection, building entries |
| `@originals/vh/didvh` | did:vh resolution with logs passed directly, and the extension mechanism (did:vh PR 3) |

The root entry re-exports all of them, plus `OriginalsError` and its error
categories.

## Status against plan 011

This is PR 2. Later PRs add these, in order:
- the `originals:1.0` extension and did:webvh (PR 3);
- comparing copies and retained versionIds (PR 6);
- retrieval from `src` and watchers (PR 7);
- authoritative sources and alternative encodings (PR 9).

Until those land, the resolver returns `featureNotSupported` for `src`,
`checkWatchers`, `extraWatchers` and `minCopies`.

## Evidence

Tests use independently produced fixtures, never vectors this code generated:
- the W3C `eddsa-jcs-2022` test vectors, signed byte for byte;
- `bip340-jcs-2025` proofs from `@did-btcr2/cryptosuite@10.0.1`, covering keys
  with both y parities;
- did:webvh 1.0 logs from `didwebvh-ts@2.8.0`, covering pre-rotation, rotation,
  witness activation, witness removal and deactivation.

The generator scripts are in `tests/fixtures/generators/`. They are run outside
the repository, against separately installed packages. The worked entry-hash
example in the VH-Log spec does not reproduce (spec finding S7), so it is not
used as a vector.
