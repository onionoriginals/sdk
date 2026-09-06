# Regtest implementation and validation record

Date: 2026-09-05. Branch: `codex/regtest-flow`.
Base and HEAD: `071b898420dd1052f4e4d34a27e59bea167784d0`.
The implementation is an uncommitted local diff in an isolated worktree. The
original `main` checkout and its existing untracked review/spec files were
preserved. No deployment or package publication was performed.

Implementation diff SHA-256 (including new files, excluding `docs/regtest/`):
`a78b7d8f5fa017432560fe4af4be7ef13f76c7ac0dda5864f4c3f256a50789ab`. Computed from `git diff --binary HEAD -- . ":!docs/regtest/**"`.

## Implemented scope

- Runtime `Uint8Array` resources with raw-byte hashes and byte sizes; caller
  buffers copied at input boundaries; strict tagged-base64 AssetEnvelope v2;
  v1 UTF-8 text loading preserved.
- Binary PNG input, preview, hosted recovery, fee sizing, and inscription paths
  in the landing SDK integration.
- Exported real `RegtestProvider`, explicit local environment selection,
  Core broadcast/status/raw-transaction calls, and ord content/metadata/sat reads.
- Local landing network configuration and Esplora-compatible indexer adapter;
  regtest witness-address mapping for the existing signer adapter.
- Fresh `OriginalsSDK.did.resolveDID` btco resolution uses the same verified
  sat recovery as `resolveAssetFromSat`, without retaining a stale btco cache.
  Ordinary DID-document inscriptions remain readable; CEL claims cannot fall
  back to that path. Recursive proof references are bounded per resolution path.
- Early confirmation remains reversible. Both signed transactions survive until
  six confirmations; a one-block reorg demotes and rebroadcasts the saved pair.
- Reproducible node installation and three real HTTP creator-journey scenarios,
  plus a pull-request workflow and machine-readable receipts.

## Executed checks

| Check | Result |
| --- | --- |
| SDK unit and integration suites | 2,898 passed; 243 skipped; zero failed |
| Landing complete suite | 986 passed; zero failed |
| Final resolver compatibility/cycle/concurrency regressions | 5 passed; zero failed |
| Provider network/env/tip regressions after review | 7 passed; zero failed |
| Real loopback provider and existing provider-contract tests | 17 passed; zero failed |
| Resource manager after copy cleanup | 64 passed; zero failed |
| Landing byte/config checks after cleanup | 9 passed; zero failed |
| Inscription persistence/recovery focused suite | 84 passed; zero failed |
| Root package build | 3 successful |
| Root typecheck | 4 successful |
| Landing frontend, server, and regtest harness typechecks | All passed |
| Landing production build | Passed; bundler emitted existing externalization/chunk warnings |
| Root lint | Passed; 0 errors, 473 warnings |
| ESM import verification | Passed |
| Browser-safety verification | Passed |
| `git diff --check` | Passed |
| Real Core/ord normal journey | Passed |
| Real Core/ord reveal-rejected recovery | Passed |
| Real Core/ord commit-accepted/response-lost recovery | Passed |
| Deliberate journey failure after node startup | Expected exit 1; all four node logs copied |

Full SDK counts cover unit/integration suites, not a claim that every repository
stress, security, performance, or skipped test was executed. Passing tests do
not establish protocol security or production readiness.

The final real run used Bun 1.3.5 on Apple Silicon macOS, Bitcoin Core daemon
v31.1.0, and ord 0.29.0. Each chain was disposable. The runner asserted saved
transaction bytes **inside the broadcast boundary**, checked the selected sat
against ord's recovered inscription, and compared the recovered PNG bytes and
hash after a real one-block reorganization. Receipts:

- [Normal](receipts/none.json)
- [Reveal rejected](receipts/reveal-rejected.json)
- [Commit response lost](receipts/commit-response-lost.json)

## Defects demonstrated and corrected during this work

1. **One confirmation discarded recovery bytes and became sticky.** The real
   regtest assertion failed before the fix because the first confirmed row had
   no reveal transaction. The store now retains the pair and the route rechecks
   early confirmations; unit and actual invalidate/re-mine runs pass.
2. **Fresh SDK btco DID resolution did not read the writer's media/metadata
   shape.** A fresh-instance test resolved the asset but returned null for its
   DID. SDK DID resolution now delegates to verified sat recovery. The targeted
   test additionally tampers with returned inscription bytes and verifies a
   later lookup fails rather than serving a previously cached DID.
3. **Binary resource handling crossed UTF-8 string boundaries.** PNG tests now
   cover create, publish, hosted envelope recovery, inscription, and JSON reload
   with exact byte equality. The JSON version change prevents old readers from
   silently interpreting bytes as text.
4. **ord blockhash transport differed from the JSON assumption.** The real
   service returned plaintext, causing local sat lookup to fail. The provider
   now reads plaintext and checks both height and hash against Core; a loopback
   regression verifies stale equal-height hashes are rejected.

5. **Text preview normalization could falsely create a pending revision.** BOM
   and invalid-UTF-8 uploads now keep round-trippable snapshot bytes; revision
   checks compare the source hash with the committed hash. The no-op update
   regression passes for both cases.
6. **An empty ord address result bypassed the indexed-tip gate.** A stale empty
   address response now fails instead of reporting zero funds. A real loopback
   HTTP regression demonstrated the old success and the corrected rejection.
7. **The initial shared DID reader rejected ordinary DID-document inscriptions.**
   The corrected reader classifies the sat's inscription history first, preserves
   ordinary documents, and prevents a malformed CEL claim from bypassing asset
   verification. Both compatibility cases have integration regressions.
8. **Proof key lookup could recursively resolve the same btco DID.** Independent
   memory-only validation reached 25 nested lifecycle entries before its artificial
   cutoff. Per-path key resolution now terminates self-reference and two-DID
   cycles for both DID and direct lifecycle entry points, while independent
   concurrent valid readers all succeed. The permanent regression bounds reads
   even if the guard regresses.

## Trust boundaries and coverage limits

The SDK builds transactions and the client signer controls the funding key.
The landing app authenticates requests, validates inputs, and stores both signed
transactions before Core submission. Core determines transaction acceptance and
active-chain confirmations. ord supplies indexed sat and inscription data; the
provider refuses stale index state. The local HTTPS host supplies WebVH logs and
resource bytes, which the SDK verifies. The runner's JWT and signing key are
fixtures, and no production credential or wallet is used.

This is a working local development/rehearsal path for the current inscription
representation. It is not a mainnet readiness assessment. It does not establish
Turnkey service compatibility, full browser-login operation, durable recovery
across an OS crash, deep reorg recovery, transfers or post-anchor reinscriptions,
multi-process server coordination, fee replacement, or public-network behavior.
Standalone `DIDManager`/`BtcoDidResolver` consumers retain their separate legacy
resolution path; the new verified path is wired through `OriginalsSDK`.
`resolveDID` retains its nullable failure contract: callers cannot treat `null`
as proof of permanent absence when a provider may be unavailable. Custom landing
providers must return a numeric confirmation count to reach the retirement
horizon; the actual QuickNode and regtest implementations do so.

The proposed `application/cel` inscription representation remains unimplemented
by this change. The same real journey must pass again after that format lands.
The hosted Linux workflow is added but has not been dispatched remotely.

## Review coverage

The change received correctness, project-standards, testing, API-contract,
reliability, maintainability, and frontend-race reviews, plus an independent
Claude review. The serving model receipt identified `claude-opus-5`; the requested
high reasoning effort was not independently observable. One validation batch
checked seven candidates and rejected the optional-confirmation deadlock claim
after tracing all live landing callers. The six confirmed candidates were fixed,
including the cycle finding revalidated after its fix.

The six-confirmation storage horizon is an explicit recovery tradeoff; keeping
superseded rivals until that horizon supports replacement-fork recovery.
Review advice to retire rivals at the first confirmation or serve a cached DID
during provider failure was not applied. Narrow coverage additions address failed
reorg rebroadcasts, lossless text snapshots, and stale empty address indexes.
The obsolete unused SDK-only harness was removed, the fee-sizing fixture now
has a checked input type, and failure logs are collected by the repeatable runner.

Remaining coverage gaps include malformed/oversized provider response branches,
deposit-poll overlap in an actual browser, transient lagging backend responses,
and multi-record fork races. This is a functional implementation review, not a
new comprehensive protocol security assessment. Existing mapped release blockers
outside this slice remain open on the [release map](https://github.com/onionoriginals/sdk/issues/519#issuecomment-5555208066).

Implementation entry points: `packages/sdk/src/utils/resource-content.ts:25`,
`packages/sdk/src/lifecycle/assetEnvelope.ts:19`,
`packages/sdk/src/did/DIDManager.ts:420`,
`packages/sdk/src/adapters/providers/RegtestProvider.ts:97` and `:192`,
`apps/landing/src/sdk/resource-view.ts:12` and `:23`,
`apps/landing/server/bitcoin.ts:1828`,
`apps/landing/server/inscriptions-store.ts:462`, and
`scripts/regtest/environment.ts:35`.

Matt Pocock/Wayfinder skills were installed at revision
`3cca18b368ae95cdbdebbff572ccafa662551015`. The existing release map and its native
regtest children were updated with local evidence and their remaining acceptance
work; implementation tickets were not closed.

## Remediation and release order

1. Review and land the bytes/regtest slice with the receipts and release notes.
2. Run the new workflow on Linux and rehearse actual browser/Turnkey signing
   against a deliberately configured regtest service.
3. Land the new inscription representation and rerun all three real scenarios.
4. Add transfer, post-anchor append, and longer reorg/service-failure rehearsals
   before treating the new representation as release-ready.
5. Complete the separate final release/mainnet proof only with its own authority.
