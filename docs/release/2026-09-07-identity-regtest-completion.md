# Identity and regtest completion: #583, #570, #572

Local implementation and verification, September 7, 2026. Base:
`349219265a890a75b3e088e5352856237b4caa7d`. The isolated branch is
`codex/identity-regtest-completion`; the original checkout and its existing
uncommitted work are preserved.

## Identity and compatibility (#583)

Originals now names a file-provenance asset with the RFC 6920 URI
`ni:///sha-256;` plus the unpadded base64url SHA-256 of its canonical genesis
event. This is an application identity, not a new DID method. The
[identity contract](../../specs/originals-asset-identity.md) and
[SDK 4 migration guide](../MIGRATION_4.0.md) define the public change.

New envelopes use version 4 and `assetId`. Historical Originals 3 envelopes,
signed migration aliases, hosted backlinks, URLs and saved transactions remain
readable without rewriting signatures or reinscribing. CEL remains version 3;
the changeset requests SDK 4 and CEL 2 because SDK 3 is already published.
This work does not publish either new package version.

Two immutable fixtures were produced with the **published SDK 3.0.0** in a
separate temporary installation. Their tests prove cold hosted recovery and
submission of the original saved Bitcoin pair with no signer. The
[fixture provenance](../../packages/sdk/tests/fixtures/identity/README.md)
distinguishes synthetic offline transactions from real regtest evidence.
Independent hash tests verify the NI representation and reject malformed,
alternate, mismatched and unrelated method identities.

## Core and indexer restarts (#570)

The harness now restarts Core, ord, or both on the same isolated directories,
wallets and ports. Lifecycle operations serialize. Core's normal cookie rotates;
ord uses a separate disposable authenticated credential because ord 0.29.0 caches
credentials across Core-only restarts. SDK consumers recreate their provider
with the refreshed cookie. Bootstrap mining has a bounded 60-second deadline;
normal RPC calls retain 10 seconds, with no automatic retry of mutations.

The [restart receipt](evidence/identity-regtest-completion/regtest-restart.json)
proves real inscription preservation, identical chain tip and wallet balances,
subsequent indexed blocks, serialized concurrent restarts, deliberate restart
failure cleanup, repeated stop and refusal to restart a stopped environment.
See [restart verification](../regtest/restart-verification.md).

## Real creator browser recovery (#572)

The [combined browser receipt](evidence/identity-regtest-completion/browser.json)
passes both commit-accepted/response-lost and reveal-rejected scenarios. Each
uploads a PNG through the actual creator UI, publishes to durable local HTTPS,
funds with real regtest Bitcoin, and uses the shared SDK transaction builder
and actual server routes/stores. It then closes Chromium and the application,
restarts Core and ord, reopens the same browser profile and server storage,
and clicks **Finish inscription**.

Each final receipt records five signature requests before restart and **zero
afterward**, the unchanged signed pair, accepted head, asset ID, resource digest
and Bitcoin DID, and no public-provider requests. Screenshots show both
**resolved** and **inscribed** badges after recovery. The inline PNG is recovered
from Bitcoin; the creator's additional `metadata.json` is fetched and verified
from durable HTTPS. The sat-only missing-resource result stays explicit.

The authentication/session and remote signing service are declared local
fixtures; actual production authentication rules remain intact. Each fault
scenario runs in its own Bun process to isolate an observed Bun 1.3.5 TLS-cache
interaction between successive ephemeral certificates. Certificate verification
is enabled throughout. See [browser verification](../regtest/browser-verification.md).

The real browser exposed eager SDK code evaluating before `Buffer` installation.
The production build now isolates the polyfill and its initialization into one
chunk. Offline envelope parsing also has a browser-safe `@originals/sdk/asset-envelope`
entry. The local smoke test now proves local signed creation and fresh recovery;
the real regtest browser command supplies the publication/Bitcoin evidence.

## Verification

| Check | Observed result |
| --- | --- |
| Root package test command | 4,659 passed, 248 explicit previous-format/optional skips, zero failures |
| Archived SDK 3 compatibility added afterward | 2 passed, 17 assertions; hosted and Bitcoin saved artifacts |
| Landing typecheck, server typecheck, full tests and production build | 1,047 passed, zero failures; build/types pass |
| New CEL 3 focused identity/lifecycle suite | 230 passed, zero failures (subset of package run) |
| Root build, types, public consumer typecheck | Passed |
| Node ESM exported entries | 25 imported successfully |
| Browser import safety, including offline envelope entry | Passed; offline envelope requires no Node builtins or Buffer global |
| Root lint | Passed, zero errors; 489 existing warnings |
| Regtest installer/lifecycle unit checks | 8 passed, 16 assertions |
| Integrated real Core 31.1 / ord 0.29.0 | All three lifecycle/fault/reorg scenarios, no-address-index capability, and restart proof passed |
| Actual Chromium 152 creator recovery | Both fault scenarios passed; all processes closed |
| Local browser smoke and narrow viewport checks | Passed |
| Local throttled three-second interactivity floor | Failed: changed tree ~3.3s; unchanged main landing built with published SDK 3 also failed (~4.25s). Existing local performance limitation; threshold was not weakened. |

Retained receipts and screenshots are under
[evidence/identity-regtest-completion](evidence/identity-regtest-completion).
They contain public test identities and transactions, not private keys, session
cookies, JWT secrets or browser profiles. Historical `/tmp` paths in receipts
identify their original runs and are not portable commands.

The runtime/test/CI diff SHA-256 was
`cf139f5a8f0c8a2999761ad9fb0409766f474719566312f16f3d682e2a139473`,
computed with `git diff --binary 34921926 -- packages apps scripts .github package.json .changeset`
against the base above. Main’s subsequent standards-copy fix was integrated at
`8351976159866c8770dcdcb93a9c4ba2678e43e5`; the tested runtime and test files
remained identical. Post-merge frontend types and nine copy/summary checks passed. Release/spec prose and
retained evidence are excluded from that digest.

## Review and release boundaries

The simplification pass applied one redundant document-validation cleanup and
made the harness's one-shot fault marker atomic. It retained explicit trust
checks and deferred a broader verification-token refactor; that refactor is not
needed for correctness or acceptance. [Independent code review](evidence/identity-regtest-completion/review.json)
completed with eight local lenses and a separate Claude Opus 5 adversarial
review, with no actionable findings. Advisory limits are repeated authenticated
history checks and absence of a combined account-switch/old-key Chromium case;
the corresponding account/legacy-key unit checks pass.

A supplemental review strengthened the stopped-endpoint probe: timeouts, live
HTTP responses and redirects cannot count as stopped. Three regressions pass,
and the real restart proof passed again. The existing process-exit checks already
await child termination; this improves the verification assertion rather than
changing daemon lifecycle behavior.

These results close the implementation gaps requested in #583, #570 and #572.
They do not establish live Turnkey service behavior, a new production deployment,
new npm publication, or a new public-chain transcript. The existing release map's
separate API/spec, clean-browser mainnet and release sign-off gates remain distinct.

Supplemental shutdown-probe review: [pinned receipt](evidence/identity-regtest-completion/supplemental-review.json), no remaining findings at commit `1eab0c1f`.

## Greptile follow-up — September 8, 2026 Pacific

The previously deferred duplicate envelope authentication is now fixed. Internal
ingestion decodes the container before the asset constructor authenticates it;
the public parser still authenticates every input. Browser recovery uses
`inspectAssetEnvelope` to receive the normalized envelope and immutable verified
history together. No caller-supplied trust token or shared cache was added.

Signature-count regressions on the archived two-entry SDK 3 fixture show recovery
discovery uses two checks instead of four, and loading uses six instead of eight.
The pre-existing asset verification passes remain unchanged. Forged histories and
mismatched identities still fail; prepared publication rejects forgery before I/O.
Both real browser/Core/ord restart scenarios passed again with zero signatures
after restart. The inspection API's detached-envelope and immutable-history
contracts are covered by runtime tests and the public consumer type fixture.
