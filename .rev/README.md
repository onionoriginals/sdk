# REV tests gate

The `REV` check decides each PR push in code, without an API key or model call. Jev never runs per push: it reviews each PR's contract once, before the digest is pinned.

## Per PR

1. **Write `.rev/task.json` (version 2).** Each criterion has an observable `description`, the `tests` that establish it, and the `paths` (globs) of the files that serve it. Test IDs are `repository-relative file > describe > … > test name`. Bun runs `.test.ts` files from their package directory; Node runs `.test.mjs` files from the repository root.
   ```json
   {
     "version": 2,
     "task": "Reject malformed prevTxHex.",
     "criteria": [{
       "id": "prev-tx",
       "description": "Funding with prevTxHex that is not raw transaction hex fails with INVALID_PREV_TX.",
       "tests": ["packages/sdk/tests/unit/bitcoin/transactions/prev-tx-hex.test.ts > prevTxHex > rejects non-hex input"],
       "paths": ["packages/sdk/src/bitcoin/transactions/commit.ts", "packages/sdk/tests/unit/bitcoin/transactions/prev-tx-hex.test.ts"]
     }]
   }
   ```
2. **Keep `.rev/contract.json` current.** It holds the original request and the required CI job IDs.
3. **Collect the change** from a checkout of the PR head:
   ```sh
   node ../rev/scripts/tests-change.js BASE_SHA HEAD_SHA .rev/contract.json .rev/task.json /tmp/change.json
   ```
4. **Have Jev review the contract and pin it:**
   ```sh
   TYPESAFE_API_KEY=… node ../rev/scripts/review-contract.js .rev/task.json /tmp/change.json --pin onionoriginals/sdk PR_NUMBER
   ```
   Jev checks that the criteria cover the request and that each criterion's tests would establish it. Only on approval does the script set `REV_CONTRACT_PR_<number>`. Omit `--pin` for a dry run.

The digest covers the task, request, required checks and the exact contents of every named test file. Changing any of them after review fails the gate with `contract-mismatch` until the contract is reviewed again.

## What the gate checks on every push

- Each named test passes on the PR head and does not pass when the head's test files run against merge-base sources (`rev-tests` job, `.rev/run-tests.mjs`).
- Every changed file matches a criterion's path glob.
- Every required CI job succeeded, and the head, base and contract digest match.

See the [REV tests gate guide](https://github.com/aviarytech/rev/blob/main/docs/tests-gate.md). A green `REV` shows that reviewed tests pin the change; it does not establish merge readiness.
