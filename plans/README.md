# Implementation Plans

Maintained by the `improve` skill. Each plan is self-contained and written for
an executor with no prior context — read the plan fully before starting, honor
its STOP conditions, and update your row when done.

Two audit runs so far:

- **Run 1 (2026-06-11, planned against `879ab0c`)** — full-repo audit; plans
  001–013, all DONE.
- **Run 2 (2026-06-11, planned against `2b86eaa`)** — follow-up audit weighted
  toward areas run 1 didn't read deeply (CEL internals, Bitcoin transaction
  construction, `packages/auth`) plus the standing wiring gaps; plans 014–019.
  Headline finding: **CEL canonicalization is broken** — the hash chain and
  CLI signatures don't cover nested event content (014), and CEL verification
  is structural-only with no cryptography (015).

> Run 2 was executed non-interactively; plans were written for the top
> findings by leverage (security > funds-safety > green-CI keystone) per the
> skill's default. Unplanned findings are listed in the backlog section below.

## Execution order & status

### Run 2 (current)

| Plan | Title | Priority | Effort | Risk | Depends on | Status |
|------|-------|----------|--------|------|------------|--------|
| 014 | Fix CEL canonicalization (hashes/signatures must cover all content) | P1 | M | MED | — | DONE (reviewed+approved; commit `ff3c729` on worktree branch `worktree-agent-ab9b03eb8d7d3b9fe`; verified green on merge with `2b86eaa`: tsc 0, CEL 603/0, full suite at pre-existing baseline) |
| 015 | Real cryptographic CEL proof verification (did:key Ed25519, default + CLI) | P1 | M | MED | 014 | DONE (reviewed+approved; commit `86ca99c` on worktree branch `worktree-agent-a02f8d6337c47cb8a` — branch already contains 2b86eaa+014, most integration-ready; tsc 0, CEL 631/0, 5 new crypto tests incl. wrong-key binding; full suite at pre-existing baseline) |
| 016 | Wire DIDCache, DID metrics, statusList (fix the 16 standing test failures) | P1 | M | MED | — | DONE (revision 1 reviewed+approved; commit `64e5e3c` on worktree branch `worktree-agent-a1b10512d632a4649`, sits directly atop `2b86eaa`; full SDK suite 0 fail for the first time; known flake: sub-ms `totalTime>0` assertion in MetricsIntegration) |
| 017 | Fix `createTurnkeySigner` API mismatch (2 failing auth tests) | P2 | S | LOW | — | DONE (reviewed+approved; commit `2f687f0` on worktree branch `worktree-agent-af301f8e8a33a5055`; 139/139 auth tests pass; merges clean with `2b86eaa`) |
| 018 | Harden email auth (CSPRNG session IDs, PII-free logs, client/server boundary) | P2 | M | MED | — | DONE (reviewed+approved; 4 commits ending `149356e` on worktree branch `worktree-agent-afbfc1bb906cac0bb`; all done-criteria greps clean, 131 pass / 4 envt-or-017 fails; merges clean with `2b86eaa` and with 017; BREAKING: client `initializeTurnkeyClient` now throws-with-pointer) |
| 019 | Inscription-safe commit funding + real scriptPubKeys in transfer builder | P2 | M | MED | — | DONE (reviewed+approved; commit `b534961` on worktree branch `worktree-agent-a5cf45cb611463d6e`; 198/0 bitcoin tests, placeholder greps clean, regtest supported; merges clean with `2b86eaa`) |
| 020 | CEL verification checks EVERY signature (resolve did:webvh/did:btco keys; fail closed) | P1 | L | MED | 014, 015 | DONE-with-followup (controller-proof verification reviewed+approved, commit `08087b2`, full suite 0 fail; review found it over-gates witness proofs → plan 021. NOT pushed alone) |
| 021 | Witness proofs non-gating (controller gates `verified`; witnesses checked + reported separately) | P1 | M | MED | 020 | IN PROGRESS (executor dispatched on 020 state `08087b2`) |
| 022 | Hash-chain link covers only committed fields, not mutable proof metadata | P1 | S | MED | 014, 015 | DONE (worktree branch `correctness/round1-5` atop `0b8cd11`; chain preimage now `canonicalizeEntryForChain` = `{type,data,previousEvent?}`, proof array excluded; tsc 0, build ok, full suite 0 fail; tamper test updated: proofValue→proofValid (not chain), created→no-op; NOT pushed) |

> **Post-merge review findings (review #1 + #2) → fixed/in-progress.** After the
> six plans landed, two review passes of the run-2 code surfaced edge cases the
> plans' tests missed: (1) CEL fail-open for non-Ed25519 did:key proofs and
> resolveDID caching the degraded fallback stub — both **fixed** in commit
> `54170ab` (now on PR branch / PR #170). (2) The fail-open was broader — any
> proof not on the did:key+eddsa-jcs-2022 crypto path (incl. all did:webvh/
> did:btco proofs and did:key+eddsa-rdfc-2022) returned `verified:true` with no
> signature check. Maintainer decision: **every signature must be checked, fail
> closed otherwise** → **plan 020** (in progress).

Status values: TODO | IN PROGRESS | DONE | BLOCKED (one-line reason) | REJECTED (one-line rationale)

**Execution round complete (2026-06-12).** All six plans executed by
worktree-isolated subagents and reviewed/approved. A pre-verified integration
merge of all six branches exists at commit `00e0c46` (worktree
`.claude/worktrees/agent-a1b10512d632a4649`, branch
`worktree-agent-a1b10512d632a4649`): on that combined state `tsc` is 0 errors,
`bun run build` succeeds, the SDK suite is **2386 pass / 0 fail / 68 skip**
(first fully green run), and the auth suite is **140 pass / 0 fail**.
Integration options for the maintainer: (a) merge `00e0c46` into
`plans/improve-audit-2026-06-11` in one step, or (b) merge the six per-plan
commits individually (all verified conflict-free against `2b86eaa`).
Known flake to watch: `MetricsIntegration` "should track createDIDPeer
operation" asserts `totalTime > 0` and can fail when the op completes in
<1ms (Date.now() resolution) — consider switching `MetricsCollector.track`
to `performance.now()` in a follow-up. Worktree env note: auth tests require
`packages/sdk/dist` to be built (`bun run build`) for `@originals/sdk`
workspace resolution.

### Run 1 (complete — kept for the record)

| Plan | Title | Priority | Effort | Risk | Depends on | Status |
|------|-------|----------|--------|------|------------|--------|
| 001 | Bind credential verification to issuer DID (close forgery) | P1 | M | MED | — | DONE |
| 002 | Stop logging private keys in CEL CLI | P1 | S | LOW | — | DONE |
| 003 | Make `tsc` pass — fix 12 build errors | P1 | S–M | LOW | — | DONE |
| 004 | AuditLogger Ed25519 signing + re-enable in MigrationManager | P1 | M | MED | — | DONE |
| 005 | Implement `rotateDIDWebVHKeys` / `recoverDIDWebVH` | P2 | L | HIGH | — | DONE |
| 006 | Extract shared credential digest helper | P2 | M | MED | 001 | DONE |
| 007 | Cache the DocumentLoader per factory | P2 | S | LOW | — | DONE |
| 008 | DIDCache O(1) LRU + EventEmitter alloc | P3 | S | LOW | — | DONE (DIDCache only; emitter snapshot is load-bearing, left per STOP) |
| 009 | Exclude examples/playground from published build | P3 | S | LOW | 003 | DONE |
| 010 | Gate CI on typecheck + test exit code | P1* | S | LOW/MED | 003, 004, 005 | DONE (gates added; tests job red until run-2 plans 016+017 land) |
| 011 | Reconcile README/example lifecycle API drift | P3 | M | LOW | — | DONE |
| 012 | Decompose LifecycleManager god module | P3 | L | HIGH | 003, 010 | DONE (batch ops extracted; 2178→1604 lines; further decomposition assessed in run 2 as not worth doing now) |
| 013 | (SPIKE) Unified `verify()` entry point | P3 | M | LOW | 001 | DONE (spike: design doc + PoC + 5 passing tests; recommends building — see Direction below) |

## Dependency notes (run 2)

- **015 depends on 014** — the real verifier verifies signatures over
  `canonicalizeEvent` bytes; without 014, signer and verifier disagree on the
  bytes and every round-trip fails.
- **016 + 017 jointly unblock green CI** — 016 fixes the 16 SDK failures,
  017 the 2 auth failures. Neither depends on the other.
- **014 and 015 change CEL verification outcomes** — logs created before 014
  will fail chain verification after it (documented in 014's maintenance
  notes; intentional, the old hashes bound nothing).

## Baseline at planning time (commit `2b86eaa`)

- `bunx tsc --noEmit -p packages/sdk` → 0 errors (green).
- `packages/sdk`: 2348 pass / 16 fail / 68 skip — the 16 are the documented
  DIDCache (4) / Metrics (8) / StatusList (4) wiring gaps → plan 016.
- `packages/auth`: 137 pass / 2 fail — `createTurnkeySigner` signature
  mismatch → plan 017.
- Lint: 143 errors / 382 warnings (non-blocking in CI by design, see backlog).

## Direction findings (maintainer options, not ranked against bugs)

1. **Ship the unified `verify()` API.** The 013 spike is done:
   `packages/sdk/src/verify/UnifiedVerifier.ts` + design doc
   (`plans/013-unified-verify-design.md`) + 5 passing tests, and the doc
   recommends building it (scoped to VC + CEL). ~1 day: wire into
   `OriginalsSDK`, forward options, export types, document. After plan 015
   lands, the CEL branch becomes cryptographically real, which is what makes
   this API worth shipping. Ask for a build plan when ready.
2. **Decide the deployment story for the explorer/viewer.** `railway.json`
   starts `apps/originals-explorer`, which does not exist; the README's
   monorepo diagram shows the same phantom directory; an unworkspaced
   `viewer/` sits at the root. Either resurrect the app under `apps/` (and add
   it to workspaces + CI) or delete the deploy config and fix the README.
   Cheap either way; the current state misleads contributors and deploys.

## Backlog — vetted findings not planned this round

- **Make lint a blocking CI gate** (DX, M): 143 errors / 382 warnings today;
  `ci.yml` has a TODO to drop `continue-on-error` once clean. Mechanical but
  sizeable; plan it when someone wants the cleanup.
- **Root-repo hygiene** (debt, M): 15+ top-level audit/plan/prompt markdown
  files, plus unworkspaced `legacy/`, `server/`, `viewer/`, `shared/`, `test/`,
  `tasks/` dirs. Archive or workspace them. Pairs with Direction #2.
- **Duplicate Bitcoin deps** (deps, S): both `@scure/btc-signer` and
  `bitcoinjs-lib` in `packages/sdk/package.json` (lines 109, 112); production
  code uses @scure. Verify nothing imports bitcoinjs-lib and drop it.
- **Two UTXO selectors** (`src/bitcoin/utxo.ts` vs `utxo-selection.ts`) with
  divergent option vocabularies (`forbidInscriptionBearingInputs` vs
  `allowResourceUtxos`/`hasResource`) — consolidation candidate after 019.
- **Skipped perf tests** (tests, S): two `.skip`s in
  `tests/performance/BatchOperations.perf.test.ts` with no explanatory
  comment — document or re-enable.
- **didwebvh-ts maintenance watch** (deps, LOW confidence): on the critical
  did:webvh path; confirm upstream is alive or pin + monitor.

## Findings considered and rejected

Run 2 (so they aren't re-audited):

- **CEL CLI `--output` path traversal for generated `.key` files**: rejected —
  the output path is the operator's own CLI argument; writing where the user
  asks is not a vulnerability. Keys are written `0o600`.
- **Email-auth session cleanup race (60s window)**: rejected — expiry is
  enforced at access time (`verifyEmailAuth`), the interval is advisory.
- **Email regex not RFC-5322**: rejected — Turnkey validates authoritatively;
  the loose regex only affects error-message quality.
- **JWT `sub` falsy-check fragility**: rejected — the check already rejects
  empty `sub`; purely stylistic.
- **`LifecycleManager` further decomposition** (still 1604 lines): not worth
  doing now — plan 012 completed its scope, the suite protects the current
  shape, and no concrete change is blocked by the file's size. Revisit when a
  feature actually collides with it.
- **258 `as any`/`as unknown` escapes**: not planned — majority are noble/didwebvh
  ESM bridge casts that are load-bearing; a sweep would be high-churn, low-yield.
  Address opportunistically.

Run 1 (carried forward):

- **CEL guide `eddsa-jcs-2022`** (reported as a docs bug): rejected — CEL
  legitimately uses `eddsa-jcs-2022`; only the VC subsystem uses
  `eddsa-rdfc-2022`. Not a bug.
- **Auth package rate-limiting / DDoS** (`packages/auth` Turnkey client):
  rejected as a plan — impact depends entirely on unknown endpoint exposure.
  Revisit if/when the auth server's routes are in scope.
- **Regtest→testnet address-validation fallback** (`utils/bitcoin-address.ts`):
  rejected — by design and documented; validation still occurs.
- **MultiSigManager weaker key binding** (`extractPublicKeyFromVM`):
  intentionally deferred; folded into 001's maintenance notes.

## Notes on scope of the audits

Run 2 audited at `standard` depth: CEL subsystem (very thorough), Bitcoin
transaction construction (very thorough), `packages/auth` (very thorough),
plus a medium cross-cutting pass (tests/debt/deps/DX/docs/direction). Lighter
coverage this run: `src/migration/**` internals, `src/lifecycle/**` beyond
size metrics, the witness services (`src/cel/witnesses/`), PSBTBuilder
byte-level correctness, and the root `server/`/`viewer/` trees (assessed for
liveness only). A future pass could target those.
