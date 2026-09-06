# Repository guidance

For asset API changes, examples, or consumer integrations, read
[packages/sdk/V3.md](packages/sdk/V3.md) before editing. It is the current CEL 3
API contract. Read [CONTEXT.md](CONTEXT.md) for controller, holder, publication,
and verified-head terminology. The selected
[wire profile](specs/originals-cel-v3-profile.md),
[authority contract](specs/originals-cel-v3-authority.md), and
[inscription shape](specs/btco-inscription-shape.md) govern protocol behavior.

## Implementation routes

- The default SDK is `packages/sdk/src/core/OriginalsSDK3.ts`; its lifecycle and
  asset implementation live in `packages/sdk/src/v3/`. The `/v3` entry is the
  smaller local-only SDK. The `/cel` entry re-exports `@originals/cel/v3`.
- The deterministic CEL 3 parser, proofs, fold, and publication acceptance live
  in `packages/cel/src/v3/`. Shared primitives and retained previous-format code
  also live in the CEL package; choose the explicit `/v3` API for new histories.
- Standalone WebVH identity helpers live in `packages/sdk/src/did/identity-operations.ts`.
  `@originals/auth` consumes those helpers. An identity method document does not
  establish an Original's asset publication.
- Fresh Bitcoin asset and DID reads share `packages/sdk/src/v3/resolution.ts`.
  Hosted publication/recovery uses `hosted.ts`; Bitcoin preparation and submission
  use `bitcoin.ts`. The public CLI is `packages/sdk/src/v3/cli.ts`.
- The landing uses the default CEL 3 SDK. Durable transaction admission and
  reconciliation live in `apps/landing/server/bitcoin.ts`; the disposable real
  Core/ord journey lives in `scripts/regtest/`.

## Contracts to preserve

Each operation is authorized by the current controller. Rotation retires the
outgoing key; holding or reacquiring the sat does not restore its authority.
Bitcoin possession is observed separately. After anchoring, signed offline edits
are proposals until accepted on the correct sat. An ordinary DID read exposes
no active document after accepted deactivation.

The lifecycle is cel → webvh → btco. Every hosted publication requires an
explicit domain, including standalone `createDIDWebVH` and
`migrateToDIDWebVH` identity calls. `webvhNetwork` retains utility network mapping;
it does not select a hosting domain. No deployment is implied by a network name.

Bitcoin boundaries carry the full signed history through migration; later
publications carry exact deltas from the fresh accepted head. Inline media is raw
bytes with CEL CBOR metadata; a log-only body is `application/cel` JSON. Provider
snapshots must establish complete enumeration, byte integrity, index health and
active-chain ordering. Retained prepared pairs enable exact recovery after
ambiguous acknowledgements. Fresh acceptance and confirmation depth remain
separate from local signing, submission, and the six-confirmation retention rule.

## Editing and verification

Follow the package scripts for build, typecheck, lint, and focused tests. Root
scripts orchestrate package work. Tests preload `setup.bun.ts`; avoid importing
it directly. Add tests before new behavior, reproduce bugs before fixing them,
and run the relevant regression after each fix. Use `StructuredError` or the
CEL 3 `CelError` contract appropriate to the public seam.

Built exports need Node ESM and browser-safety checks in addition to Bun tests.
Provider and writer changes need actual Core/ord regtest evidence as well as
unit fixtures. Keep previous-format regression counts separate from new-format
release evidence. Final public-host/mainnet proof is an owner release gate;
fixtures, dry runs, and disposable regtest do not establish it.

Use `.js` extensions in TypeScript imports that become Node ESM. Noble imports
use `@noble/hashes/sha2.js`. Public byte interfaces use `Uint8Array`; Multikey
encoding uses multibase, with the algorithm-specific CEL signer contract kept
separate from the retained `OriginalsSigner` utility. Standalone WebVH signing
accepts either a key pair or an external signer, with the appropriate verifier.

For maintenance of retained previous-format modules and their regression tests,
consult [the historical development reference](docs/history/previous-sdk/CLAUDE.md).
Its old asset APIs and authority rules are not a compatibility path for 3.0.
