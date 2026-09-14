# Independent ownership verification on real Core/ord

PR #669's matching-tip gate is exercised by the standard creator journey using
two disposable Bitcoin Core processes and two separate ord indexes. The second
node validates imported raw blocks before starting its index. All observations
come from fresh `RegtestProvider` RPC and ord reads through the built public SDK;
no snapshot fixture or mocked provider substitutes for either endpoint.

Run all three publication/recovery scenarios, the capability check, and the
restart proof from the repository root:

```sh
REGTEST_RECEIPT=/tmp/ownership-receipt.json \
REGTEST_LOGS_DIR=/tmp/ownership-logs \
bun run regtest
```

The runner builds the SDK before execution. `scripts/regtest/ownership-check.ts`
is called from `apps/landing/scripts/regtest-journey.ts` in every fault scenario.
The existing regtest GitHub Actions workflow runs it and uploads receipts and
logs, including the second pair's `independent-ownership/` log directory.

Each journey verifies:

- One index alone reports provider-asserted ownership.
- Two indexes at identical height/hash corroborate the mined inscription's holder
  and satpoint; asset and DID metadata both report cross-checked ownership.
- Equal holder values at different heights do not earn cross-checked ownership.
- Real branches at the same height but different hashes also do not earn it.
- Rejoining the primary chain restores cross-checked ownership.
- An actual sat sale, and subsequent reacquisition, change owner/satpoint. The
  lagging index keeps its old holder, so assurance stays provider-asserted until
  real block import and index catch-up establish agreement.
- A restarted second pair corroborates ownership after its Core cookie rotates.
- Stopping the configured second pair makes asset and DID reads fail incomplete;
  the DID document is absent and no cross-checked ownership is reported.

Receipts record both real tips, both owner/satpoint observations and the returned
assurance at every stage. They are execution records, not test inputs. The
[checked-in receipt](receipts/ownership-669.json) retains public regtest identifiers
and observations while omitting local paths and RPC credentials.

The regression was also run with the SDK matching-tip gate temporarily disabled.
It failed at `lagging-tip-same-owner`: actual `cross-checked`, expected
`provider-asserted`. Restoring the gate is necessary for the real-node test to
pass; merely adding an unrelated node smoke test would not catch this defect.

Two local indexes corroborate current holder observations. This does not claim
independent derivation of sat trajectory, operator diversity in production, or
public-network release qualification. Issue #594 remains open for its broader
verification requirements.

## Executed validation

On 2026-09-14 UTC, Bitcoin Core v31.1.0 and ord 0.29.0 passed all three
creator/recovery journeys, with nine recorded ownership observations per journey,
plus the no-address-index capability and dedicated restart checks.
The mutation run failed at the expected ownership assertion and the restored
implementation passed. The 96 focused CEL publication/SDK resolution tests and
three environment tests passed, as did builds, regtest typechecking, public types,
Node ESM/browser checks, and lint (zero errors; existing warnings remain).
