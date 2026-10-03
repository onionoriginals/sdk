# Exact-revision release gate — October 3, 2026

**#569 pre-broadcast exact-revision verdict: PASS** at
`68f9d599db867356502effb9da9d2b5d745c96e1`, subject to final independent
artifact/PR review. The initial target failed; the discovered response race is
corrected and all required local executions pass on this exact corrected SHA.
Existing owner/deployment evidence is reconciled explicitly as historical below.
No unresolved implementation prerequisite was identified by this execution and
independent review.

This is not a blanket production release verdict. The shared clean-browser
owner mainnet receipt remains with
[#525](https://github.com/onionoriginals/sdk/issues/525),
[#527](https://github.com/onionoriginals/sdk/issues/527) and
[#540](https://github.com/onionoriginals/sdk/issues/540); #569 explicitly does
not require #540 closure as a prerequisite. The corrected SHA is not deployed,
and packed next-major artifacts are a separate publication gate. Neither is
silently treated as evidence established here or as an invented #569 blocker.
No deployment, owner-key signing, mainnet broadcast, spending, merge, issue
closure or package publication occurred. Issue disposition remains a maintainer responsibility; no manual closure is authorized.

## Revision and execution evidence

The initial target was `3162ff5d396385f52f9771d04417f0afc31606b5`.
Fresh execution found a real concurrent inscription-list response bug, described
below. Two code/test commits, `92373bbf` and `68f9d599`, correct it. The final
runtime/test SHA is **`68f9d599db867356502effb9da9d2b5d745c96e1`**; the later
commit containing this document and receipts changes documentation/evidence
only and is not the runtime SHA.

[Machine-readable summary](evidence/exact-revision-2026-10-03/summary.json)
records exact commands, exit codes, times, counts, transaction byte digests and
full scratch-log digests.
[Compact terminal output](evidence/exact-revision-2026-10-03/terminal-summary.txt)
is retained; large raw logs, wallets, browser profiles and private fixture keys
are excluded from Git. Receipt paths to disposable data directories are
provenance, not a promise that those directories remain available.

Environment: macOS 15.3.1 arm64, Bun 1.3.5, Node 24.21.0, pinned Bitcoin Core
31.1.0 / ord 0.29.0, Chromium 154.0.8037.95, playwright-core 1.61.1.
Built manifest versions are SDK **3.0.0**, CEL **1.0.0**, auth **3.0.0**, landing
**0.2.0**. These are the source tree's pre-bump manifests, not evidence that
SDK 4 / CEL 2 / auth 4 packages were packed or published. The wire profile is
`originals/cel/3`. Frozen installation installed 729 packages at the initial
SHA; dependency manifests did not change in either correction.

| Local gate at corrected SHA | Result and retained evidence |
| --- | --- |
| Package build | PASS: regtest runner directly ran `tsc` builds for CEL, SDK and auth; Node Core-authentication test 1/1 and harness types passed. Initial Turbo build was cached and is not substituted for these builds. |
| `bun run test` | PASS: 5,521 pass, 250 skip, 0 fail, 57,897 assertions. Includes retained previous-format tests; this is not a count of CEL 3 publication proofs. Six Turbo tasks succeeded, with one cached build task. |
| `bun run lint` | PASS: zero errors, 274 existing warnings. |
| Types and imports | PASS: package types, SDK/auth public consumer types, landing frontend/server types; 26 Node ESM entry points; browser-safety gate passed with existing Buffer advisories. |
| Landing build/tests | PASS: Vite build; 1,287 tests, 0 fail, 6,634 assertions across 105 files. Existing Vite dynamic-import warnings remain. |
| Normal creator | PASS: [receipt](evidence/exact-revision-2026-10-03/regtest-none.json), 28 checks. |
| Rejected reveal + closed-browser sweep | PASS: [receipt](evidence/exact-revision-2026-10-03/regtest-reveal-rejected.json), 28 checks. |
| Accepted commit with lost response | PASS: [receipt](evidence/exact-revision-2026-10-03/regtest-commit-response-lost.json), 28 checks. |
| No-address-index / independent node validation | PASS: [receipt](evidence/exact-revision-2026-10-03/regtest-no-address-index.json), 12 checks. |
| Core/ord restart | PASS: [receipt](evidence/exact-revision-2026-10-03/regtest-restart.json), 14 checks, including independent and combined restarts, queued restarts, failure cleanup and cookie rotation. |
| Actual Chromium cold recovery | PASS: [two-scenario receipt](evidence/exact-revision-2026-10-03/browser/receipt.json); persisted profiles reopened after browser/server/Core/ord restart, exact stored pair recovered, zero post-restart signatures and zero external requests. [Commit-loss recovered screenshot](evidence/exact-revision-2026-10-03/browser/commit-response-lost/02-recovered.png), [reveal-rejection recovered screenshot](evidence/exact-revision-2026-10-03/browser/reveal-rejected/02-recovered.png). |
| Non-broadcast build/sign/readback | PASS: [signed mainnet-format mock receipt](evidence/exact-revision-2026-10-03/dry-run.json), 24/24 properties. |

The regtest provider reads real disposable Core/ord, with loopback-only HTTPS
hosting and independently observed node/indexer evidence. Signers use disposable
local Bitcoin/CEL keys through the production adapters; no live Turnkey service
is contacted. Creator checks include exact raw PNG/CBOR, full boundary history,
reorg/reconfirmation, independent ownership, sale/reacquisition, controller
rotation and retirement, resource deltas, six-confirmation recovery retention,
JSON recovery, deactivation and fresh DID/asset agreement.

The dry run uses the shipped routes and builders with mock funding and the
existing fixture signer. The [input PNG](evidence/exact-revision-2026-10-03/input.png)
is 68 bytes, SHA-256
`5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15`.
The receipt retains exact signed commit/reveal hex, witness reconstruction,
signature verification, CBOR boundary verification, body digest and DID
agreement. It made **zero broadcast-route calls**; one attempted provider
broadcast was refused by construction. The resulting HTTP 502 is the deliberate
broadcast guard, not chain acceptance. Regtest separately supplies mined
readback; neither result proves mainnet acceptance of the corrected revision.

## Discovered blocker and correction

At the initial SHA, Chromium recovered the exact pair and mined it, but `/me`
remained “inscription pending” while disk held `confirmed` at one confirmation.
The initial [failure receipt](evidence/exact-revision-2026-10-03/initial-3162ff5d/failure.json)
and [screenshot](evidence/exact-revision-2026-10-03/initial-3162ff5d/failure.png)
are retained. No browser exception or external request was reported.

Two list requests can snapshot `reveal_broadcast`; the winner persists
confirmation, while the loser correctly refuses a stale compare-and-set but
returns its initial snapshot. A second variant occurs when a concurrent request
confirms a later record during an earlier lookup: this pass then needs no write,
yet its initial response list is stale. Deterministic regressions reproduced
[both the original race](evidence/exact-revision-2026-10-03/initial-3162ff5d/concurrent-response-repro.txt)
and [the incomplete first fix](evidence/exact-revision-2026-10-03/intermediate-92373bbf/earlier-record-repro.txt).
The complete fix rereads the durable list immediately before public projection,
retaining all write/retirement guards and existing storage-error handling. It
adds one final list read for passes that previously performed no writes.

Focused verification: 202 reconciliation/HTTP route tests pass with 924
assertions. An independent delegated reviewer reran those tests, SDK public types,
server types and diff checks; a no-write race probe returned the persisted
confirmation without mutation or recovery hex in the response. A final-read
failure probe returned the named 503 without leaking the private exception.
This review covers the code correction; final artifact/PR review remains the
parent's delivery step. Full coverage is deferred to PR CI.

## API, historical defects and issue dispositions

The [SDK 4 / CEL 2 API decision](4.0.0-public-api.md) now reconciles the current
CLI's offline verification scope, hosted missing-resource behavior, typed
publication errors, occupied-sat diagnostic, storage-origin/adapter behavior,
auth issuer/audience and OTP validation. Three existing exports omitted from
the inventory are documented and compile-asserted. Independent review compared
all six SDK source/declaration export sets: 295 / 49 / 70 / 95 / 2 / 4 symbols
(root, v3, cel, types, testing, asset-envelope), with matching names. These checks
do not replace a packed next-major tarball consumer test after the version bump.

The [original eight-defect mapping](3.0.0-verification.md#original-eight-reproduced-defects)
remains applicable to upload isolation, strict genesis identity, durable
interruption recovery, reorg retention, canonical signed keys, fresh DID/media
agreement, resource-byte verification and concurrent append preservation.
A focused run on the initial SHA passed 361 tests / 1,358 assertions across its
11 named regression files; corrected-SHA full package/landing tests rerun those
seams, and fresh corrected-SHA Core/ord/Chromium receipts exercise the real
publication and recovery boundaries. Historical receipts are references only,
not relabeled as current execution.

GitHub reconciliation found #521, #496 and #497 closed, as well as the issue
body's #805/#777/#749/#859/#874/#889/#812 findings. The initial five open bugs
were independently reviewed in a delegated task against current code:

| Issue | Evidence-backed disposition from independent delegated review |
| --- | --- |
| #905 | Fixed through #884; persisted-state settlement regression passes. Caveat: the review reproduced equivalent persisted state, not a forced retirement CAS miss. The newly found response race above was a separate blocker and is now fixed locally. |
| #897 | Fixed through #768/#916: canonical default HTTPS port handling. |
| #896 | Fixed through #763/#916: invalid self-rotation classification. Caveat: the focused case is first-entry, not an explicit A→B→B sequence. |
| #885 | Fixed through #916/#919: auth middleware preserves downstream errors and calls continuation once. |
| #824 | Superseded by the SDK 4 removed-option contract in #916: `keyStore` is explicitly rejected, not wired into the default SDK. |

The independent duplicate review ran 213 tests / 714 assertions, zero failures (CEL
history/DIDs 40; SDK removed-option/hosted 66; auth middleware/reconciliation
104; focused settlement 3). Issue disposition remains a maintainer responsibility. Closed
structural-debt/recovery trackers are not automatically new release blockers.

## Production relationship and remaining acceptance

The coordinator’s read-only GitHub observation identifies successful deployment
`6831485355`, environment `Onion / Originals / production`, at
`3162ff5d396385f52f9771d04417f0afc31606b5`, timestamp
`2026-10-03T18:34:32Z`. This links deployment metadata to the **initial** target,
not the corrected SHA. It is not a runtime byte/revision attestation. The base
revision's [CI run](https://github.com/onionoriginals/sdk/actions/runs/37144633983)
and [second CI run](https://github.com/onionoriginals/sdk/actions/runs/37144734277)
passed; they do not certify the later correction. PR CI remains pending at recording; its results belong to the PR.

[Supplemental public observation](evidence/exact-revision-2026-10-03/production-observation.json)
from the coordinator read the existing owner asset without signing or changing it:
Explore displayed one accepted on-chain publication (provider-asserted), and
its 3,857-byte PNG matched the historical SHA-256
`98bbbe3fed7293f4b2c335f66fe76025ef9da84c18a905d297598aafaa663e33`.
Empty origin storage and unauthenticated `/api/me` were observed. A new browser
**profile** was not established, screenshot capture failed, and the running
revision was not independently attested. This is supplemental read-only
support, not the shared #525/#527/#540 completion receipt.

The following explicitly reuses historical evidence, as #569 requests; it
is not a fresh attestation of production configuration:

| Existing requirement | Reconciliation |
| --- | --- |
| Signer-bound key | `apps/landing/src/auth/turnkey-session.test.ts` rejects foreign/missing bound keys and permits the browser-held key; the current landing suite passes. The historical [owner proof](evidence/owner-mainnet-proof.json) records live sign-in, creation/publication and derived controller verification at `e9c51870`; the [operator runbook](3.0.0-operator-preflight.md#prepared-change-and-verification-order) names bound-key and stale-login checks. No new live Turnkey session/bound-key attestation is claimed. |
| Deployment properties | Historical [preflight](evidence/production-preflight.json), [backup/restore](evidence/production-backup-restore.json), [content transport](evidence/production-content-transport.json) and [provider check](evidence/production-provider-check.json) retain their dates and scope. Current `deploy-env.test.ts`/`config.test.ts` run in the landing suite. The coordinator observed the base-SHA deployment and public health; current private settings/volume backup policy and corrected-SHA deployment are not newly established. |
| Reveal sweep and retention | [Current real rejected-reveal receipt](evidence/exact-revision-2026-10-03/regtest-reveal-rejected.json) proves recovery with browser closed and exact stored bytes; the route/reconciliation suite tests wiring and retention. Historical [final owner recovery](evidence/owner-mainnet-recovery-final.json) records confirmed/retired with both transaction payloads removed. |
| PNG and arbitrary files | Current real Chromium uploads and recovers exact PNG bytes; full landing tests cover file selection and Explore. Merged #726 accepts arbitrary file bytes, #681 provides public Explore reads and #773 fixes timing/rotation checks. The coordinator’s qualified public observation corroborates the existing owner PNG and accepted publication at the base deployment; it does not establish a clean-profile transcript or the corrected runtime in production. |

The [final historical chain observation](evidence/owner-mainnet-chain-final.json)
and [#519 owner record](https://github.com/onionoriginals/sdk/issues/519) remain
SDK 3 acceptance evidence, not rerun SDK 4 claims. No repeat inscription is
needed to reconcile #569. These limits do not convert sibling release tasks
into new prerequisites for the local pre-broadcast gate.

Remaining delivery steps and separate gates:

- Coordinator/reviewer: approve this correction, reconcile PR CI and the final API
  evidence, and decide #569's issue disposition using the bounded verdict above.
- Release owner/operator: approve and attest any corrected deployment and its
  provider/signing/storage properties; deployment was not authorized here.
- Release owner: finish the shared clean-profile public-inputs transcript for
  the existing mainnet asset, retaining PNG bytes/digests and all assurance
  limits. This run does not establish that transcript.
- Package release owner: build/pack and consumer-test the actual SDK 4 / CEL 2 /
  auth 4 version train. Workspace manifests/builds do not establish those
  artifacts or a registry publication.
