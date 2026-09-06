# Preceding-format regtest after the default SDK cutover

These three receipts came from the local September 6, 2026 cutover validation.
They use the explicit private landing adapter and the preceding representation,
including AssetEnvelope v2. They are **not CEL 3 inscription evidence**.

Run from the repository root after building, using the pinned binaries:

```sh
BITCOIND_BIN=/tmp/originals-regtest-tools/bitcoin-31.1/bin/bitcoind \
ORD_BIN=/tmp/originals-regtest-tools/ord-0.29.0/ord \
REGTEST_RECEIPT=/tmp/originals-sdk-v3-default-baseline.json \
REGTEST_LOGS_DIR=/tmp/originals-sdk-v3-default-regtest-logs \
bun run regtest
```

The command runs all three fault modes in isolated disposable local chains.
Receipt transaction IDs, hosts and data directories are local historical test
values. Temporary chain data was cleaned up; no public-chain assets were moved.

- [Normal journey](none.json)
- [Reveal rejected](reveal-rejected.json)
- [Commit response lost](commit-response-lost.json)

The [parent validation receipt](../default-cutover-validation.json) records the
exact implementation diff and hashes of these artifacts.
