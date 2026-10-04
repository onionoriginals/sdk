# Existing owner Original: clean-browser mainnet acceptance

**PASS** for the shared #525/#527/#540 cold-start acceptance requirement on
October 4, 2026 UTC (October 3 in Vancouver). The owner’s existing September 7
mainnet PNG verifies from a newly created, empty Chromium profile with no
account, session, local artifacts or imported keys. No asset was created,
funded, signed, inscribed, transferred or otherwise changed during this run.

The September owner journey supplies the historical creation/funding evidence;
this run supplies the previously missing fresh-browser verification. It does
not claim to recreate the original SDK 3 deployment. The actual deployed and
published versions are now SDK **4.0.0**, CEL **2.0.0**, auth **4.0.0**, with
landing **0.2.1**. The historical asset remains valid under that implementation.

## Revision and gate evidence

Source/deployed commit: `21891c0a24e14574a4a5e8b13858e3e3c5bd8211`.
Railway’s successful `builder` deployment is
`0da6b97a-1e57-4032-8224-da6d0088da9d`, created October 4 at 01:24:39 UTC,
serving `originals.build`. [Deployment metadata](evidence/mainnet-acceptance-2026-10-04/deployment.json)
was re-read after the browser run. Six served JavaScript bundles, including the
application entry, SDK, CEL history, Explore verifier and public sat provider,
match a clean build of that commit byte-for-byte. The build used
`NODE_ENV=production`, `VITE_BTC_NETWORK=mainnet`,
`VITE_WEBVH_HOST=originals.build`, with other inherited `VITE_*` variables removed.
[Bundle hashes and comparison](evidence/mainnet-acceptance-2026-10-04/bundle-comparison.json).
This corroborates the deployed browser runtime; it is not a private-server
configuration or backup-policy audit.

The prior #569 gate is already closed by merged #942. Its 19 retained evidence
hashes were checked with no mismatch. Subsequent identity/version changes are
covered by [successful deployed-SHA CI](https://github.com/onionoriginals/sdk/actions/runs/37167925201)
and [successful Core/ord + Chromium CI](https://github.com/onionoriginals/sdk/actions/runs/37167471663)
at `6cfbf788a6ab67c78e095145e3d7397500d86761`. That release-PR head has an
**identical Git tree** to the deployed merge commit. Downloaded receipts retain
all three creator/recovery scenarios, no-address-index check, node restarts,
and both real Chromium recovery scenarios under
[hosted-regtest](evidence/mainnet-acceptance-2026-10-04/hosted-regtest/).
Those are existing hosted executions, not local reruns claimed by this report.

Fresh local package builds, package types, 26 Node ESM entry points,
browser-safety checks and the production landing build passed. The signed,
mainnet-format dry run passed **24/24** checks using mock funding and a public
test key. It retained the signed pair and refused the provider broadcast by
construction, with **zero broadcast-route calls**. It proves construction and
read-back, not public-chain submission.
[Dry-run receipt](evidence/mainnet-acceptance-2026-10-04/dry-run.json).
An additional unscoped root `bun test` invocation runs the Node-specific
`scripts/chain-validator-node.test.mjs` under Bun and fails that transport check
with `SAT_SNAPSHOT_CHAIN_UNAVAILABLE`. Its prescribed
`node --test scripts/chain-validator-node.test.mjs` invocation passes 1/1. This
runner mismatch is recorded separately; the release workflow uses Node for
that check, and the hosted package/landing gates are the passing evidence above.
Fresh `bun run lint` also passes.

The live issue query had zero open bug tickets; that is tracker state, not a
fresh independent audit of every closed finding.
[Gate/version summary](evidence/mainnet-acceptance-2026-10-04/summary.json).

## Fresh-browser transcript

[Machine-readable receipt](evidence/mainnet-acceptance-2026-10-04/receipt.json)
and [full-page screenshot](evidence/mainnet-acceptance-2026-10-04/clean-browser.png)
retain the actual observation. Chromium **149.0.7827.55** ran in a new empty
temporary profile directory, which was removed after the browser closed.
Before loading the application: cookies, local/session storage, IndexedDB,
CacheStorage and service-worker registrations were empty, and `/api/me`
returned **401**. Cookies and local/session storage remained empty afterward.
Only GET/HEAD requests to `https://originals.build` were allowed; no attempted
write or unexpected-origin request occurred, and no page exception occurred.

The normal public Explore page displayed the owner asset and waited for all
applicable checks before showing its verified result. The deployed browser
verifier returned:

| Check | Result |
| --- | --- |
| Primary PNG | PASS: 3,857 bytes, SHA-256 matches the retained owner proof. |
| WebVH | PASS: one signed method-log entry, SCID and Ed25519 proof verified; public `did.jsonl` still responds successfully after Bitcoin publication. |
| Hosted CEL | PASS: two signed controller events and WebVH backlink verified. |
| Bitcoin | PASS: one accepted on-chain publication on the expected sat and asset identity, reconstructed from a fresh public snapshot. |

A supplemental read-only probe **in that same browser** then used the deployed
SDK modules to reconstruct all three accepted controller events, resolve WebVH
afresh, and attach only newly fetched, authenticated hosted bytes. This is the
same full-resource reconstruction pattern as the regtest browser runner.
`loadAsset(...).verification.verified` was **true**, at the same accepted
Bitcoin head. The ordinary Explore UI verifies the primary file/publication;
the supplemental browser probe establishes full verification including the
second resource. This is not a separate Node verification substituted for the
browser requirement.

## Retained asset and funding identifiers

| Fact | Observed/retained value |
| --- | --- |
| Asset identity | `did:cel:uEiCt-PPt6WQV7pEvvR-fu2tQszVfbbQy8uIaqcE5aX2TPw` |
| Bitcoin alias / sat | `did:btco:321959825743820` / `321959825743820` |
| Inscription | `cdb2eccae0a929f7e5c7459893eb34e24d8099850e04d323963d19d5f4a344d9i0` |
| Commit | `60ecfcae52ba594f5bda2d2657bf965df4df419bc87681aee2f40cf4d57755fa` |
| Reveal | `cdb2eccae0a929f7e5c7459893eb34e24d8099850e04d323963d19d5f4a344d9` |
| Funding input 1 | `b15bceae8c1d01d5e69495ba508ecca867b3361393488163526709aa0ebb41ee:1`, 6,978 sats |
| Funding input 2 | `09de7a2193f1aa845b04603f1805e897d8731fe1f5a50fc3ff9cdb07b47f8c08:0`, 5,000 sats |
| Controller | `did:key:z6Mko6cJwm5KinFfo3NFSMVjH7U145mD5R3ECGpKWsNWd3ui` |
| Accepted Bitcoin head | `uEiDc-LgUKMpRyHs_ILvGBWSyLOLUNZ4E5pYfVIANXd4LGw` |
| Still-resolving hosted head | `uEiD4at5wYdRpvXxpIe37qDwHcTzpGX9SD_eia1MBGzKINg` |
| PNG SHA-256 | `98bbbe3fed7293f4b2c335f66fe76025ef9da84c18a905d297598aafaa663e33` |
| Hosted metadata | 257 bytes; SHA-256 `447201c82e21ef0727f3b56566c5852b5b83e6389faebe2b56ba457855aef717` |

The full WebVH identifier and exact signed hosted artifacts are retained in
[receipt.json](evidence/mainnet-acceptance-2026-10-04/receipt.json),
[hosted-did.jsonl](evidence/mainnet-acceptance-2026-10-04/hosted-did.jsonl) and
[hosted-cel.json](evidence/mainnet-acceptance-2026-10-04/hosted-cel.json).
[Funding identifiers](evidence/mainnet-acceptance-2026-10-04/funding-identifiers.json)
come from a public read of the historical commit transaction. They identify
its actual input transactions; no new deposit was made.

## Assurance limits and recorded papercuts

- Chain, enumeration, content and ownership observations remain
  **provider-asserted**. The sat trajectory is **not independently derived**.
  The browser verifies signatures, history, identity and byte digests; this
  report does not claim independent consensus validation or Bitcoin finality.
- The PNG is Bitcoin-inline. `metadata.json` remains hosted; sat-only asset
  verification correctly reports that resource missing. Full verification
  succeeds after fetching and authenticating it from the public host.
- Current API identity is again `did:cel:<SCID>` following merged #943/#944;
  older `ni:` map prose is historical. No signed artifact was rewritten.
- The homepage still advertises `npm install @originals/sdk@next` and says
  the 3.x line is prerelease, despite npm `latest` being SDK 4.0.0. Record this
  copy defect as follow-up; it does not invalidate the existing asset proof.
  Unrelated local edits already address install-copy honesty and were preserved.
- The historical owner receipt’s browser Buffer error/recovery and timeline
  papercut remain in [the original proof](evidence/owner-mainnet-proof.json).
  This verification-only run does not invent a new creator-experience account.

This receipt completes the historical owner journey’s missing cold-start
acceptance on the actual current deployment. It does not authorize or claim a
new deployment, merge, publication, mainnet signing or spending action.

## Reproduce

From the repository root with dependencies installed and Playwright Chromium
available:

```sh
MAINNET_PROOF_DIR=/tmp/originals-mainnet-proof \
  node docs/release/evidence/mainnet-acceptance-2026-10-04/verify-mainnet.mjs
```

The probe is pinned to the observed deployed bundle filenames and fails if
those modules disappear. It uses a new temporary Chromium profile and a
read-only, same-origin network allowlist. `CHROMIUM_PATH` optionally selects an
installed browser. Re-running observes a later chain tip and is a new receipt.
The non-broadcast fixture can be repeated with:

```sh
bun docs/release/evidence/mainnet-acceptance-2026-10-04/dry-run.ts
```

`SHA256SUMS.json` records the retained evidence files. Browser profiles, keys,
private Railway configuration and unrelated user changes are excluded.
