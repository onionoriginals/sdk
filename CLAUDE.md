# Repository guidance

The SDK is being rebuilt on the Originals Protocol, which replaces the CEL 3
design. Before changing asset behavior, read the pinned documents listed in
[`specs/README.md`](specs/README.md), the delivery plan
[`plans/011-originals-vh-replacement.md`](plans/011-originals-vh-replacement.md),
and the consumer contract [`packages/sdk/ORIGINALS.md`](packages/sdk/ORIGINALS.md).
[CONTEXT.md](CONTEXT.md) defines author, owner, witness and checkpoint
terminology. Cite spec rules by ID (P5.3, D4) in code comments, tests and PRs.

## Implementation routes

- `packages/vh` (`@originals/vh`, introduced in plan PR 2) holds the strict JSON/JCS layer, the
  `eddsa-jcs-2022` and `bip340-jcs-2025` cryptosuites, the generic VH-Log
  engine with its specialisation hooks, the did:vh and did:webvh resolvers,
  and the `originals:1.0` extension (state rules, author binding, derived DID
  document, verification report, evidence packages).
- `packages/sdk` (`@originals/sdk`) keeps the create, edit, load, verify and
  publish workflow on top of `@originals/vh`, together with durable local
  storage, signers, hosting, witnesses and Bitcoin adapters.
- `packages/auth` (`@originals/auth`) creates and updates author DIDs with
  `didwebvh-ts` (did:webvh 1.0). Those DIDs are verified by our own engine
  under experimental did:webvh (PR 302).
- The CEL 3 implementation (`packages/cel`, `packages/sdk/src/v3`,
  `OriginalsSDK3.ts`) and the earlier formats were deleted in plan 011 PR 5.
  Do not reintroduce them, add compatibility shims for them, or port their
  APIs. No Originals were issued under them, so there is no conversion,
  migration or legacy verifier.

## Contracts to preserve

- **One author, one signature.** Each entry is signed once, by a key that the
  author DID embeds under `assertionMethod` at the version the entry names, and
  that is not an update key of the author DID's own log (P5.2, P5.3, P5.11;
  owner decision S8). The author DID is fixed at genesis. Rotation happens only
  in the author DID, never in the asset log (P5.8–P5.10).
- **Forks stay unresolved off-chain.** Divergent valid branches are reported as
  a conflict with no current branch. Only anchoring on Bitcoin settles a fork
  (owner decision S1, P9.16).
- **Ownership is not authority.** The owner of an anchored Original is the
  holder of its anchoring sat. Holding the sat never confers authority to sign
  changes (P9.11, P9.12).
- **No silent choices.** Never pick a branch by timestamp. Never rebase an edit
  onto a moved parent: that is a conflict (P2.1, P4.5). Never report
  generic VH-Log or DID resolution as Originals verification (P3.5).
- **Reports stay separate.** History, author binding, identity evidence,
  resource availability, ordering and freshness are reported separately. A
  missing item is an explicit incomplete result, never a pass (section 7).
- **Layers move one way.** An Original moves from local to web, and from
  either to Bitcoin. Anchoring is terminal and happens once. Hosted Originals
  use witnesses declared in the author DID (P9.8–P9.10, P9.16).
- **Spec first.** Where a pinned document is ambiguous or contradicts itself
  in a way that blocks the work, stop and report the rule ID with a proposed
  fix. Choices the spec leaves open are marked `PROVISIONAL` in code and docs.

## Editing and verification

Follow the package scripts for build, typecheck, lint and focused tests. Root
scripts orchestrate package work. Tests preload `setup.bun.ts`; avoid
importing it directly.

- Write tests before behavior, driven by the section 12 matrix in
  [`specs/originals-conformance.json`](specs/originals-conformance.json),
  including its negative rows. A test that covers a row cites its `C12-NN` ID.
- Reproduce a bug before fixing it, and run the relevant regression after
  each fix.
- Errors at public seams use `StructuredError` and its Originals successor
  with the categories from spec section 6.
- Built exports need Node ESM (`verify:esm`) and browser-safety
  (`verify:browser`) checks in addition to Bun tests.
- Provider and writer changes need real Core/ord regtest evidence as well as
  unit fixtures.
- Final public-host or mainnet proof is an owner release gate. Fixtures, dry
  runs and disposable regtest do not establish it.
- Bitcoin spending, mainnet or testnet activity and npm publishing require
  the owner's explicit approval. Disposable regtest is fine.

Use `.js` extensions in TypeScript imports that become Node ESM. Noble imports
use explicit `.js` subpaths such as `@noble/hashes/sha2.js`. Public byte
interfaces use `Uint8Array`. Keys are Multikey with base58btc multibase. Only
the two pinned cryptosuites are accepted (P5.12).
