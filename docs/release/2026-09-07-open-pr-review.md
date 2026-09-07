# Open PR release review — September 7, 2026

Reviewed all ten open PRs against current main, their descriptions and linked
requirements. Standards and specification reviews ran independently. Existing
review threads were already resolved; the new findings came from source review,
reproduced checks, and combined release validation.

| PR | Disposition |
| --- | --- |
| #580 | Fixed missing lockfile and empty release metadata; CEL tests and CI pass. Merged. |
| #579 | Artifact action upgrade matches hosted-runner use; CI/regtest pass. Merged. |
| #576 | Release integration carries the fixes below and exits prerelease mode. |
| #554 | Public identity domain guards were integrated; carried its final explicit-domain playground fix and tests. Superseded by #576. |
| #551 | Browser-key binding refusal, user notice and tests are integrated in #576. Superseded. |
| #547 | Hero role labels preserve demo labels and mobile visibility. Merged. |
| #533 | Reconciled current Turnkey types, refreshed lockfile, and separated private-app/public-package changesets for CLI 3. Auth/landing tests and CI pass. Merged. |
| #528 | One timing outlier is tolerated without changing its threshold. Merged. |
| #517 | Carried durable-storage enforcement and writer exclusion, dependency remediation and audit CI. CEL 3 replaces its historical asset verification APIs and examples. Existing release ESM tests already preserve installations. Superseded by this integration. |
| #490 | Regenerate after #576. Its captured prerelease head must not be used for the stable release. |

## Fixed findings

- Dependency manifests and frozen lockfiles now agree. Changesets CLI 3 rejects
  a mixed private/public changeset on the old main config; splitting #533's
  metadata preserves both intentions without bypassing the gate.
- The historical playground refuses an omitted publication domain instead of
  minting at an unserved fallback host.
- Deployed authenticated storage failures are fatal independently of strict
  config. The server acquires writer ownership before opening either store.
- Review reproduced a displaced-holder release race in the proposed heartbeat
  lock. Replaced it with a persistent SQLite exclusive transaction: paused
  holders cannot be displaced; process death releases ownership. Real subprocess
  tests cover exclusion, SIGKILL, graceful shutdown and an aged paused holder.
- Published JSON-LD processing now resolves maintained Undici 6. Repository and
  clean packed-consumer audits report no vulnerabilities. Root overrides alone
  were insufficient evidence for npm consumers.
- JSON-LD 9 moved RDF options under `canonizeOptions`. Passing the identifier map
  there restores all BBS selective-disclosure roundtrips. Invalid legacy
  credential canonicalization now returns false within the verification guard.
  The migration guide documents corrected control-character escaping and graph
  complexity limits; affected old credentials may need reissuing. CEL 3 event
  canonicalization is independent.

## Verification

- Package suites: 4,655 pass, 248 explicit skips, zero failures. Historical-format
  tests remain distinct from the new CEL 3 publication evidence.
- Landing: 1,045 pass, zero failures, plus frontend/server typechecks and build.
- Package typechecks, public API types and lint pass; existing warnings remain.
- Twenty-four built exports import under Node 20.10. Browser safety checks pass
  with the existing lazy Bitcoin Buffer advisories.
- All real Core 31.1 / ord 0.29.0 scenarios pass: normal delivery, rejected reveal,
  accepted commit with lost response, and resolution without an address index.
- Isolated stable preview produces CEL 1.0.0, SDK 3.0.0 and auth 3.0.0. Fresh npm
  tarball installation, Node 20.10 root imports, creation, queued edits and cold
  recovery pass. Consumer npm audit reports zero vulnerabilities.

## Review limits and release order

No remaining hard Standards findings. One optional duplication heuristic remains:
Explore's multihash conversion could share the existing client digest utility.
It does not block the release.

Merge #576 after current CI passes, retire the three superseded PRs, inspect the
regenerated #490 versions and publish plan, then merge #490 and verify actual npm
versions, tags and imports. The earlier owner mainnet proof remains the production
chain evidence; this pass used disposable regtest chains and spent no real BTC.
