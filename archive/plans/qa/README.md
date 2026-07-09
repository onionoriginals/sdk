# QA — Canonical Quality Artifacts

Source of truth for the continuous QA effort on the Originals SDK + auth. Generated/maintained by the QA workflow + reviewed test-writing executors.

## Files
- **`feature-test-matrix.csv`** — canonical spreadsheet, one row per feature (244): Feature ID, Name, User Story, Expected Behaviour, Edge Cases, Test Cases, Current Status, Defect Count, Severity, Notes, Last Tested Date.
- **`test-cases.csv`** — every generated test scenario (958), with iter-1 coverage status.
- **`defects.csv`** — all logged defects (17 from iter-1, all resolved on main; 4 from iter-3, open).
- **`iteration-03-report.md`** — detailed report for the latest iteration.

## Method
1. **Discover** — a 22-agent workflow read all 10 subsystems and produced the 244-feature inventory.
2. **Generate** — 958 test scenarios mapped to existing coverage.
3. **Execute / Cover** — reviewed executors wrote real tests for uncovered high- then lower-risk paths, against `main`, asserting *actual* behavior and STOP-and-reporting (not masking) any defect.

## Scorecard progression

| Metric | Iter 1 (discover) | Iter 2 (high-risk) | Iter 3 (lower-risk) |
|---|---:|---:|---:|
| Features discovered | 244 | 244 | 244 |
| Test scenarios | 958 | 958 | 958 |
| Scenario coverage (existing, iter-1 baseline) | ~75% | — | — |
| High-risk uncovered (money/crypto/auth) | 44 | **0** | 0 |
| Lower-risk uncovered (migration/DID/utils) | ~73 | ~73 | **~0 (covered or .skip'd w/ finding)** |
| New tests added | — | +101 | +~190 |
| SDK suite | 2466 / 0 fail* | 2540 / 0 | **2729 / 0** |
| Open defects (critical/high) | 0 (on main) | 0 | **1 High (rotation)** |
| Confidence (on main) | ~76 | ~82 | ~84 (high-risk covered; 1 High defect to fix) |

\* iter-1 execution ran against a stale branch and reported 15+2 failures; all were already fixed on `main` (#170) — see defects.csv rows DEF-1001..DEF-1017 (Resolved on main).

## Open findings (iteration 3)

| ID | Severity | Finding |
|---|---|---|
| DEF-018 | **High** | `rotateDIDWebVHKeys` fails at the 3rd sequential rotation (`WebVHManager.appendKeyChange`) — security-relevant |
| DEF-019 | Medium | `LifecycleValidator` is a stub — does not reject deactivated assets |
| DEF-020 | Medium | `CredentialValidator` is a stub — no real compatibility check |
| DEF-021 | Low | `StorageValidator` treats missing adapter as warning, not blocking error (confirm intent) |

These are implementation gaps the new tests exposed; fixes are gated remediation (Phase 4) and tracked for follow-up plans — DEF-018 first.

## Coverage delivered as PRs (test-only, no source changes)
- **#174** — iteration 2 (high-risk): Bitcoin, Auth, crypto/VC/CLI (merged to main).
- **#179** — iteration 3 (lower-risk): migration, DID, utils + these QA artifacts.

## Remaining for future iterations
- The **122 partially-covered** features need negative-path / adversarial depth.
- 68 skipped SDK tests unassessed.
- Re-run discovery to refresh this matrix after the open findings are fixed.

The recursive loop's exit criteria are **not** fully met: 1 High defect open + partial-coverage depth remains.
