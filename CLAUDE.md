# Repository guidance

The SDK is being rebuilt on the Originals Protocol, which replaces the CEL 3
design. Before changing asset behavior, read the pinned documents listed in
[`specs/README.md`](specs/README.md), the delivery plan
[`plans/011-originals-vh-replacement.md`](plans/011-originals-vh-replacement.md),
and the consumer contract [`packages/sdk/ORIGINALS.md`](packages/sdk/ORIGINALS.md).
[CONTEXT.md](CONTEXT.md) defines author, owner and checkpoint
terminology. Cite spec rules by ID (P5.3, D4) in code comments, tests and PRs.

## Implementation routes

- `packages/vh` (`@originals/vh`, introduced in plan PR 2) holds the strict JSON/JCS layer, the
  `eddsa-jcs-2022` and `bip340-jcs-2025` cryptosuites, the generic VH-Log
  engine with its specialisation hooks, the did:vh and did:webvh resolvers,
  and the `originals:1.0` extension (state rules, author binding, derived DID
  document, verification report, evidence packages).
- `packages/sdk` (`@originals/sdk`) keeps the create, edit, load, verify and
  publish workflow on top of `@originals/vh`, together with durable local
  storage, signers, hosting and Bitcoin adapters.
- `packages/auth` (`@originals/auth`) creates and updates author DIDs with
  `didwebvh-ts` (did:webvh 1.0). Those DIDs are verified by our own engine
  under experimental did:webvh (PR 302).
- `packages/host` (`@originals/host`, Bun) is the hosted publication server:
  hosted layout and durable Originals routes, shared-host saves, the
  inscriptions store, reconciliation and anchoring. The landing injects its
  session check; faucet, deposit and inscribe admission stay in
  `apps/landing/server/bitcoin.ts`.
- The CEL 3 implementation (`packages/cel`, `packages/sdk/src/v3`,
  `OriginalsSDK3.ts`) and the earlier formats were deleted in plan 011 PR 5.
  Do not reintroduce them, add compatibility shims for them, or port their
  APIs. No Originals were issued under them, so there is no conversion,
  migration or legacy verifier.

## Contracts to preserve

- **One signature per signer.** An Original has one author, or a signer set
  (`authors: {threshold, dids}`; P5.19–P5.23, owner decision of 19 November
  2026, D8, reversing S8). Each entry carries one proof per signer it names, in
  signer order, by a key that the signer's DID embeds under `assertionMethod`
  at the version the entry names, and that is not an update key of that DID's
  own log (P5.2, P5.3, P5.11). A single-author entry is signed exactly once,
  byte-identical to before signer sets. A set's genesis is signed by every
  member; a later author entry by the parent's threshold of the parent's
  members plus every added member; the set changes only in author entries and
  is never removed. Every signer of an inscribed set entry must pass P9.15 at
  its inscription (P5.23). A single author is fixed at genesis; a set changes
  only under its own threshold. Rotation happens only in the signer DIDs, never in
  the asset log (P5.8–P5.10).
- **A parent gives grants only.** A child Original names a parent and pins a
  version of its log in every entry; the pin never goes backwards. An editor
  may rely on a grant in the parent's `editors` at the pin, and nothing else
  of the parent has authority over the child (P5.24). Without the parent's
  log the child is incomplete, never a pass (P5.25).
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
  either to Bitcoin. Anchoring is terminal and happens once (P9.10, P9.16).
- **No witnesses.** Asset logs never activate VH witnesses (P9.8, P9.9;
  owner decision Q14). Unanchored ordering is claimed only; Bitcoin anchoring is how an
  Original gets proven ordering and a single history. Author DIDs keep their
  own method's witnesses.
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
