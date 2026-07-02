# Correctness Loop Log

Branch: `claude/originals-sdk-correctness-4pn30u`

## Iteration 1 — 2026-07-02

### Ground truth
- `bun test` (fresh clone, after `bun install`): 3305 pass / 23 fail / 4 errors.
- All 23 failures + 4 errors had a single root cause: `packages/sdk/dist` did not exist.
  - `packages/auth` resolves `@originals/sdk` via the workspace package's built entry point.
  - `tests/integration/cel-cli.integration.test.ts` spawns `dist/cel/cli/index.js` as a subprocess.
  - After `bun run build`, re-ran the full suite (results below).
- `bun run lint`: 0 errors, 85 warnings.
- `bun run typecheck` (packages/sdk): clean.
- No open PR for this branch yet; branch tip == origin/main (8ac6c70).

### Work items
- Full-suite re-run after `bun run build`: **3380 pass / 0 fail / 74 skip** across 182 files. Suite is green; initial failures were environment-only (missing dist), no code change needed.
- Proactive correctness audit of vc/crypto, did, bitcoin, cel/lifecycle subsystems: in progress.

### Audit + fixes (this iteration)
Ran four parallel subsystem audits (vc/crypto, did, bitcoin, cel/lifecycle).
Fixed the confirmed correctness bugs, each with a regression test:

1. **HIGH — VC issuer/holder impersonation** (`2ec7c28`): `Verifier.verifyCredential`
   / `verifyPresentation` never bound `proof.verificationMethod` to the credential
   `issuer` / presentation `holder`. An attacker could sign with their own key while
   naming a trusted issuer and have it verify. Added `checkVerificationMethodController`
   gate + regression tests reproducing the attack.
2. **HIGH — did:webvh always resolved to null** (`57c21a1`): `DIDManager.resolveDID`
   passed no verifier to `didwebvh-ts`, which requires one; every valid did:webvh
   returned null. Pass `Ed25519Verifier`; regression test resolves a real served log.
3. **HIGH — CEL btco layer/DID/guard mis-detection** (`3435813`): after #228, btco
   migration events carry `sourceDid` not `targetDid`; four detectors still keyed off
   `targetDid`, so btco logs were seen as webvh (wrong resolvable DID, terminal-guard
   bypass, wrong transfer owner). Switched detectors to `sourceDid`; derive
   did:btco:<sat> from the witness proof. Regression tests for DID + terminal guard.
4. **MED — legacy verify skipped expiry; 64-byte Ed25519 signing broken** (`2a8a55b`):
   extracted shared `checkCredentialValidityPeriod` for the legacy path; fixed
   `slice(32)`→`slice(0,32)`. Regression tests for both.
5. **LOW — unbounded estimator fees; non-anchored btco DID marker** (`7e9d871`):
   applied `MAX_REASONABLE_FEE_RATE` to fee-oracle/provider estimates; added
   `(?![0-9])` boundary to the btco marker regex. Regression tests for both.

### Deferred (see FOLLOWUP.md)
- did:btco resolve network from config vs DID (latent — OrdinalsClient ignores network).
- migrateToDIDWebVH stale VM ids/controllers + unencoded port (design decision).
- did:btco witness anchoring not cryptographically verified (threat-model decision).
- fee estimators assume segwit inputs; legacy inputs under-estimated (scoped-out, own PR).
- BBS+ derived-proof indexing (latent — BBS+ path unreachable/unimplemented).

### Result
- Full suite after fixes: pending final confirmation (see next entry).
- No open PR yet; will push branch. All fixes preserve/strengthen crypto verification;
  none weaken validation or skip checks.

### Open items
- Push branch; monitor for CI/review comments.
