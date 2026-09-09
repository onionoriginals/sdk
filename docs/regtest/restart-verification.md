# Core and ord restart verification

The restart check is a separate real-node proof for release issue #570. It uses
the same pinned Bitcoin Core 31.1 and ord 0.29.0 installer as the creator journey.
It does not need an SDK build or a public-chain wallet.

The standard `bun run regtest` command includes this check after the creator
journeys and index-capability check. For example:

```sh
REGTEST_RECEIPT=/absolute/path/receipt.json \
REGTEST_LOGS_DIR=/absolute/path/regtest-logs \
bun run regtest
```

This retains the restart receipt as `receipt-restart.json` and its logs under
`regtest-logs/restart/`. To run only the restart check from the repository root
after installing Bun dependencies:

```sh
REGTEST_RECEIPT=/absolute/path/restart-receipt.json \
REGTEST_LOGS_DIR=/absolute/path/restart-logs \
bun scripts/regtest/restart-check.ts
```

On supported platforms the runner downloads and verifies the pinned binaries.
Set both `BITCOIND_BIN` and `ORD_BIN` to use previously installed binaries. The
receipt records the actual versions, inscription ID and sat, content hash,
retained and newly indexed block hashes, and temporary data directory. A failed
assertion or failed service returns a nonzero exit; connectivity is never skipped.

The proof creates a fresh Core chain, matures coinbase funds, creates a disposable
ord wallet, funds it, and mines a real text inscription. It restarts ord alone,
Core alone, and both services. Each restart must preserve the same chain tip,
wallet balances and loaded wallets, inscription satpoint, and exact content bytes.
Each is followed by a new mined block that ord must index. It also submits two
restart requests concurrently to check serialization, deliberately fails the final
Core process start, verifies that neither endpoint remains listening, calls stop
twice, and checks that restart after stop is rejected. The final receipt is only
written after all checks pass. Wallet recovery material and RPC credentials are
never included in the receipt.

## Harness controls

```ts
const env = await startRegtest();
try {
  await env.restart('ord');
  await env.restart('core');
  await env.restart('both'); // also the default for restart()
  await env.mine();
} finally {
  await env.stop();
}
```

Restart keeps the existing temporary chain, ord index, wallet files, mining
address and loopback ports. Core restart reloads every wallet that was loaded
before stopping. It does not create another wallet, remine the initial chain,
or clear an index. Every call to `startRegtest()` creates a separate fresh
environment; stopping and starting a new environment is the isolated reset.

Core regenerates its RPC cookie on restart. `env.rpc()` automatically uses the
new cookie, and `env.rpcAuth` is a getter for its current contents. Consumers
that copied the previous string must refresh it or recreate their provider after
Core restart before making further RPC calls.

ord 0.29.0 caches its Core RPC authentication for the life of the process. The
harness therefore gives ord a separate random `rpcauth` identity that survives
Core restart within this environment. Its credential file is owner-readable and
stored only in the temporary directory. Core's default cookie still rotates;
this does not reuse a credential across fresh environments.

`env.sync()` verifies ord's regtest chain and required indexes, then compares both
indexed height and block hash with Core. Matching height alone is insufficient
after a reorganization. Readiness retries transient connection/index delays for
up to 30 seconds, with bounded individual HTTP requests and process-exit checks.
A service that exits aborts readiness immediately. Shutdown sends SIGINT, waits
up to five seconds, then kills a remaining process. A failed restart shuts down
both services and rejects with the retained log directory; that environment
cannot be restarted again. Restart and stop operations are serialized.

Logs for the initial process are `bitcoin.log`, `bitcoin.error.log`, `ord.log`,
and `ord.error.log`. Further generations add a number, such as `bitcoin.1.log`.
Shutdown exports every generation to `REGTEST_LOGS_DIR` when configured. Temporary
data remains available for diagnosis; reset never deletes a user node directory.

This proves local process restart and persistence. It does not claim an
operating-system crash, abrupt power-loss recovery, hosted signer support, or a
mainnet release proof. The browser recovery proof is tracked separately in #572.

## Regression captured during implementation

The first real Core-only restart trial on September 7, 2026 used Core's default
cookie for the running ord process. Core restarted successfully and regenerated
that cookie, but the surviving ord process repeatedly logged:

```text
Updating index: JSON-RPC error: transport error: unexpected HTTP code: 401
```

The proof reached its Core-only stage and then could not index the next block.
The failing environment retained `ord.1.error.log` under
`/var/folders/8d/12c7x8091yg51n30wlqqzdv80000gn/T/originals-regtest-k0XRbY`.
This is the observed regression that requires the separate disposable ord RPC
identity. The check deliberately mines after every restart so an old matching
index tip cannot hide an indexer that has lost RPC access.

The subsequent local run passed on September 7, 2026 with `Bitcoin Core daemon
version v31.1.0 bitcoind` and `ord 0.29.0`. It preserved inscription
`00de7d67905fa1924d7b89897d4741a9010cb2cd788d7b3e90755d465c688aa0i0`
on sat `9899999670` through every restart, indexed successive blocks at heights
104–106, and passed the concurrent restart and deliberate failure cleanup checks.
The initial local receipt was `/tmp/originals-restart-proof.json`; release
integration retains that receipt alongside the other regtest evidence.
