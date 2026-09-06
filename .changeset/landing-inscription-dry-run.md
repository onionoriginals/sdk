---
'@originals/landing': patch
---

**A dry run of the inscription path that never broadcasts (#526).**

`bun run dry-run:inscription` (`scripts/dry-run-inscription.ts`) builds and signs a commit and reveal pair through the code that ships: the server's deposit, fee, sat, prevtx and inscribe routes, the browser's provider and signer wrappers, and the SDK's commit and reveal builders. The provider underneath rejects every broadcast-shaped call and the broadcast route is not reachable, so the inscribe route runs every invariant, persists the pair, and stops at the broadcast step. With `QUICKNODE_ENDPOINT` it reads mainnet; without one it runs the mock provider over a fixture deposit.

The record prints both raw transactions, the live fee estimate and the 1.5x quote against what the pair actually pays, every confirmed output at the address with its ordinal classification and whether it was selected, the reveal key with a freshness proof, the sat's path to the deposit address, and a pass/fail checklist with a one-line judgement. A local key stands in for the Turnkey API call when `DRY_RUN_WIF` is set; without it the commit stays unsigned and the verdict is INCOMPLETE, never PASS.
