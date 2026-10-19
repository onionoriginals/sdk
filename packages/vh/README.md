# @originals/vh

Verifiable History for the [Originals Protocol](../../specs/README.md): the
layers under each Original's `did:vh` asset log. The package is private and
unpublished while plan 011 is in progress. It is browser-safe, with no Node
builtins or `Buffer` in any entry.

| Subpath | Contents |
|---|---|
| `@originals/vh/json` | Strict JSON and JSON Lines parsing (duplicate keys, lone surrogates, lossy integers and `-0` rejected), JCS (RFC 8785) |
| `@originals/vh/crypto` | base58btc multibase, sha2-256 multihash, Ed25519 and compressed secp256k1 Multikeys, did:key verification methods, `eddsa-jcs-2022` and `bip340-jcs-2025` proofs |
| `@originals/vh/log` | The generic VH-Log engine: SCID, entry hashes, parameters, update keys and pre-rotation, keys from a controller (VH-Log PR 11), witness thresholds, versionTime precision (PR 8), comparing copies with retained versionIds and `minCopies`, version selection, building entries |
| `@originals/vh/didvh` | did:vh resolution with logs passed directly, and the extension mechanism (did:vh PR 3) |
| `@originals/vh/webvh` | did:webvh 1.0 on VH-Log (didwebvh PR 302): identifier rules, DID-to-HTTPS transformation, portability, implicit services, resolution of logs passed directly |
| `@originals/vh/originals` | The `originals:1.0` extension: asset state rules, author DID histories and binding (P5.2, P5.3, P5.8, P5.11), the derived DID document, entry builders and `verifyOriginal`'s report |

The root entry re-exports all of them, plus `OriginalsError` and its error
categories.

## Status against plan 011

PRs 2 and 3 are in. Later PRs add these, in order:
- the SDK's local workflow and the evidence package (PR 4);
- author DID rotation, freshness and forks (PR 6);
- witnesses, the did:webvh alias, and retrieval from `src` and from watchers (PR 7);
- authoritative sources and alternative encodings (PR 9).

The engine compares copies it is given (`resolveCopies`). Until retrieval
lands, the did:vh resolver returns `featureNotSupported` for `src`,
`checkWatchers`, `extraWatchers` and `minCopies`.

## Evidence

Tests use independently produced fixtures, never vectors this code generated:
- the shared vh interop vectors (`brianorwhatever/vh@f5176785`, profile
  `vh-log-interop-0`), all 170 passing: primitives, 158 resolution cases,
  generation with cross-resolution, the `didwebvh-ts` external logs and 89
  independent Ed25519 boundary cases. They run through `interop/handler.ts`,
  which is also the protocol driver (`bun interop/driver.ts`) for that
  repository's harness;
- the C2SP CCTV (914) and Wycheproof (151) Ed25519 corpora, under the profile's
  acceptance rules: canonical encodings, no small-order points and the
  uncofactored equation. noble's own `verify` is cofactored and accepts
  low-order residues, so the equation is checked in `verifyEd25519`;
- the W3C `eddsa-jcs-2022` test vectors, signed byte for byte;
- `bip340-jcs-2025` proofs from `@did-btcr2/cryptosuite@10.0.1`, covering keys
  with both y parities;
- did:webvh 1.0 logs from `didwebvh-ts@2.8.0`, covering pre-rotation, rotation,
  witness activation, witness removal and deactivation.

The interop profile differs from Originals in places. A strict parse rejects
duplicate keys and lossy integers, and a specialisation rejects unknown
parameters. The interop driver opts out of these through `INTEROP_PARSE` and
`vhLog10`; nothing Originals verifies does.

The generator scripts are in `tests/fixtures/generators/`. They are run outside
the repository, against separately installed packages. The worked entry-hash
example in the VH-Log spec does not reproduce (spec finding S7), so it is not
used as a vector.
