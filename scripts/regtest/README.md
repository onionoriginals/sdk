# CEL 3 release journey

Run `bun run regtest` from the repository root. The runner verifies and installs
pinned Bitcoin Core 31.1 and ord 0.29.0 binaries, builds the workspace packages,
typechecks the harness, and runs three disposable chains sequentially:

- normal commit/reveal delivery;
- reveal rejection, followed by recovery from a recreated server/store through
  the background sweep without a browser retry;
- commit accepted by Core with its response lost, followed by exact-pair recovery
  from the recreated server/store.

`REGTEST_FAULT` selects one scenario (`none`, `reveal-rejected`, or
`commit-response-lost`). `REGTEST_RECEIPT=/absolute/path/receipt.json` writes a
JSON receipt per scenario, and `REGTEST_LOGS_DIR` captures the Core and ord logs.
Set both `BITCOIND_BIN` and `ORD_BIN` to use already installed binaries. The
runner does not download dependencies or use a public Bitcoin network.

The journey uses the public CEL 3 SDK, actual HTTPS upload and Bitcoin submission
routes, and fresh Core/ord observations. A disposable CA authenticates
`regtest.localhost` without changing system trust. This reserved loopback hostname
must resolve locally on the runner. Resource bodies and CBOR metadata are read
back from mined inscriptions; they are not synthesized from the writer result.

Each scenario checks local creation, a separate genuine WebVH method log and CEL
publication, full PNG boundary publication, exact signed-pair persistence,
boundary reorganization and reconfirmation, six-confirmation byte retirement,
and fresh JSON/resource/DID recovery. Later transactions check a controller
rotation plus update in one log-only delta, rotation rollback on an empty
replacement branch, reconfirmation, a real sat sale and reacquisition, a new raw
resource version, and terminal deactivation. Possession never changes the CEL
head or reauthorizes a retired key.

The signer is a disposable local key through `TurnkeySatSigner`. This proves the
adapter transaction path, not a live Turnkey service call or production hosting.
It does not replace the separately required owner mainnet release proof.
