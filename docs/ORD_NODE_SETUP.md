# Ord Node Setup Guide

This guide covers setting up an `ord` node for running Bitcoin integration tests against the Originals SDK.

## Overview

The SDK's Bitcoin integration tests connect to a real [ord](https://github.com/ordinals/ord) indexer to validate inscription queries, fee estimation, and DID resolution against live blockchain data. Tests are gated behind the `ORD_SIGNET_URL` environment variable and are skipped when no node is available.

## Prerequisites

- **Bitcoin Core** (v25+): The underlying Bitcoin node
- **ord** (v0.21+): The Ordinals indexer and explorer
- **Disk space**: ~5 GB for signet (much less than mainnet's ~600 GB+)
- **RAM**: 2 GB minimum for signet indexing

## Quick Start (Signet)

Signet is the recommended network for integration testing. It's a centrally-controlled testnet with predictable block production and free test coins.

### 1. Install Bitcoin Core

```bash
# macOS (Homebrew)
brew install bitcoin

# Ubuntu/Debian
sudo apt-get install bitcoind

# Or download from https://bitcoincore.org/en/download/
```

### 2. Configure Bitcoin Core for Signet

Create or edit `~/.bitcoin/bitcoin.conf`:

```ini
# Network
signet=1

# RPC (required by ord)
server=1
rpcuser=originals
rpcpassword=originals-test
rpcport=38332

# Performance
txindex=1
dbcache=512
```

Start bitcoind:

```bash
bitcoind -signet -daemon
```

Wait for initial sync (signet syncs in minutes, not days):

```bash
bitcoin-cli -signet getblockchaininfo
# Wait until "initialblockdownload": false
```

### 3. Install ord

```bash
# From source (requires Rust)
cargo install ord

# Or download a release binary from https://github.com/ordinals/ord/releases
```

### 4. Start ord Indexer

```bash
ord \
  --signet \
  --bitcoin-rpc-username originals \
  --bitcoin-rpc-password originals-test \
  --bitcoin-rpc-port 38332 \
  server \
  --http-port 8080
```

ord will index the signet blockchain and start an HTTP server. Initial indexing takes a few minutes on signet.

### 5. Verify

```bash
# Check ord is running
curl -s http://localhost:8080/status

# Check a known signet inscription (if any exist)
curl -s http://localhost:8080/inscriptions
```

### 6. Run Integration Tests

```bash
cd packages/sdk

# Basic test run
ORD_SIGNET_URL=http://localhost:8080 bun test tests/integration/bitcoin-signet.integration.test.ts

# With a known inscription for deeper testing
ORD_SIGNET_URL=http://localhost:8080 \
ORD_TEST_INSCRIPTION_ID=<inscription-id> \
ORD_TEST_SATOSHI=<satoshi-number> \
bun test tests/integration/bitcoin-signet.integration.test.ts
```

## Network Reference

| Network | Bitcoin Config | ord Flag | Default RPC Port | Use Case |
|---------|---------------|----------|-----------------|----------|
| Signet | `signet=1` | `--signet` | 38332 | Integration tests (recommended) |
| Regtest | `regtest=1` | `--regtest` | 18443 | Local development, full control |
| Mainnet | (default) | (default) | 8332 | Production only |

## Regtest Setup (Alternative)

Regtest gives you full control: you mine your own blocks and can create inscriptions on demand. Useful for testing inscription creation and transfers.

### Start Bitcoin Core in Regtest

```bash
bitcoind -regtest -daemon -txindex=1 \
  -rpcuser=originals -rpcpassword=originals-test
```

### Create a Wallet and Mine Blocks

```bash
bitcoin-cli -regtest createwallet "test"
bitcoin-cli -regtest -generate 101
```

### Start ord on Regtest

```bash
ord \
  --regtest \
  --bitcoin-rpc-username originals \
  --bitcoin-rpc-password originals-test \
  server \
  --http-port 8080
```

### Create a Test Inscription

```bash
# Create a file to inscribe
echo '{"type":"test"}' > /tmp/test-inscription.json

# Inscribe it
ord --regtest wallet inscribe \
  --file /tmp/test-inscription.json \
  --fee-rate 1

# Mine a block to confirm
bitcoin-cli -regtest -generate 1
```

### Run Regtest Integration Tests

```bash
cd packages/sdk

# Read-only tests (ord node only)
ORD_REGTEST_URL=http://localhost:8080 \
bun test tests/integration/bitcoin-regtest.integration.test.ts

# Full tests including write operations (requires funded wallet + RPC)
ORD_REGTEST_URL=http://localhost:8080 \
BITCOIN_REGTEST_RPC_URL=http://originals:originals-test@localhost:18443 \
bun test tests/integration/bitcoin-regtest.integration.test.ts
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ORD_SIGNET_URL` | For signet tests | Base URL of the ord HTTP server on signet (e.g., `http://localhost:8080`) |
| `BITCOIN_SIGNET_RPC_URL` | No | Bitcoin Core RPC URL for signet fee estimation and broadcasting |
| `ORD_REGTEST_URL` | For regtest tests | Base URL of the ord HTTP server on regtest (e.g., `http://localhost:8080`) |
| `BITCOIN_REGTEST_RPC_URL` | For write tests | Bitcoin Core RPC URL for regtest write operations (e.g., `http://originals:originals-test@localhost:18443`) |
| `ORD_TEST_INSCRIPTION_ID` | No | A known inscription ID for read tests |
| `ORD_TEST_SATOSHI` | No | A known satoshi number with inscriptions |

## SDK Provider Options

The SDK includes two providers for connecting to ord nodes:

### OrdHttpProvider (Read-only)

Connects to an ord node's HTTP API for inscription queries. Uses stub implementations for fee estimation and write operations. Best for read-only integration testing.

```typescript
import { OrdHttpProvider } from '@originals/sdk';

const provider = new OrdHttpProvider({ baseUrl: 'http://localhost:8080' });
const sdk = OriginalsSDK.create({
  network: 'signet',
  ordinalsProvider: provider,
});
```

### SignetProvider (Full RPC)

Extends read-only ord access with Bitcoin Core RPC integration for real fee estimation and transaction broadcasting. Requires `bitcoinRpcUrl` for write operations.

```typescript
import { SignetProvider } from '@originals/sdk';

const provider = new SignetProvider({
  ordUrl: 'http://localhost:8080',
  bitcoinRpcUrl: 'http://originals:originals-test@localhost:38332',
  timeout: 15_000, // optional, default 10s
});

const sdk = OriginalsSDK.create({
  network: 'signet',
  webvhNetwork: 'cleffa',
  ordinalsProvider: provider,
});
```

| Feature | OrdHttpProvider | SignetProvider |
|---------|----------------|---------------|
| Inscription lookup | via ord HTTP | via ord HTTP |
| Fee estimation | Hardcoded | Bitcoin Core RPC (`estimatesmartfee`) |
| Transaction status | Stub | via ord HTTP |
| Broadcast | Stub | Bitcoin Core RPC (`sendrawtransaction`) |
| Inscription creation | Stub | Requires `ord wallet` CLI |
| Inscription transfer | Stub | Requires `ord wallet` CLI |

## Troubleshooting

### ord fails to connect to Bitcoin Core

Verify RPC credentials match between `bitcoin.conf` and ord flags:

```bash
bitcoin-cli -signet -rpcuser=originals -rpcpassword=originals-test getblockchaininfo
```

### ord indexing is slow

Increase Bitcoin Core's dbcache:

```ini
# In bitcoin.conf
dbcache=1024
```

### Tests timeout

The integration tests use standard fetch timeouts. If your ord node is on a remote server, network latency may cause issues. The test suite includes a 10-second timeout for connectivity checks.

### "Address not valid for network" errors

Ensure the SDK's `network` config matches the ord node's network:
- Signet ord node: use `network: 'signet'`
- Regtest ord node: use `network: 'regtest'`

## CI/CD Integration

For automated testing, you can run ord in a Docker container. Example `docker-compose.yml`:

```yaml
services:
  bitcoin:
    image: lncm/bitcoind:v27.0
    command: >
      -signet -server -txindex=1
      -rpcuser=originals -rpcpassword=originals-test
      -rpcallowip=0.0.0.0/0 -rpcbind=0.0.0.0
    ports:
      - "38332:38332"

  ord:
    image: ordinals/ord:latest
    depends_on:
      - bitcoin
    command: >
      --signet
      --bitcoin-rpc-url http://bitcoin:38332
      --bitcoin-rpc-username originals
      --bitcoin-rpc-password originals-test
      server --http-port 8080 --address 0.0.0.0
    ports:
      - "8080:8080"
```

Then in CI:

```bash
docker compose up -d
# Wait for sync
sleep 30
ORD_SIGNET_URL=http://localhost:8080 bun test tests/integration/bitcoin-signet.integration.test.ts
```
