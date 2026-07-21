# Landing Demo — Real testnet4 Inscription (Track B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the landing demo's "Inscribe" step do a REAL Bitcoin **testnet4** inscription, login-gated: the logged-in user's OWN Turnkey key signs the commit in the browser, funding comes from a **Turnkey-org faucet** (the server signs the faucet's own funding tx via its Turnkey API creds — NO raw private key anywhere on the server), the commit/reveal broadcast through QuickNode, and the UI surfaces the real txid + a testnet4 explorer link. Everything is gated on env (`QUICKNODE_ENDPOINT` + a faucet Turnkey wallet id); when absent the demo falls back to the existing `OrdMockProvider` mock path unchanged.

**Plan 2 of 2 for issue #417.** Plan 1 (`2026-07-16-landing-real-webvh-hosting.md`) delivered real did:webvh hosting + the unified Bun server and is **merged/available** — this plan does NOT re-do it. It builds on the same unified server (`apps/landing/serve.ts` + `apps/landing/server/*`) and the same engine (`apps/landing/src/sdk/engine.ts`, which already hosts did:webvh and proves resolution).

**Architecture:** A small SDK change adds first-class `'testnet'` support (testnet4 shares signet's `tb1` address encoding; the did:btco network prefix is `test` — already parsed by `BtcoDidResolver`). The browser drives a real sat-selected inscription via the SDK's merged `inscribeOnBitcoin(asset, { fundingUtxo, satSigner, changeAddress, feeRate })` path (PR #414): an `HttpOrdinalsProvider` (SDK `OrdinalsProvider` over `POST /api/btc/{sat,fee,broadcast}` QuickNode proxies) supplies sat-lookup/fee/broadcast, and a `TurnkeySatSigner` (SDK `BitcoinSigner`) signs the commit with the user's Turnkey session key via Turnkey `signTransaction` (P2WPKH, SIGHASH_ALL) → `@scure/btc-signer` finalize. Funding is a new authenticated `POST /api/btc/funding`: the server builds+signs a faucet funding tx from a **Turnkey-org faucet wallet** to the user's testnet4 P2WPKH address and broadcasts it, returning `{ fundingUtxo, changeAddress }` (the user's own address). The auth layer gains the missing Turnkey **OTP_LOGIN** step (installing the browser P-256 key as the session credential) so the credential-less sub-org can sign silently, plus a dedicated testnet4 P2WPKH wallet account.

**Tech Stack:** Bun (runtime + test runner), TypeScript, `@originals/sdk` (rebuilt with testnet support), `@scure/btc-signer`, `@turnkey/sdk-server` (server faucet), `@turnkey/sdk-browser` + `@turnkey/api-key-stamper` + `@turnkey/crypto` (browser session signing), `QuickNodeProvider`, Vite 8 / React 19, `@originals/auth`.

## Global Constraints

- **Runtime & tests:** Bun only. SDK tests live in `packages/sdk/tests/unit/**/*.test.ts` (run from `packages/sdk`). Landing server tests in `apps/landing/server/tests/*.test.ts`; landing browser/SDK tests in `apps/landing/src/**/*.test.ts`. Run landing tests with `cd apps/landing && bun test <path>`; run SDK tests with `cd packages/sdk && bun test <path>`. Import test primitives from `bun:test`.
- **The SDK must be rebuilt** (`bun run build` at repo root) after Task 1 and BEFORE the landing app imports the new `network: 'testnet'` support — the landing app consumes the built `packages/sdk/dist`, not `src`.
- **Absolute imports inside the SDK package only.** Inside `apps/landing` use the existing relative-import style already present in the files you touch.
- **Noble imports:** `@noble/hashes/sha2.js` (never `/sha256`).
- **Multikey encoding only** — never JWK.
- **No raw private keys anywhere on the server.** The faucet is a Turnkey-org wallet; the server authorizes its funding tx with the SAME Turnkey API credentials it already uses for auth (`getTurnkey()`). The user's inscription is signed by the user's own Turnkey session key in the browser. The browser never sees any private key except its own ephemeral P-256 session key (generated in-browser, already the case in `auth/api.ts`).
- **Login-gated + rate-limited.** Every `/api/btc/*` route is auth-gated (reject anonymous) and rate-limited (reuse `server/rate-limit.ts` + the auth JWT cookie via `server/cookies.ts`). The faucet signs ONLY its own funding tx to a logged-in user's address — never a general signing oracle. Small fixed funding amount, per-user cap, graceful "faucet empty" state.
- **Env-gated with mock fallback.** Track B activates only when `QUICKNODE_ENDPOINT` (testnet4) AND `BTC_FAUCET_WALLET_ID` are present on the server, surfaced to the browser via `VITE_BTC_TESTNET=1`. Absent → the `inscribe()` step stays EXACTLY the current `OrdMockProvider` mock (`network: 'regtest'`), untouched.
- **Honesty rule:** the inscribe step's UI/badge copy must state exactly what is real (testnet4, user-signed, worthless tBTC) vs. mock. Track A copy (create/publish) is unchanged.
- **Live end-to-end is a MANUAL SMOKE, gated on provisioned env.** Every automated test in this plan runs offline against mocked Turnkey clients + mocked QuickNode/fetch. The real login→fund→inscribe→broadcast path is verified by a manual smoke once the operational prerequisites are provisioned (see below). Task 2 (the signing spike) de-risks the load-bearing Turnkey→finalize step BEFORE the faucet/provider/UI are built.

## Operational prerequisites (user-provided, NOT built by this plan)

- A QuickNode **testnet4** endpoint with the Ordinals & Runes add-on → `QUICKNODE_ENDPOINT`; set `BITCOIN_NETWORK=testnet`.
- A **testnet4 faucet as a Turnkey-org wallet** (P2WPKH), funded with a pool of small confirmed UTXOs. Its wallet id → `BTC_FAUCET_WALLET_ID`; its tb1q funding address → `BTC_FAUCET_ADDRESS`. Reached with the existing `TURNKEY_*` API creds — no raw key.
- The user wallet provisioning gains a testnet4 P2WPKH secp256k1 account (Task 3). Turnkey environment reachable from the deployed server (already true for auth).

---

## Resolved facts (read before coding)

Confirmed by reading `packages/sdk/src/lifecycle/LifecycleManager.ts`, `bitcoin/inscribe-on-sat.ts`, `bitcoin/transactions/commit.ts`, `bitcoin/transfer.ts`, `types/common.ts`, `types/network.ts`, `did/DIDManager.ts`, `did/createBtcoDidDocument.ts`, `did/BtcoDidResolver.ts`, `cel/btcoDid.ts`, `utils/bitcoin-address.ts`, `adapters/providers/QuickNodeProvider.ts`, `adapters/types.ts`, and the `apps/landing` auth stack.

**1. The SDK's Bitcoin transaction layer ALREADY supports testnet.** `bitcoin/transactions/commit.ts` and `bitcoin/transfer.ts` both define `type BitcoinNetwork = 'mainnet' | 'testnet' | 'regtest' | 'signet'` and map `'testnet'` → `btc.TEST_NETWORK` in `getScureNetwork`; they internally translate `testnet` → `signet` before calling `validateBitcoinAddress` (commit.ts lines ~193, ~377). `inscribe-on-sat.ts`'s `InscribeOnSatParams.network` is already `'mainnet' | 'testnet' | 'regtest' | 'signet'`. So NO change is needed in the tx-building/scure layer.

**2. The testnet gap is the config/DID-identity layer** — several exhaustive switches + literal unions that do NOT yet accept `'testnet'` and will throw or fail to typecheck:
- `types/common.ts` `OriginalsConfig.network` is the literal union `'mainnet' | 'regtest' | 'signet'`.
- `types/network.ts` `BitcoinNetworkName` is `'mainnet' | 'regtest' | 'signet'`.
- `cel/btcoDid.ts` `btcoDidPrefix(network)` — `default:` throws `Unsupported Bitcoin network`. Needs `'testnet'` → `'did:btco:test'`.
- `did/createBtcoDidDocument.ts` `getDidPrefix` — exhaustive over mainnet/regtest/signet. Needs `'testnet'` → `'did:btco:test'`.
- `did/DIDManager.ts` `getConfiguredBitcoinNetwork()` return type (line ~245), `migrateToDIDBTCO` local `network` type (line ~275) and its inline prefix map (line ~314: `network === 'regtest' ? 'did:btco:reg:' : 'did:btco:sig:'`). Needs `'testnet'` → `'did:btco:test:'`.
- `lifecycle/LifecycleManager.ts` `getConfiguredBitcoinNetwork()` return type (line ~3608).
- `utils/bitcoin-address.ts` `type BitcoinNetwork` + `getNetwork` (exhaustive). Needs `'testnet'` → `bitcoin.networks.testnet` (`tb1`).
- `bitcoin/BitcoinManager.ts` read-side prefix guard (lines ~421-426): `this.config.network === 'regtest' ? 'reg' : this.config.network === 'signet' ? 'sig' : null`. Needs a `'testnet'` → `'test'` arm so a testnet-configured SDK does not treat a `did:btco:test:N` as mainnet.

**3. `BtcoDidResolver` already resolves the `test` prefix.** `parseBtcoDid` regex is `/^did:btco(?::(reg|sig|test))?:([0-9]+)(?:\/(.+))?$/`; `getDidPrefix` maps `test`/`testnet` → `did:btco:test`. No resolver change.

**4. `inscribeOnBitcoin` contract (PR #414, merged).** `inscribeOnBitcoin(asset, opts?: number | InscribeOnBitcoinOptions)` where `InscribeOnBitcoinOptions = { feeRate?; fundingUtxo?: Utxo; satSigner?: BitcoinSigner; changeAddress?: string }`.
- `Utxo = { txid: string; vout: number; value: number; scriptPubKey?: string; address?: string; ... }`.
- `BitcoinSigner = { signAndFinalizeCommitPsbt(psbtBase64: string): Promise<string> }` — MUST return broadcast-ready **raw tx hex** (NOT a PSBT). A returned PSBT → `COMMIT_TX_INVALID`.
- Providing `fundingUtxo` WITHOUT both `satSigner` and `changeAddress` throws `INVALID_INPUT`. A missing fee with no oracle throws `FEE_RATE_REQUIRED`/`INVALID_INPUT`.
- Flow (`inscribe-on-sat.ts`): `provider.getFirstSatOfOutput(fundingUtxo)` derives the DID sat → build commit locally → `satSigner.signAndFinalizeCommitPsbt` → parse+invariant-check the signed commit (input[0]==fundingUtxo, output[0]==built commit output, ≤2 outputs) → build+self-sign the reveal with an ephemeral key → `provider.broadcastTransaction(commit)` then `(reveal)`. Provider is used ONLY for `getFirstSatOfOutput`, `estimateFee` (when no explicit feeRate), `broadcastTransaction`. A post-commit reveal failure throws `REVEAL_BROADCAST_FAILED` carrying `revealTxHex` for recovery.

**5. `QuickNodeProvider`.** `new QuickNodeProvider({ endpoint, expectedNetwork: 'testnet' })`. Real `getFirstSatOfOutput` (`ord_getOutput.sat_ranges[0][0]`), `estimateFee` (`estimatesmartfee`, sat/vB), `broadcastTransaction` (`sendrawtransaction`, returns 64-hex txid). `createInscription`/`transferInscription` REJECT by design. On first RPC it verifies `getblockchaininfo.chain === 'test'` (issue #350) — a mismatched endpoint fails loudly.

**6. Turnkey OTP → session (the currently-MISSING step).** The OTP flow today: `initOtp` → `verifyOtp` returns a `verificationToken` (JWT) bound to the browser P-256 pubkey generated by `generateP256KeyPair()` in `apps/landing/src/auth/api.ts`. `verifyEmailAuth` (`packages/auth/src/server/email-auth.ts`) ALREADY returns `verificationToken` + the bound `publicKey`, but `apps/landing/server/auth-routes.ts` verify-otp DROPS them and just mints its own JWT cookie. The missing activity is **OTP_LOGIN** (`turnkey.apiClient().otpLogin({ organizationId: subOrgId, verificationToken, publicKey, clientSignature, expirationSeconds })` → a `session` JWT), where `clientSignature` is a P-256 signature (scheme `CLIENT_SIGNATURE_SCHEME_API_P256`) over the login challenge made with the browser's P-256 private key. This installs the P-256 key as the session credential on the credential-less sub-org — signing is then silent within the session window (request a generous `expirationSeconds`, e.g. `900`).

**7. Browser signer.** After `otpLogin`, build an `ApiKeyStamper({ apiPublicKey: p256PubHex, apiPrivateKey: p256PrivHex })` (from `@turnkey/api-key-stamper`) wrapped in a `@turnkey/sdk-browser` client scoped to `subOrgId`; reuse the existing `@turnkey/crypto` keypair. (Canonical alternative: `sdk.indexedDbClient()` + `loginWithSession(session)`; noted, but ApiKeyStamper is primary — minimal refactor over the existing keypair.) To keep this plan's automated tests deterministic and to isolate the load-bearing unknown, the Bitcoin-signing surface the `TurnkeySatSigner` consumes is a narrow injectable interface `TurnkeyBitcoinClient = { signTransaction(params: { signWith: string; unsignedTransaction: string; type: 'TRANSACTION_TYPE_BITCOIN' }): Promise<{ signedTransaction: string }> }`; the concrete browser client is built in the auth layer and the live wiring is a manual smoke.

**8. Bitcoin signing (RECOMMENDED path).** `signAndFinalizeCommitPsbt(psbtBase64)` = base64→hex PSBT → Turnkey `signTransaction({ signWith, unsignedTransaction: <hex>, type: 'TRANSACTION_TYPE_BITCOIN' })` (Turnkey supports P2WPKH, SIGHASH_ALL; it owns sighash/DER/low-S) → Turnkey returns a **partially-signed, NOT finalized** PSBT → load into `@scure/btc-signer` `Transaction.fromPSBT()`, `.finalize()`, return `.hex`. (Fallback: `signRawPayload` secp256k1 + manual DER/low-S witness assembly — noted; `signTransaction` is primary.) Task 2 proves the finalize half in isolation.

**9. User testnet4 P2WPKH address.** The default wallet's secp256k1 account is `ADDRESS_FORMAT_ETHEREUM` (`turnkey-client.ts` `DEFAULT_WALLET_ACCOUNTS`), not a testnet P2WPKH. Add a dedicated account via `createWalletAccounts({ walletId, organizationId: subOrgId, accounts: [{ curve: 'CURVE_SECP256K1', pathFormat: 'PATH_FORMAT_BIP32', path: "m/84'/1'/0'/0/0", addressFormat: 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH' }] })` using the SESSION-stamped browser client (the sub-org is credential-less until `otpLogin` installs the P-256 key). The returned account `address` (tb1q…) IS the `signWith` for `signTransaction` AND the user's funding/change address. Cache it.

**10. Server plumbing already present (Plan 1).** `server/router.ts` (`json(data, status?, headers?)`, `route(req, routes)`, `type Handler = (req, url) => Response | Promise<Response>`), `server/rate-limit.ts` (`createRateLimiter({ limit, windowMs }).check(key) → { allowed, retryAfterMs }`), `server/cookies.ts` (`extractToken(req)`), `server/turnkey.ts` (`getTurnkey()`), `server/index.ts` (`buildRoutes(deps)` exact-match route map + `buildStubRoutes()`), `server/app.ts` (`buildFetch` routes `/api/host/*` to the host store and all other `/api/*` through `route(req, routes)`). `/api/btc/*` are exact paths, so they slot into the `buildRoutes` map — no wildcard needed. `verifyToken(token, { secret })` from `@originals/auth/server` reads the JWT `sub` (subOrgId).

---

## Task 1: SDK — first-class `network: 'testnet'` (testnet4) support

**Files:**
- Modify: `packages/sdk/src/types/network.ts` (`BitcoinNetworkName` union)
- Modify: `packages/sdk/src/types/common.ts` (`OriginalsConfig.network` union)
- Modify: `packages/sdk/src/cel/btcoDid.ts` (`btcoDidPrefix`)
- Modify: `packages/sdk/src/did/createBtcoDidDocument.ts` (`BitcoinNetwork` + `getDidPrefix`)
- Modify: `packages/sdk/src/did/DIDManager.ts` (`getConfiguredBitcoinNetwork` return type, `migrateToDIDBTCO` network type + prefix map)
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` (`getConfiguredBitcoinNetwork` return type, line ~3608)
- Modify: `packages/sdk/src/utils/bitcoin-address.ts` (`BitcoinNetwork` + `getNetwork`)
- Modify: `packages/sdk/src/bitcoin/BitcoinManager.ts` (read-side prefix guard, lines ~421-426)
- Test: `packages/sdk/tests/unit/testnet-support.test.ts`

**Interfaces:**
- Consumes: existing SDK internals.
- Produces: `network: 'testnet'` accepted end-to-end; `did:btco:test:<sat>` minted for a testnet-configured SDK; `tb1`/testnet addresses validated under `'testnet'`.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/tests/unit/testnet-support.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { btcoDidPrefix, btcoDidFromSatoshi } from '../../src/cel/btcoDid.js';
import { createBtcoDidDocument } from '../../src/did/createBtcoDidDocument.js';
import { validateBitcoinAddress, isValidBitcoinAddress } from '../../src/utils/bitcoin-address.js';

describe('SDK testnet (testnet4) support', () => {
  test('btcoDidPrefix maps testnet to did:btco:test', () => {
    expect(btcoDidPrefix('testnet')).toBe('did:btco:test');
    expect(btcoDidFromSatoshi('123456', 'testnet')).toBe('did:btco:test:123456');
  });

  test('createBtcoDidDocument mints a did:btco:test id on testnet', () => {
    const doc = createBtcoDidDocument('123456', 'testnet', {
      publicKey: '02'.padEnd(66, '0'),
      keyType: 'ES256K',
    });
    expect(doc.id).toBe('did:btco:test:123456');
  });

  test('validateBitcoinAddress accepts a testnet4 tb1 P2WPKH address under "testnet"', () => {
    // Canonical BIP-173 testnet P2WPKH vector (tb1 prefix; testnet4 shares it).
    const tb1 = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
    expect(isValidBitcoinAddress(tb1, 'testnet')).toBe(true);
    // A mainnet bc1 address must NOT validate as testnet.
    expect(isValidBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'testnet')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test tests/unit/testnet-support.test.ts`
Expected: FAIL — `btcoDidPrefix('testnet')` throws `Unsupported Bitcoin network`; `createBtcoDidDocument(..., 'testnet', ...)` is a type error / throws; `validateBitcoinAddress(tb1, 'testnet')` throws (`'testnet'` not a valid `BitcoinNetwork`).

- [ ] **Step 3: Widen the two type unions**

In `packages/sdk/src/types/network.ts`, replace:
```typescript
export type BitcoinNetworkName = 'mainnet' | 'regtest' | 'signet';
```
with:
```typescript
export type BitcoinNetworkName = 'mainnet' | 'testnet' | 'regtest' | 'signet';
```

In `packages/sdk/src/types/common.ts`, replace:
```typescript
export interface OriginalsConfig {
  network: 'mainnet' | 'regtest' | 'signet';
```
with:
```typescript
export interface OriginalsConfig {
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
```

- [ ] **Step 4: Add the `testnet` → `did:btco:test` prefix in the two DID-identity sites**

In `packages/sdk/src/cel/btcoDid.ts`, in `btcoDidPrefix`, add the case BEFORE `default:`:
```typescript
    case 'regtest':
      return 'did:btco:reg';
```
becomes:
```typescript
    case 'regtest':
      return 'did:btco:reg';
    case 'testnet':
      return 'did:btco:test';
```

In `packages/sdk/src/did/createBtcoDidDocument.ts`, replace:
```typescript
export type BitcoinNetwork = 'mainnet' | 'regtest' | 'signet';
```
with:
```typescript
export type BitcoinNetwork = 'mainnet' | 'testnet' | 'regtest' | 'signet';
```
and in `getDidPrefix`, add after the regtest arm:
```typescript
	if (network === 'regtest') return 'did:btco:reg';
```
becomes:
```typescript
	if (network === 'regtest') return 'did:btco:reg';
	if (network === 'testnet') return 'did:btco:test';
```

- [ ] **Step 5: Widen the two `getConfiguredBitcoinNetwork` return types + DIDManager prefix map**

In `packages/sdk/src/did/DIDManager.ts`, replace the `getConfiguredBitcoinNetwork` signature (line ~245):
```typescript
  private getConfiguredBitcoinNetwork(): 'mainnet' | 'regtest' | 'signet' | undefined {
```
with:
```typescript
  private getConfiguredBitcoinNetwork(): 'mainnet' | 'testnet' | 'regtest' | 'signet' | undefined {
```
Replace the `migrateToDIDBTCO` local network type (line ~275):
```typescript
    const network: 'mainnet' | 'regtest' | 'signet' = this.getConfiguredBitcoinNetwork() ?? 'mainnet';
```
with:
```typescript
    const network: 'mainnet' | 'testnet' | 'regtest' | 'signet' = this.getConfiguredBitcoinNetwork() ?? 'mainnet';
```
Replace the inline prefix map (line ~314):
```typescript
      const prefix = network === 'mainnet' ? 'did:btco:' : network === 'regtest' ? 'did:btco:reg:' : 'did:btco:sig:';
```
with:
```typescript
      const prefix =
        network === 'mainnet' ? 'did:btco:'
        : network === 'regtest' ? 'did:btco:reg:'
        : network === 'testnet' ? 'did:btco:test:'
        : 'did:btco:sig:';
```

In `packages/sdk/src/lifecycle/LifecycleManager.ts`, replace (line ~3608):
```typescript
  private getConfiguredBitcoinNetwork(): 'mainnet' | 'regtest' | 'signet' {
```
with:
```typescript
  private getConfiguredBitcoinNetwork(): 'mainnet' | 'testnet' | 'regtest' | 'signet' {
```

- [ ] **Step 6: Accept `testnet` in address validation**

In `packages/sdk/src/utils/bitcoin-address.ts`, replace:
```typescript
export type BitcoinNetwork = 'mainnet' | 'regtest' | 'signet';
```
with:
```typescript
export type BitcoinNetwork = 'mainnet' | 'testnet' | 'regtest' | 'signet';
```
and in `getNetwork`, add the testnet arm after `mainnet`:
```typescript
    case 'mainnet':
      return bitcoin.networks.bitcoin;
```
becomes:
```typescript
    case 'mainnet':
      return bitcoin.networks.bitcoin;
    case 'testnet':
      // testnet4 shares testnet3's bech32 params (tb1) — same as signet below.
      return bitcoin.networks.testnet;
```

- [ ] **Step 7: Fix the BitcoinManager read-side prefix guard**

In `packages/sdk/src/bitcoin/BitcoinManager.ts`, replace the prefix expression (lines ~423-425):
```typescript
      this.config.network === 'regtest' ? 'reg'
        : this.config.network === 'signet' ? 'sig'
          : null; // mainnet DIDs have no network prefix (did:btco:<sat>)
```
with:
```typescript
      this.config.network === 'regtest' ? 'reg'
        : this.config.network === 'signet' ? 'sig'
          : this.config.network === 'testnet' ? 'test'
            : null; // mainnet DIDs have no network prefix (did:btco:<sat>)
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd packages/sdk && bun test tests/unit/testnet-support.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 9: Guard against regressions across the SDK network switches**

Run: `cd packages/sdk && bun test tests/unit/bitcoin tests/unit/did tests/unit/cel`
Expected: PASS — existing regtest/signet/mainnet DID + address + inscription unit suites stay green (the change only ADDS a `testnet` arm to each switch; no existing arm moved).

- [ ] **Step 10: Rebuild the SDK so the landing app can import testnet support**

Run: `cd /Users/brian/Projects/onionoriginals/sdk && bun run build`
Expected: `packages/sdk/dist` recompiles with no TypeScript errors. This is REQUIRED before Tasks 2-8 (the landing app imports `packages/sdk/dist`).

- [ ] **Step 11: Commit**

```bash
git add packages/sdk/src/types/network.ts packages/sdk/src/types/common.ts packages/sdk/src/cel/btcoDid.ts packages/sdk/src/did/createBtcoDidDocument.ts packages/sdk/src/did/DIDManager.ts packages/sdk/src/lifecycle/LifecycleManager.ts packages/sdk/src/utils/bitcoin-address.ts packages/sdk/src/bitcoin/BitcoinManager.ts packages/sdk/tests/unit/testnet-support.test.ts
git commit -m "feat(sdk): first-class network:'testnet' (testnet4) support — did:btco:test + tb1 validation"
```

---

## Task 2: Signing spike — Turnkey `signTransaction` → `@scure/btc-signer` finalize

**This task de-risks the load-bearing unknown for the whole plan.** It proves that a partially-signed P2WPKH PSBT (the shape Turnkey `signTransaction` returns) can be finalized with `@scure/btc-signer` into a valid, broadcast-ready testnet4 transaction. The finalize helper it produces is reused verbatim by the `TurnkeySatSigner` (Task 6).

**Files:**
- Add dep: `apps/landing/package.json` (`@scure/btc-signer` as an explicit dependency)
- Create: `apps/landing/src/sdk/finalize-psbt.ts`
- Test: `apps/landing/src/sdk/finalize-psbt.spike.test.ts`

**Interfaces:**
- Consumes: `@scure/btc-signer`.
- Produces: `finalizeSignedPsbt(partiallySignedPsbtBase64: string): string` — loads a partially-signed PSBT, finalizes all inputs, returns broadcast-ready raw tx hex; throws `FinalizePsbtError` if any input is unsigned/unfinalizable.

- [ ] **Step 1: Add `@scure/btc-signer` as an explicit landing dependency**

`@scure/btc-signer` is resolvable transitively via `@originals/sdk`, but the browser bundle must import it directly, so pin it explicitly. In `apps/landing/package.json`, add to `dependencies` (keep alphabetical near the other `@` scopes):
```json
    "@scure/btc-signer": "^2.2.0",
```
Then run: `cd /Users/brian/Projects/onionoriginals/sdk && bun install`
Expected: lockfile updated; `apps/landing/node_modules/@scure/btc-signer` resolves.

- [ ] **Step 2: Write the failing spike test**

Create `apps/landing/src/sdk/finalize-psbt.spike.test.ts`. It stands in for Turnkey by building a P2WPKH-input PSBT and signing it locally with a known key (exactly the "partially-signed, not finalized" PSBT Turnkey `signTransaction` returns), then asserts `finalizeSignedPsbt` yields a parseable tx with a non-empty witness on the input:

```typescript
import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { finalizeSignedPsbt } from './finalize-psbt';

// A deterministic P2WPKH key on testnet (TEST_NETWORK params).
const priv = hex.decode('1111111111111111111111111111111111111111111111111111111111111111');
const pub = secp256k1.getPublicKey(priv, true);

// Build a partially-signed (NOT finalized) P2WPKH PSBT — the exact shape
// Turnkey signTransaction returns. We stand in for Turnkey by signing locally.
function turnkeyLikePartiallySignedPsbt(): string {
  const p2wpkh = btc.p2wpkh(pub, btc.TEST_NETWORK);
  const tx = new btc.Transaction();
  // A synthetic funding input (segwit → witnessUtxo carries amount + script).
  tx.addInput({
    txid: hex.decode('a'.repeat(64)),
    index: 0,
    witnessUtxo: { script: p2wpkh.script, amount: 20_000n },
  });
  tx.addOutputAddress(
    'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
    12_000n,
    btc.TEST_NETWORK
  );
  tx.sign(priv); // signs but does NOT finalize
  return base64.encode(tx.toPSBT());
}

describe('SPIKE: Turnkey signTransaction → scure finalize (P2WPKH testnet4)', () => {
  test('finalizeSignedPsbt turns a partially-signed P2WPKH PSBT into broadcast-ready hex with a witness', () => {
    const partiallySigned = turnkeyLikePartiallySignedPsbt();
    const rawHex = finalizeSignedPsbt(partiallySigned);

    // Broadcast-ready hex must parse as a raw (non-PSBT) transaction...
    const parsed = btc.Transaction.fromRaw(hex.decode(rawHex));
    expect(parsed.inputsLength).toBe(1);
    // ...and the single P2WPKH input must carry a finalized witness.
    const input = parsed.getInput(0);
    expect(input.finalScriptWitness).toBeDefined();
    expect((input.finalScriptWitness as Uint8Array[]).length).toBeGreaterThan(0);
  });

  test('finalizeSignedPsbt throws on an unsigned PSBT', () => {
    const p2wpkh = btc.p2wpkh(pub, btc.TEST_NETWORK);
    const tx = new btc.Transaction();
    tx.addInput({ txid: hex.decode('b'.repeat(64)), index: 0, witnessUtxo: { script: p2wpkh.script, amount: 20_000n } });
    tx.addOutputAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 12_000n, btc.TEST_NETWORK);
    const unsigned = base64.encode(tx.toPSBT());
    expect(() => finalizeSignedPsbt(unsigned)).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/landing && bun test src/sdk/finalize-psbt.spike.test.ts`
Expected: FAIL — `Cannot find module './finalize-psbt'`.

- [ ] **Step 4: Implement `apps/landing/src/sdk/finalize-psbt.ts`**

```typescript
/**
 * Finalize a partially-signed PSBT into broadcast-ready raw tx hex.
 *
 * This is the second half of the recommended Turnkey signing path: Turnkey
 * signTransaction({ type: 'TRANSACTION_TYPE_BITCOIN' }) returns a PSBT with
 * signatures attached but NOT finalized (it owns sighash/DER/low-S). @scure/
 * btc-signer assembles the final witness and serializes the network tx. The
 * SDK's inscribe-on-sat path expects raw hex from the BitcoinSigner, never a
 * PSBT, so finalization MUST happen here.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';

export class FinalizePsbtError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FinalizePsbtError';
  }
}

export function finalizeSignedPsbt(partiallySignedPsbtBase64: string): string {
  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(base64.decode(partiallySignedPsbtBase64), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
  } catch (e) {
    throw new FinalizePsbtError(
      `Could not parse the signed PSBT returned by the signer: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  }
  try {
    // Finalize EVERY input — an input still missing its signature (Turnkey did
    // not sign it) throws here, which is the correct fail-closed behavior: a
    // partially-finalized tx must never reach broadcast.
    tx.finalize();
  } catch (e) {
    throw new FinalizePsbtError(
      `Signed PSBT could not be finalized (an input is unsigned or non-standard): ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  }
  return hex.encode(tx.extract());
}
```

Note: `@scure/base` ships as a dependency of `@scure/btc-signer` (present in `node_modules/.bun/@scure+base`); if Vite/Bun cannot resolve the bare `@scure/base` import, add `"@scure/base": "^1.1.0"` to `apps/landing/package.json` dependencies and re-run `bun install`. `@noble/curves` is likewise a transitive dep of the SDK; the test imports `@noble/curves/secp256k1.js` — if unresolved, add `"@noble/curves": "^2.0.0"` to `apps/landing/package.json`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/landing && bun test src/sdk/finalize-psbt.spike.test.ts`
Expected: PASS — 2 tests pass. **This green run is the go/no-go gate: the finalize path works, so the rest of Track B can be built. The full live path (real Turnkey signTransaction + real QuickNode broadcast) remains a MANUAL SMOKE gated on provisioned env — see Task 8 Step N.**

- [ ] **Step 6: Commit**

```bash
git add apps/landing/package.json apps/landing/src/sdk/finalize-psbt.ts apps/landing/src/sdk/finalize-psbt.spike.test.ts
git commit -m "spike(landing): prove Turnkey-shaped PSBT → scure finalize → broadcast-ready P2WPKH hex"
```

---

## Task 3: Turnkey OTP_LOGIN session + browser signing client + testnet4 funding account

**Files:**
- Modify: `apps/landing/server/auth-routes.ts` (verify-otp surfaces `verificationToken` + bound `publicKey`)
- Create: `apps/landing/src/auth/turnkey-session.ts` (`otpLoginToSession`, `buildBrowserSigningClient`, `ensureBitcoinFundingAccount` — behind an injectable Turnkey interface)
- Modify: `apps/landing/src/auth/api.ts` (`completeOtp` returns `verificationToken` + `publicKey` + the browser P-256 keypair)
- Modify: `apps/landing/src/auth/useAuth.tsx` (run otpLogin, hold session + signing client + funding address; expose them)
- Test: `apps/landing/src/auth/turnkey-session.test.ts`
- Test: `apps/landing/server/tests/auth-verify-token.test.ts`

**Interfaces:**
- Produces:
  - Server verify-otp response gains `verificationToken: string` and `publicKey: string` (the P-256 pubkey the token is bound to). The httpOnly JWT cookie is UNCHANGED — the returned token is client-bound and safe to hand back.
  - `otpLoginToSession(deps: { turnkey: TurnkeySessionApi; subOrgId: string; verificationToken: string; p256PublicKey: string; p256PrivateKey: string; expirationSeconds?: number }): Promise<{ session: string }>` — computes the P-256 `clientSignature` over the login challenge and calls `otpLogin`.
  - `buildBrowserSigningClient(opts: { subOrgId: string; p256PublicKey: string; p256PrivateKey: string }): TurnkeyBitcoinClient` — an ApiKeyStamper-backed browser client exposing `signTransaction` + `createWalletAccounts` + `getWallets`, scoped to `subOrgId`.
  - `ensureBitcoinFundingAccount(client: TurnkeyBitcoinClient, subOrgId: string): Promise<string>` — adds (idempotently) the `m/84'/1'/0'/0/0` `ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH` account and returns its tb1q address.
  - `TurnkeyBitcoinClient` narrow interface (see Resolved fact #7) so `TurnkeySatSigner` (Task 6) and tests depend on it, not on the concrete browser SDK.
  - `useAuth()` context gains `bitcoin: { fundingAddress: string; signingClient: TurnkeyBitcoinClient } | null` (null until otpLogin + provisioning complete, or when Track B is disabled).

- [ ] **Step 1: Write the failing tests**

Create `apps/landing/src/auth/turnkey-session.test.ts` (drives the session helpers against a mock Turnkey API — no network):

```typescript
import { describe, test, expect } from 'bun:test';
import {
  otpLoginToSession,
  ensureBitcoinFundingAccount,
  type TurnkeyBitcoinClient,
  type TurnkeySessionApi,
} from './turnkey-session';

describe('turnkey-session helpers', () => {
  test('otpLoginToSession calls otpLogin with a client signature and returns the session', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const turnkey: TurnkeySessionApi = {
      async otpLogin(params) {
        calls.push(params);
        return { session: 'session-jwt-xyz' };
      },
    };
    const { session } = await otpLoginToSession({
      turnkey,
      subOrgId: 'sub-1',
      verificationToken: 'vtoken',
      // 32-byte P-256 private key + its compressed pubkey (hex). Any valid pair.
      p256PublicKey: '02'.padEnd(66, 'a'),
      p256PrivateKey: '1'.repeat(64),
    });
    expect(session).toBe('session-jwt-xyz');
    expect(calls[0].organizationId).toBe('sub-1');
    expect(calls[0].verificationToken).toBe('vtoken');
    expect(typeof calls[0].clientSignature).toBe('string');
    expect((calls[0].clientSignature as string).length).toBeGreaterThan(0);
  });

  test('ensureBitcoinFundingAccount adds a testnet P2WPKH account and returns its tb1 address (idempotent)', async () => {
    let existing: Array<{ address: string; path: string }> = [];
    const client: TurnkeyBitcoinClient = {
      async getWallets() {
        return { wallets: [{ walletId: 'w1', accounts: existing }] };
      },
      async createWalletAccounts(params) {
        const address = 'tb1qexampleuseraddr000000000000000000000000';
        existing = [{ address, path: (params.accounts[0] as { path: string }).path }];
        return { addresses: [address] };
      },
      async signTransaction() {
        throw new Error('not used here');
      },
    };
    const addr = await ensureBitcoinFundingAccount(client, 'sub-1');
    expect(addr.startsWith('tb1q')).toBe(true);
    // Second call must NOT create a duplicate account — returns the cached one.
    const addr2 = await ensureBitcoinFundingAccount(client, 'sub-1');
    expect(addr2).toBe(addr);
  });
});
```

Create `apps/landing/server/tests/auth-verify-token.test.ts` (verify-otp now surfaces the token; uses a fake Turnkey + sessions, mirroring the auth-routes convention):

```typescript
import { describe, test, expect } from 'bun:test';
import { createAuthRoutes } from '../auth-routes';

// Minimal fakes: enough of the surface createAuthRoutes touches.
function fakeDeps() {
  const session = {
    email: 'a@b.com',
    otpId: 'otp1',
    otpEncryptionTargetBundle: 'bundle',
    timestamp: Date.now(),
    verified: false,
  };
  const sessions = {
    get: () => session,
    set: () => {},
    delete: () => {},
    cleanup: () => {},
  };
  const turnkey = {
    apiClient: () => ({
      // verifyOtp is exercised via verifyEmailAuth internals; we stub the
      // higher-level path by making verifyEmailAuth resolve. Since auth-routes
      // calls verifyEmailAuth(sessionId, code, turnkey, sessions), provide the
      // sub-org + verificationToken it needs.
      verifyOtp: async () => ({ verificationToken: 'vtoken-123' }),
      getSubOrgIds: async () => ({ organizationIds: ['sub-1'] }),
      getWallets: async () => ({ wallets: [{ walletId: 'w1' }] }),
    }),
  } as unknown as Parameters<typeof createAuthRoutes>[0]['turnkey'];
  return { turnkey, sessions, jwtSecret: 'test-secret-at-least-32-chars-long!!' };
}

describe('verify-otp surfaces the client-bound verificationToken', () => {
  test('response body carries verificationToken + publicKey alongside subOrgId', async () => {
    const routes = createAuthRoutes(fakeDeps());
    const req = new Request('http://x/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', code: '123456', publicKey: '02'.padEnd(66, 'a') }),
    });
    const res = await routes.verifyOtp(req, new URL(req.url));
    // The httpOnly JWT cookie is still set; the body now also returns the token.
    expect(res.headers.get('set-cookie')).toBeTruthy();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.subOrgId).toBe('sub-1');
    expect(body.verificationToken).toBe('vtoken-123');
    expect(body.publicKey).toBe('02'.padEnd(66, 'a'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/landing && bun test src/auth/turnkey-session.test.ts server/tests/auth-verify-token.test.ts`
Expected: FAIL — `Cannot find module './turnkey-session'`; verify-otp body has no `verificationToken`/`publicKey` (dropped today).

- [ ] **Step 3: Surface the token in the server verify-otp handler**

In `apps/landing/server/auth-routes.ts`, replace the verify-otp success block:
```typescript
      const token = signToken(result.subOrgId, result.email, undefined, { secret: deps.jwtSecret });
      const cookie = serializeCookie(getAuthCookieConfig(token));
      return json(
        { verified: true, email: result.email, subOrgId: result.subOrgId },
        200,
        { 'Set-Cookie': cookie }
      );
```
with:
```typescript
      const token = signToken(result.subOrgId, result.email, undefined, { secret: deps.jwtSecret });
      const cookie = serializeCookie(getAuthCookieConfig(token));
      // Surface the Turnkey verificationToken + the P-256 pubkey it is bound to
      // so the browser can run OTP_LOGIN and install its own session credential
      // (Track B, testnet4 signing). The token is client-bound — useless without
      // the browser-held P-256 private key — so returning it is safe. The
      // httpOnly session JWT cookie is UNCHANGED.
      return json(
        {
          verified: true,
          email: result.email,
          subOrgId: result.subOrgId,
          verificationToken: result.verificationToken,
          publicKey: result.publicKey,
        },
        200,
        { 'Set-Cookie': cookie }
      );
```

- [ ] **Step 4: Implement the browser session helpers `apps/landing/src/auth/turnkey-session.ts`**

```typescript
/**
 * Turnkey session helpers for Track B (testnet4 signing).
 *
 * After OTP verify, the sub-org is credential-less: the parent Turnkey key
 * can't sign for it and there is no passkey. OTP_LOGIN installs the browser's
 * P-256 key as the session credential, after which the user's Bitcoin signing
 * (signTransaction) is silent within the session window. These helpers wrap
 * that flow behind narrow, injectable interfaces so the app code and tests
 * never depend on the concrete @turnkey/sdk-browser surface directly.
 */
import { ApiKeyStamper } from '@turnkey/api-key-stamper';
import { TurnkeyBrowserClient } from '@turnkey/sdk-browser';
import { secp256r1 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';

/** The single OTP_LOGIN activity the session bootstrap needs. */
export interface TurnkeySessionApi {
  otpLogin(params: {
    organizationId: string;
    verificationToken: string;
    publicKey: string;
    clientSignature: string;
    expirationSeconds?: string;
  }): Promise<{ session: string }>;
}

/** The Bitcoin-signing + account surface the rest of Track B consumes. */
export interface TurnkeyBitcoinClient {
  signTransaction(params: {
    signWith: string;
    unsignedTransaction: string;
    type: 'TRANSACTION_TYPE_BITCOIN';
  }): Promise<{ signedTransaction: string }>;
  createWalletAccounts(params: {
    walletId: string;
    organizationId: string;
    accounts: Array<{
      curve: 'CURVE_SECP256K1';
      pathFormat: 'PATH_FORMAT_BIP32';
      path: string;
      addressFormat: 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH';
    }>;
  }): Promise<{ addresses: string[] }>;
  getWallets(params: { organizationId: string }): Promise<{
    wallets: Array<{ walletId: string; accounts?: Array<{ address: string; path?: string }> }>;
  }>;
}

const TESTNET_P2WPKH_PATH = "m/84'/1'/0'/0/0";

/**
 * Run OTP_LOGIN: sign the login challenge (the verificationToken) with the
 * browser P-256 key and exchange it for a session credential. The exact
 * challenge Turnkey expects is the verificationToken bytes; we sign SHA-256 of
 * them with the API-P256 scheme (low-S DER), matching ApiKeyStamper.
 */
export async function otpLoginToSession(deps: {
  turnkey: TurnkeySessionApi;
  subOrgId: string;
  verificationToken: string;
  p256PublicKey: string;
  p256PrivateKey: string;
  expirationSeconds?: number;
}): Promise<{ session: string }> {
  const challenge = sha256(new TextEncoder().encode(deps.verificationToken));
  const sig = secp256r1.sign(challenge, hex.decode(deps.p256PrivateKey), { lowS: true });
  const clientSignature = hex.encode(sig.toDERRawBytes());
  const { session } = await deps.turnkey.otpLogin({
    organizationId: deps.subOrgId,
    verificationToken: deps.verificationToken,
    publicKey: deps.p256PublicKey,
    clientSignature,
    expirationSeconds: String(deps.expirationSeconds ?? 900),
  });
  return { session };
}

/**
 * Build the ApiKeyStamper-backed browser client scoped to the sub-org. The
 * stamper reuses the SAME P-256 keypair the OTP flow generated, so no new
 * credential is minted. Returns the narrow TurnkeyBitcoinClient surface.
 */
export function buildBrowserSigningClient(opts: {
  subOrgId: string;
  p256PublicKey: string;
  p256PrivateKey: string;
  apiBaseUrl?: string;
}): TurnkeyBitcoinClient {
  const stamper = new ApiKeyStamper({
    apiPublicKey: opts.p256PublicKey,
    apiPrivateKey: opts.p256PrivateKey,
  });
  const client = new TurnkeyBrowserClient({
    stamper,
    apiBaseUrl: opts.apiBaseUrl ?? 'https://api.turnkey.com',
    organizationId: opts.subOrgId,
  });
  // TurnkeyBrowserClient already exposes signTransaction / createWalletAccounts
  // / getWallets with these shapes; the cast pins the narrow surface we use.
  return client as unknown as TurnkeyBitcoinClient;
}

/**
 * Ensure the user's wallet has a testnet4 P2WPKH account and return its tb1
 * address. Idempotent: if the path already exists, the cached address wins —
 * re-creating would waste an activity and could error on a duplicate path.
 */
export async function ensureBitcoinFundingAccount(
  client: TurnkeyBitcoinClient,
  subOrgId: string
): Promise<string> {
  const { wallets } = await client.getWallets({ organizationId: subOrgId });
  const wallet = wallets[0];
  if (!wallet) throw new Error('No Turnkey wallet found for the sub-organization.');
  const existing = wallet.accounts?.find((a) => a.path === TESTNET_P2WPKH_PATH);
  if (existing?.address) return existing.address;
  const { addresses } = await client.createWalletAccounts({
    walletId: wallet.walletId,
    organizationId: subOrgId,
    accounts: [
      {
        curve: 'CURVE_SECP256K1',
        pathFormat: 'PATH_FORMAT_BIP32',
        path: TESTNET_P2WPKH_PATH,
        addressFormat: 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH',
      },
    ],
  });
  const address = addresses[0];
  if (!address || !address.startsWith('tb1')) {
    throw new Error(`Turnkey returned an unexpected funding address: ${String(address)}`);
  }
  return address;
}
```

Note: `@turnkey/api-key-stamper` and `@turnkey/sdk-browser` are present in `node_modules/.bun` (verified) but `@turnkey/api-key-stamper` may not be an explicit `apps/landing` dependency — add `"@turnkey/api-key-stamper": "^0.6.7"` and `"@turnkey/sdk-browser": "^6.1.1"` to `apps/landing/package.json` dependencies and re-run `bun install` if the imports fail to resolve. `@noble/curves/nist.js` exports `secp256r1` (P-256); if the subpath differs in the installed version, import from `@noble/curves/p256.js`. If `toDERRawBytes()` is unavailable on the installed `@noble/curves`, use `sig.toCompactRawBytes()` and set the otpLogin scheme accordingly — flag as a manual-smoke verification point.

- [ ] **Step 5: Thread the token + keypair through `apps/landing/src/auth/api.ts`**

Replace `completeOtp`:
```typescript
export async function completeOtp(
  sessionId: string,
  code: string
): Promise<{ verified: boolean; email: string; subOrgId: string }> {
  // Generate the P-256 keypair in the browser so the verification-token
  // private key never transits HTTP (2.0 token binding).
  const keyPair = generateP256KeyPair();
  const result = await verifyOtp(sessionId, code, undefined, { publicKey: keyPair.publicKey });
  return { verified: result.verified, email: result.email!, subOrgId: result.subOrgId! };
}
```
with:
```typescript
export interface CompleteOtpResult {
  verified: boolean;
  email: string;
  subOrgId: string;
  /** Turnkey verificationToken (bound to the P-256 pubkey below), for OTP_LOGIN. */
  verificationToken?: string;
  /** The browser P-256 keypair (hex). Private key NEVER leaves the browser. */
  p256PublicKey: string;
  p256PrivateKey: string;
}

export async function completeOtp(sessionId: string, code: string): Promise<CompleteOtpResult> {
  // Generate the P-256 keypair in the browser so the verification-token
  // private key never transits HTTP (2.0 token binding). Track B (testnet4
  // signing) reuses this exact keypair as the Turnkey session credential.
  const keyPair = generateP256KeyPair();
  const result = await verifyOtp(sessionId, code, undefined, { publicKey: keyPair.publicKey });
  return {
    verified: result.verified,
    email: result.email!,
    subOrgId: result.subOrgId!,
    verificationToken: (result as { verificationToken?: string }).verificationToken,
    p256PublicKey: keyPair.publicKey,
    p256PrivateKey: keyPair.privateKey,
  };
}
```

- [ ] **Step 6: Bootstrap the session + signing client + funding address in `useAuth.tsx`**

In `apps/landing/src/auth/useAuth.tsx`, extend the context and the `verify` flow. Add the imports at the top:
```typescript
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import * as api from './api';
import type { AuthUser } from './api';
import { createUserWebVHDid } from './webvh';
```
becomes:
```typescript
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import * as api from './api';
import type { AuthUser } from './api';
import { createUserWebVHDid } from './webvh';
import {
  otpLoginToSession,
  buildBrowserSigningClient,
  ensureBitcoinFundingAccount,
  type TurnkeyBitcoinClient,
} from './turnkey-session';

// Track B activates only when the deploy enables testnet4 signing.
const btcTestnetEnabled =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_BTC_TESTNET === '1';

export interface BitcoinSession {
  fundingAddress: string;
  signingClient: TurnkeyBitcoinClient;
}
```
Extend the context value type:
```typescript
interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  sessionId: string | null;
  startOtp: (email: string) => Promise<void>;
  verify: (code: string) => Promise<void>;
  createIdentity: () => Promise<string>;
  signOut: () => Promise<void>;
}
```
becomes:
```typescript
interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  sessionId: string | null;
  /** Track B: the user's testnet4 signing client + funding address (null until ready / when disabled). */
  bitcoin: BitcoinSession | null;
  startOtp: (email: string) => Promise<void>;
  verify: (code: string) => Promise<void>;
  createIdentity: () => Promise<string>;
  signOut: () => Promise<void>;
}
```
Add the state + extend `verify` + reset on signOut:
```typescript
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
```
becomes:
```typescript
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [bitcoin, setBitcoin] = useState<BitcoinSession | null>(null);
```
Replace `verify`:
```typescript
  const verify = useCallback(async (code: string) => {
    if (!sessionId) throw new Error('Start the OTP flow first');
    const result = await api.completeOtp(sessionId, code);
    setUser({ subOrgId: result.subOrgId, email: result.email });
    setSessionId(null);
  }, [sessionId]);
```
with:
```typescript
  const verify = useCallback(async (code: string) => {
    if (!sessionId) throw new Error('Start the OTP flow first');
    const result = await api.completeOtp(sessionId, code);
    setUser({ subOrgId: result.subOrgId, email: result.email });
    setSessionId(null);

    // Track B bootstrap: install the P-256 session credential (OTP_LOGIN), then
    // build the signing client + ensure the testnet4 funding account. Best-
    // effort: a failure here must NOT block login — the demo simply falls back
    // to the mock inscribe path. Only runs when the deploy enabled testnet4.
    if (!btcTestnetEnabled || !result.verificationToken) return;
    try {
      const signingClient = buildBrowserSigningClient({
        subOrgId: result.subOrgId,
        p256PublicKey: result.p256PublicKey,
        p256PrivateKey: result.p256PrivateKey,
      });
      await otpLoginToSession({
        turnkey: signingClient as unknown as Parameters<typeof otpLoginToSession>[0]['turnkey'],
        subOrgId: result.subOrgId,
        verificationToken: result.verificationToken,
        p256PublicKey: result.p256PublicKey,
        p256PrivateKey: result.p256PrivateKey,
      });
      const fundingAddress = await ensureBitcoinFundingAccount(signingClient, result.subOrgId);
      setBitcoin({ fundingAddress, signingClient });
    } catch (err) {
      // Non-fatal: log for the console-visible demo narrative; UI stays on mock.
      console.warn('[originals-demo] testnet4 session bootstrap failed; inscribe stays on mock', err);
      setBitcoin(null);
    }
  }, [sessionId]);
```
Replace `signOut`:
```typescript
  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);
```
with:
```typescript
  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
    setBitcoin(null);
  }, []);
```
And add `bitcoin` to the provider value:
```typescript
      value={{ user, isAuthenticated: !!user, isLoading, sessionId, startOtp, verify, createIdentity, signOut }}
```
becomes:
```typescript
      value={{ user, isAuthenticated: !!user, isLoading, sessionId, bitcoin, startOtp, verify, createIdentity, signOut }}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/landing && bun test src/auth/turnkey-session.test.ts server/tests/auth-verify-token.test.ts`
Expected: PASS — 3 tests pass (2 session helpers + 1 verify-otp token surface).

- [ ] **Step 8: Commit**

```bash
git add apps/landing/server/auth-routes.ts apps/landing/src/auth/turnkey-session.ts apps/landing/src/auth/api.ts apps/landing/src/auth/useAuth.tsx apps/landing/src/auth/turnkey-session.test.ts apps/landing/server/tests/auth-verify-token.test.ts apps/landing/package.json
git commit -m "feat(landing): Turnkey OTP_LOGIN session + browser signing client + testnet4 funding account"
```

---

## Task 4: Server `bitcoin.ts` — Turnkey-org faucet + QuickNode proxies

**Files:**
- Create: `apps/landing/server/bitcoin.ts`
- Modify: `apps/landing/server/index.ts` (mount `/api/btc/*` in `buildRoutes` when configured)
- Modify: `apps/landing/serve.ts` (pass the Bitcoin routes into the unified fetch)
- Test: `apps/landing/server/tests/bitcoin.test.ts`

**Interfaces:**
- Produces:
  - `createBitcoinRoutes(deps: { turnkey; jwtSecret; provider: OrdinalsProvider; faucet: { walletId: string; address: string }; faucetSats?: number; now?: () => number }): { funding: Handler; sat: Handler; fee: Handler; broadcast: Handler }`.
  - `POST /api/btc/funding` — authenticated. Builds a funding tx from the faucet's confirmed UTXOs (fetched via the provider) to the user's tb1q address (from the request body, validated as testnet), signs it with the **faucet Turnkey-org wallet** via `turnkey.apiClient().signTransaction`, broadcasts via `provider.broadcastTransaction`, returns `{ fundingUtxo: { txid, vout, value }, changeAddress }` (the user's own address). Per-user cap + rate-limit + "faucet empty" (507) states.
  - `POST /api/btc/sat` `{ txid, vout }` → `{ satoshi }` via `provider.getFirstSatOfOutput`.
  - `POST /api/btc/fee` `{ blocks? }` → `{ feeRate }` via `provider.estimateFee`.
  - `POST /api/btc/broadcast` `{ txHex }` → `{ txid }` via `provider.broadcastTransaction`.
  - `isBitcoinConfigured(): boolean` — `QUICKNODE_ENDPOINT` + `BTC_FAUCET_WALLET_ID` + `BTC_FAUCET_ADDRESS` present.
  - `createOrdinalsProviderFromEnv()` (re-exported convenience from the SDK) selects `QuickNodeProvider` from env for the server.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/server/tests/bitcoin.test.ts` (mock provider + mock Turnkey + a valid JWT cookie; the faucet build/sign is exercised with a mocked `signTransaction` returning a known raw hex, and broadcast is mocked):

```typescript
import { describe, test, expect } from 'bun:test';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../cookies';
import { createBitcoinRoutes } from '../bitcoin';

const JWT = 'test-secret-at-least-32-chars-long!!';

function authedReq(path: string, body: unknown) {
  const token = signToken('sub-1', 'a@b.com', undefined, { secret: JWT });
  const cookie = serializeCookie(getAuthCookieConfig(token));
  return new Request(`http://host${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

function fakeProvider() {
  return {
    async getFirstSatOfOutput() { return '5000000000'; },
    async estimateFee() { return 3; },
    async broadcastTransaction() { return 'f'.repeat(64); },
    // The faucet needs the faucet's spendable UTXOs; expose a small helper.
    async getSpendableUtxos() {
      return [{ txid: 'a'.repeat(64), vout: 0, value: 100_000, scriptPubKey: '0014' + '0'.repeat(40) }];
    },
  } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'];
}

function fakeTurnkey() {
  return {
    apiClient: () => ({
      // Faucet signing: returns broadcast-ready hex (already finalized server-side).
      signTransaction: async () => ({ activity: { result: { signTransactionResult: { signedTransaction: '0200000000' } } } }),
    }),
  } as unknown as Parameters<typeof createBitcoinRoutes>[0]['turnkey'];
}

const deps = () => ({
  turnkey: fakeTurnkey(),
  jwtSecret: JWT,
  provider: fakeProvider(),
  faucet: { walletId: 'w-faucet', address: 'tb1qfaucet00000000000000000000000000000000' },
  faucetSats: 20_000,
});

describe('bitcoin routes', () => {
  test('POST /api/btc/sat proxies getFirstSatOfOutput', async () => {
    const r = createBitcoinRoutes(deps());
    const req = authedReq('/api/btc/sat', { txid: 'a'.repeat(64), vout: 0 });
    const res = await r.sat(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect((await res.json()).satoshi).toBe('5000000000');
  });

  test('POST /api/btc/fee proxies estimateFee', async () => {
    const r = createBitcoinRoutes(deps());
    const req = authedReq('/api/btc/fee', { blocks: 1 });
    const res = await r.fee(req, new URL(req.url));
    expect((await res.json()).feeRate).toBe(3);
  });

  test('POST /api/btc/broadcast proxies broadcastTransaction', async () => {
    const r = createBitcoinRoutes(deps());
    const req = authedReq('/api/btc/broadcast', { txHex: '0200000000' });
    const res = await r.broadcast(req, new URL(req.url));
    expect((await res.json()).txid).toBe('f'.repeat(64));
  });

  test('anonymous request is rejected 401', async () => {
    const r = createBitcoinRoutes(deps());
    const req = new Request('http://host/api/btc/sat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txid: 'a'.repeat(64), vout: 0 }),
    });
    const res = await r.sat(req, new URL(req.url));
    expect(res.status).toBe(401);
  });

  test('POST /api/btc/funding returns the user\'s funded outpoint + change address', async () => {
    const r = createBitcoinRoutes(deps());
    const userAddr = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
    const req = authedReq('/api/btc/funding', { address: userAddr });
    const res = await r.funding(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fundingUtxo: { txid: string; vout: number; value: number }; changeAddress: string };
    expect(body.changeAddress).toBe(userAddr);
    expect(body.fundingUtxo.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(body.fundingUtxo.value).toBe(20_000);
  });

  test('funding rejects a non-testnet address 400', async () => {
    const r = createBitcoinRoutes(deps());
    const req = authedReq('/api/btc/funding', { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' });
    const res = await r.funding(req, new URL(req.url));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test server/tests/bitcoin.test.ts`
Expected: FAIL — `Cannot find module '../bitcoin'`.

- [ ] **Step 3: Implement `apps/landing/server/bitcoin.ts`**

```typescript
/**
 * Server Bitcoin routes: a Turnkey-org faucet + thin QuickNode proxies.
 *
 * NO raw private key on the server: the faucet is a Turnkey-org wallet, signed
 * with the SAME Turnkey API creds auth already uses. The user's inscription is
 * signed in the browser by the user's own Turnkey session key. Every route is
 * auth-gated (JWT cookie) + rate-limited. The faucet signs ONLY its own funding
 * tx to a logged-in user's testnet address — never a general signing oracle.
 */
import * as btc from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import type { Turnkey } from '@turnkey/sdk-server';
import { verifyToken } from '@originals/auth/server';
import type { OrdinalsProvider } from '@originals/sdk';
import { isValidBitcoinAddress } from '@originals/sdk';
import { json, type Handler } from './router';
import { extractToken } from './cookies';
import { createRateLimiter } from './rate-limit';

export function isBitcoinConfigured(): boolean {
  return (
    !!process.env.QUICKNODE_ENDPOINT &&
    !!process.env.BTC_FAUCET_WALLET_ID &&
    !!process.env.BTC_FAUCET_ADDRESS
  );
}

// Provider surface these routes use (a superset of OrdinalsProvider — the
// faucet also needs the faucet wallet's spendable UTXOs). Production wires a
// QuickNodeProvider whose getSpendableUtxos lists the faucet address's UTXOs.
export interface FaucetProvider extends OrdinalsProvider {
  getSpendableUtxos(address: string): Promise<
    Array<{ txid: string; vout: number; value: number; scriptPubKey: string }>
  >;
}

export function createBitcoinRoutes(deps: {
  turnkey: Turnkey;
  jwtSecret: string;
  provider: OrdinalsProvider | FaucetProvider;
  faucet: { walletId: string; address: string };
  faucetSats?: number;
  now?: () => number;
}): { funding: Handler; sat: Handler; fee: Handler; broadcast: Handler } {
  const faucetSats = deps.faucetSats ?? 20_000;
  const ipLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
  const userLimiter = createRateLimiter({ limit: 5, windowMs: 60 * 60_000 }); // 5 fundings / user / hour
  const provider = deps.provider as FaucetProvider;

  function clientIp(req: Request): string {
    return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  }

  /** Returns the authenticated subOrgId, or null (→ 401). */
  function authSub(req: Request): string | null {
    const token = extractToken(req);
    if (!token) return null;
    try {
      return verifyToken(token, { secret: deps.jwtSecret }).sub;
    } catch {
      return null;
    }
  }

  function rateLimited(req: Request): Response | null {
    const rl = ipLimiter.check(clientIp(req));
    if (!rl.allowed) {
      return json({ error: 'rate_limited' }, 429, {
        'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
      });
    }
    return null;
  }

  const sat: Handler = async (req) => {
    if (!authSub(req)) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req);
    if (limited) return limited;
    const { txid, vout } = (await req.json().catch(() => ({}))) as { txid?: string; vout?: number };
    if (typeof txid !== 'string' || typeof vout !== 'number') return json({ error: 'bad_request' }, 400);
    if (typeof provider.getFirstSatOfOutput !== 'function') return json({ error: 'sat_index_unsupported' }, 501);
    try {
      const satoshi = await provider.getFirstSatOfOutput({ txid, vout });
      return json({ satoshi });
    } catch (e) {
      return json({ error: 'sat_lookup_failed', message: (e as Error).message }, 502);
    }
  };

  const fee: Handler = async (req) => {
    if (!authSub(req)) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req);
    if (limited) return limited;
    const { blocks } = (await req.json().catch(() => ({}))) as { blocks?: number };
    try {
      const feeRate = await provider.estimateFee(typeof blocks === 'number' ? blocks : 1);
      return json({ feeRate });
    } catch (e) {
      return json({ error: 'fee_estimate_failed', message: (e as Error).message }, 502);
    }
  };

  const broadcast: Handler = async (req) => {
    if (!authSub(req)) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req);
    if (limited) return limited;
    const { txHex } = (await req.json().catch(() => ({}))) as { txHex?: string };
    if (typeof txHex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(txHex)) return json({ error: 'bad_tx_hex' }, 400);
    try {
      const txid = await provider.broadcastTransaction(txHex);
      return json({ txid });
    } catch (e) {
      return json({ error: 'broadcast_failed', message: (e as Error).message }, 502);
    }
  };

  const funding: Handler = async (req) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req);
    if (limited) return limited;
    const perUser = userLimiter.check(sub);
    if (!perUser.allowed) {
      return json({ error: 'faucet_user_cap', message: 'Per-user faucet limit reached; try again later.' }, 429, {
        'Retry-After': String(Math.ceil(perUser.retryAfterMs / 1000)),
      });
    }

    const { address } = (await req.json().catch(() => ({}))) as { address?: string };
    if (!address || !isValidBitcoinAddress(address, 'testnet')) {
      return json({ error: 'bad_address', message: 'A testnet4 P2WPKH (tb1) address is required.' }, 400);
    }

    // 1) Gather the faucet's spendable UTXOs; pick enough to cover fundingSats +
    //    a fixed 1 sat/vB fee floor. Empty faucet → 507.
    let faucetUtxos: Array<{ txid: string; vout: number; value: number; scriptPubKey: string }>;
    try {
      faucetUtxos = await provider.getSpendableUtxos(deps.faucet.address);
    } catch (e) {
      return json({ error: 'faucet_unavailable', message: (e as Error).message }, 502);
    }
    const totalAvail = faucetUtxos.reduce((n, u) => n + u.value, 0);
    if (faucetUtxos.length === 0 || totalAvail < faucetSats + 500) {
      return json({ error: 'faucet_empty', message: 'The testnet4 faucet is out of funds. Try again later.' }, 507);
    }

    // 2) Build the funding tx: faucet UTXOs in, fundingSats to the user, change
    //    back to the faucet. Fee = feeRate * estimated vsize (simple P2WPKH).
    let feeRate = 1;
    try { feeRate = Math.max(1, Math.ceil(await provider.estimateFee(1))); } catch { /* floor */ }
    const selected: typeof faucetUtxos = [];
    let inSats = 0;
    for (const u of faucetUtxos) {
      selected.push(u);
      inSats += u.value;
      if (inSats >= faucetSats + 200) break;
    }
    // vsize ~ 10.5 + 68*inputs + 31*2 outputs (P2WPKH), rounded up.
    const vsize = Math.ceil(10.5 + 68 * selected.length + 31 * 2);
    const fee = feeRate * vsize;
    const change = inSats - faucetSats - fee;
    if (change < 0) return json({ error: 'faucet_empty', message: 'Faucet UTXOs too small for the fee.' }, 507);

    const tx = new btc.Transaction();
    for (const u of selected) {
      tx.addInput({
        txid: hex.decode(u.txid),
        index: u.vout,
        witnessUtxo: { script: hex.decode(u.scriptPubKey), amount: BigInt(u.value) },
      });
    }
    tx.addOutputAddress(address, BigInt(faucetSats), btc.TEST_NETWORK);
    if (change > 330) tx.addOutputAddress(deps.faucet.address, BigInt(change), btc.TEST_NETWORK);

    // 3) Sign with the faucet Turnkey-org wallet (unsigned PSBT hex → Turnkey →
    //    broadcast-ready hex). NO raw key: Turnkey holds the faucet key.
    const unsignedHex = hex.encode(tx.toPSBT());
    let signedTxHex: string;
    try {
      const result = await deps.turnkey.apiClient().signTransaction({
        organizationId: process.env.TURNKEY_ORGANIZATION_ID!,
        signWith: deps.faucet.address,
        unsignedTransaction: unsignedHex,
        type: 'TRANSACTION_TYPE_BITCOIN',
      } as never);
      // Turnkey returns either broadcast-ready hex or a partially-signed PSBT.
      const signed =
        (result as { activity?: { result?: { signTransactionResult?: { signedTransaction?: string } } } })
          .activity?.result?.signTransactionResult?.signedTransaction;
      if (!signed) throw new Error('Turnkey signTransaction returned no signedTransaction');
      // If Turnkey returned a PSBT, finalize it; if already raw hex, pass through.
      signedTxHex = maybeFinalize(signed);
    } catch (e) {
      return json({ error: 'faucet_sign_failed', message: (e as Error).message }, 502);
    }

    // 4) Broadcast; the funded outpoint is vout 0 (the user output).
    let txid: string;
    try {
      txid = await provider.broadcastTransaction(signedTxHex);
    } catch (e) {
      return json({ error: 'faucet_broadcast_failed', message: (e as Error).message }, 502);
    }

    return json({
      fundingUtxo: { txid, vout: 0, value: faucetSats },
      changeAddress: address, // the user's own address is the inscription change/reveal dest
    });
  };

  return { funding, sat, fee, broadcast };
}

/** Pass raw tx hex through; finalize a PSBT (base64 or hex) into raw hex. */
function maybeFinalize(signed: string): string {
  // Raw tx hex parses as a Transaction and has inputs already witnessed.
  try {
    const asRaw = btc.Transaction.fromRaw(hex.decode(signed), { allowUnknownInputs: true, allowUnknownOutputs: true });
    return hex.encode(asRaw.extract());
  } catch { /* not raw hex — try PSBT below */ }
  const bytes = /^[0-9a-fA-F]+$/.test(signed) ? hex.decode(signed) : base64.decode(signed);
  const tx = btc.Transaction.fromPSBT(bytes, { allowUnknownInputs: true, allowUnknownOutputs: true });
  tx.finalize();
  return hex.encode(tx.extract());
}
```

Note: `getSpendableUtxos` is NOT on the base `OrdinalsProvider` interface — the production server wires a `QuickNodeProvider` subclass (or a thin wrapper) exposing it via `ord`/`scantxoutset`/an address-index RPC on the faucet address. That wrapper is a one-method extension built in `serve.ts` (Step 5); the route logic here depends only on the `FaucetProvider` shape. `signTransaction`'s exact result envelope may differ across `@turnkey/sdk-server` versions — `maybeFinalize` tolerates both raw-hex and PSBT returns, which is the manual-smoke verification point.

- [ ] **Step 4: Mount the routes in `server/index.ts` when configured**

In `apps/landing/server/index.ts`, extend `buildRoutes` to accept optional Bitcoin routes and mount them. Replace the `buildRoutes` signature + body:
```typescript
export function buildRoutes(deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
}): Record<string, Handler> {
  const auth = createAuthRoutes(deps);
  return {
    'GET /api/health': () => json({ status: 'ok' }),
    'POST /api/auth/send-otp': auth.sendOtp,
    'POST /api/auth/verify-otp': auth.verifyOtp,
    'GET /api/me': auth.me,
    'POST /api/auth/logout': auth.logout,
  };
}
```
with:
```typescript
import type { BitcoinRoutes } from './bitcoin';

export function buildRoutes(deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
  bitcoin?: BitcoinRoutes;
}): Record<string, Handler> {
  const auth = createAuthRoutes(deps);
  const routes: Record<string, Handler> = {
    'GET /api/health': () => json({ status: 'ok' }),
    'POST /api/auth/send-otp': auth.sendOtp,
    'POST /api/auth/verify-otp': auth.verifyOtp,
    'GET /api/me': auth.me,
    'POST /api/auth/logout': auth.logout,
  };
  if (deps.bitcoin) {
    routes['POST /api/btc/funding'] = deps.bitcoin.funding;
    routes['POST /api/btc/sat'] = deps.bitcoin.sat;
    routes['POST /api/btc/fee'] = deps.bitcoin.fee;
    routes['POST /api/btc/broadcast'] = deps.bitcoin.broadcast;
  }
  return routes;
}
```
Add the `BitcoinRoutes` type export at the top of `apps/landing/server/bitcoin.ts` (so `index.ts` can import it) — add after `createBitcoinRoutes`'s return-type usage:
```typescript
export type BitcoinRoutes = ReturnType<typeof createBitcoinRoutes>;
```

- [ ] **Step 5: Wire the Bitcoin routes into `serve.ts` (env-gated)**

In `apps/landing/serve.ts`, after the `routes` are built, construct the Bitcoin routes when configured. Replace the auth-config block:
```typescript
let routes;
if (jwtSecret && turnkeyConfigured) {
  routes = buildRoutes({
    turnkey: getTurnkey(),
    sessions: createInMemorySessionStorage(),
    jwtSecret,
  });
  console.log('[landing] auth configured — /api/auth/* live');
} else {
  console.warn(
    '[landing] auth unconfigured (JWT_SECRET/TURNKEY_* absent) — /api/auth/* returns 503; SPA + did:webvh hosting still work'
  );
  routes = buildStubRoutes();
}
```
with:
```typescript
let routes;
if (jwtSecret && turnkeyConfigured) {
  const turnkey = getTurnkey();
  let bitcoin: import('./server/bitcoin').BitcoinRoutes | undefined;
  if (isBitcoinConfigured()) {
    // QuickNodeProvider gives sat/fee/broadcast; a thin subclass adds the
    // faucet's spendable-UTXO lookup. No raw key — the faucet is a Turnkey wallet.
    const provider = createFaucetProviderFromEnv();
    bitcoin = createBitcoinRoutes({
      turnkey,
      jwtSecret,
      provider,
      faucet: { walletId: process.env.BTC_FAUCET_WALLET_ID!, address: process.env.BTC_FAUCET_ADDRESS! },
      faucetSats: Number(process.env.BTC_FAUCET_SATS ?? 20_000),
    });
    console.log('[landing] testnet4 inscription configured — /api/btc/* live');
  } else {
    console.warn('[landing] testnet4 inscription disabled (QUICKNODE_ENDPOINT/BTC_FAUCET_* absent) — inscribe stays mock');
  }
  routes = buildRoutes({
    turnkey,
    sessions: createInMemorySessionStorage(),
    jwtSecret,
    bitcoin,
  });
  console.log('[landing] auth configured — /api/auth/* live');
} else {
  console.warn(
    '[landing] auth unconfigured (JWT_SECRET/TURNKEY_* absent) — /api/auth/* returns 503; SPA + did:webvh hosting still work'
  );
  routes = buildStubRoutes();
}
```
Add the imports + the `createFaucetProviderFromEnv` helper at the top of `serve.ts`:
```typescript
import { QuickNodeProvider } from '@originals/sdk';
import { createBitcoinRoutes, isBitcoinConfigured, type FaucetProvider } from './server/bitcoin';

// QuickNodeProvider + a faucet UTXO lookup. getSpendableUtxos uses the Ordinals
// add-on's address index (ord_getAddressOutputs) or bitcoind scantxoutset. The
// exact RPC is a manual-smoke wiring point; the shape is fixed here.
function createFaucetProviderFromEnv(): FaucetProvider {
  const base = new QuickNodeProvider({
    endpoint: process.env.QUICKNODE_ENDPOINT!,
    expectedNetwork: 'testnet',
  });
  const provider = base as unknown as FaucetProvider;
  provider.getSpendableUtxos = async (address: string) => {
    // Placeholder wiring the deploy fills in against its QuickNode add-on:
    // return confirmed P2WPKH UTXOs for `address` as { txid, vout, value, scriptPubKey }.
    throw new Error(
      `getSpendableUtxos not wired for ${address}: implement against the QuickNode Ordinals add-on address index or bitcoind scantxoutset before enabling the faucet.`
    );
  };
  return provider;
}
```
Note: this leaves `getSpendableUtxos` as an explicit throw-until-wired — the faucet route fails loudly (`faucet_unavailable`, 502) until the deploy provides the address-index call, which is a genuine operational choice (QuickNode's UTXO listing depends on the add-on/plan). The automated tests inject a fake provider, so they are unaffected. This throw is intentional, not a placeholder-in-shipping-logic: it is the honest "not configured" state.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/landing && bun test server/tests/bitcoin.test.ts`
Expected: PASS — 6 tests pass.

- [ ] **Step 7: Confirm the server suite still passes**

Run: `cd apps/landing && bun test server/tests/app.test.ts server/tests/webvh-host.test.ts server/tests/bitcoin.test.ts server/tests/auth-verify-token.test.ts`
Expected: PASS — all server suites green.

- [ ] **Step 8: Commit**

```bash
git add apps/landing/server/bitcoin.ts apps/landing/server/index.ts apps/landing/serve.ts apps/landing/server/tests/bitcoin.test.ts
git commit -m "feat(landing): server bitcoin.ts — Turnkey-org faucet + QuickNode /api/btc/* proxies (env-gated)"
```

---

## Task 5: `HttpOrdinalsProvider` (browser SDK `OrdinalsProvider` over `/api/btc/*`)

**Files:**
- Create: `apps/landing/src/sdk/http-ordinals-provider.ts`
- Test: `apps/landing/src/sdk/http-ordinals-provider.test.ts`

**Interfaces:**
- Produces: `class HttpOrdinalsProvider implements OrdinalsProvider` where the ONLY implemented methods are `getFirstSatOfOutput` (`POST /api/btc/sat`), `estimateFee` (`POST /api/btc/fee`), `broadcastTransaction` (`POST /api/btc/broadcast`). Every other `OrdinalsProvider` method (`getInscriptionById`, `getInscriptionsBySatoshi`, `getTransactionStatus`, `createInscription`, `transferInscription`) REJECTS by design — the SDK's sat-selected inscribe path never calls them (verified in `inscribe-on-sat.ts`), and the commit/reveal are built + self-signed locally. `constructor(opts?: { baseUrl?: string; fetchImpl?: typeof fetch })`.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/sdk/http-ordinals-provider.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { HttpOrdinalsProvider } from './http-ordinals-provider';

function mockFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    const key = new URL(url, 'http://x').pathname;
    if (!(key in routes)) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('HttpOrdinalsProvider', () => {
  test('getFirstSatOfOutput hits /api/btc/sat and returns the sat', async () => {
    const { impl, calls } = mockFetch({ '/api/btc/sat': { satoshi: '5000000000' } });
    const p = new HttpOrdinalsProvider({ baseUrl: '', fetchImpl: impl });
    const sat = await p.getFirstSatOfOutput({ txid: 'a'.repeat(64), vout: 0 });
    expect(sat).toBe('5000000000');
    expect(calls[0].url).toBe('/api/btc/sat');
    expect(calls[0].body).toEqual({ txid: 'a'.repeat(64), vout: 0 });
  });

  test('estimateFee hits /api/btc/fee', async () => {
    const { impl } = mockFetch({ '/api/btc/fee': { feeRate: 4 } });
    const p = new HttpOrdinalsProvider({ baseUrl: '', fetchImpl: impl });
    expect(await p.estimateFee(1)).toBe(4);
  });

  test('broadcastTransaction hits /api/btc/broadcast and returns txid', async () => {
    const { impl, calls } = mockFetch({ '/api/btc/broadcast': { txid: 'f'.repeat(64) } });
    const p = new HttpOrdinalsProvider({ baseUrl: '', fetchImpl: impl });
    expect(await p.broadcastTransaction('0200000000')).toBe('f'.repeat(64));
    expect(calls[0].body).toEqual({ txHex: '0200000000' });
  });

  test('createInscription rejects by design (tx built locally)', async () => {
    const { impl } = mockFetch({});
    const p = new HttpOrdinalsProvider({ baseUrl: '', fetchImpl: impl });
    await expect(p.createInscription({ contentType: 'text/plain' })).rejects.toThrow();
  });

  test('broadcast surfaces a server error as a throw', async () => {
    const failing = (async () => new Response(JSON.stringify({ error: 'broadcast_failed' }), { status: 502 })) as unknown as typeof fetch;
    const p = new HttpOrdinalsProvider({ baseUrl: '', fetchImpl: failing });
    await expect(p.broadcastTransaction('0200000000')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test src/sdk/http-ordinals-provider.test.ts`
Expected: FAIL — `Cannot find module './http-ordinals-provider'`.

- [ ] **Step 3: Implement `apps/landing/src/sdk/http-ordinals-provider.ts`**

```typescript
/**
 * SDK OrdinalsProvider backed by this origin's /api/btc/* QuickNode proxies.
 *
 * The SDK's sat-selected inscribe path (inscribe-on-sat.ts) uses ONLY
 * getFirstSatOfOutput, estimateFee and broadcastTransaction; the commit/reveal
 * are built and self-signed locally (the reveal with an ephemeral key). Every
 * other OrdinalsProvider method therefore rejects by design — mirroring
 * QuickNodeProvider's "does not build/sign" contract — so a mislabeled read can
 * never silently fabricate on-chain data in the browser.
 */
import type { OrdinalsProvider } from '@originals/sdk';

export class HttpOrdinalsProvider implements OrdinalsProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts?: { baseUrl?: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts?.baseUrl ?? '';
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
      throw new Error(`HttpOrdinalsProvider ${path} failed: ${res.status} ${detail}`);
    }
    return (await res.json()) as T;
  }

  async getFirstSatOfOutput(outpoint: { txid: string; vout: number }): Promise<string> {
    const { satoshi } = await this.post<{ satoshi: string }>('/api/btc/sat', outpoint);
    return satoshi;
  }

  async estimateFee(blocks = 1): Promise<number> {
    const { feeRate } = await this.post<{ feeRate: number }>('/api/btc/fee', { blocks });
    return feeRate;
  }

  async broadcastTransaction(txHexOrObj: unknown): Promise<string> {
    if (typeof txHexOrObj !== 'string') {
      throw new Error('HttpOrdinalsProvider.broadcastTransaction requires raw tx hex');
    }
    const { txid } = await this.post<{ txid: string }>('/api/btc/broadcast', { txHex: txHexOrObj });
    return txid;
  }

  // --- Not implemented (the sat-selected inscribe path never calls these). ---
  getInscriptionById(): Promise<never> {
    return Promise.reject(new Error('HttpOrdinalsProvider.getInscriptionById is not implemented in the browser demo.'));
  }
  getInscriptionsBySatoshi(): Promise<never> {
    return Promise.reject(new Error('HttpOrdinalsProvider.getInscriptionsBySatoshi is not implemented in the browser demo.'));
  }
  getTransactionStatus(): Promise<never> {
    return Promise.reject(new Error('HttpOrdinalsProvider.getTransactionStatus is not implemented in the browser demo.'));
  }
  createInscription(): Promise<never> {
    return Promise.reject(new Error('HttpOrdinalsProvider.createInscription is not implemented: the commit/reveal are built and signed locally, then broadcast via broadcastTransaction.'));
  }
  transferInscription(): Promise<never> {
    return Promise.reject(new Error('HttpOrdinalsProvider.transferInscription is not implemented in the browser demo.'));
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/landing && bun test src/sdk/http-ordinals-provider.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/sdk/http-ordinals-provider.ts apps/landing/src/sdk/http-ordinals-provider.test.ts
git commit -m "feat(landing): HttpOrdinalsProvider over /api/btc/{sat,fee,broadcast}"
```

---

## Task 6: `TurnkeySatSigner` (browser SDK `BitcoinSigner`)

**Files:**
- Create: `apps/landing/src/sdk/turnkey-sat-signer.ts`
- Test: `apps/landing/src/sdk/turnkey-sat-signer.test.ts`

**Interfaces:**
- Produces: `class TurnkeySatSigner implements BitcoinSigner` — `signAndFinalizeCommitPsbt(psbtBase64: string): Promise<string>` = decode base64→hex → `client.signTransaction({ signWith, unsignedTransaction, type: 'TRANSACTION_TYPE_BITCOIN' })` → extract the signed PSBT/hex from the Turnkey result → `finalizeSignedPsbt` (Task 2) → broadcast-ready hex. `constructor(opts: { client: TurnkeyBitcoinClient; signWith: string })` where `signWith` is the user's tb1q funding address.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/sdk/turnkey-sat-signer.test.ts`. The mock Turnkey `signTransaction` stands in by signing the input PSBT locally with a known key (the "partially-signed" return), then asserts the signer produces finalized, broadcast-ready hex:

```typescript
import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { TurnkeySatSigner } from './turnkey-sat-signer';
import type { TurnkeyBitcoinClient } from '../auth/turnkey-session';

const priv = hex.decode('2222222222222222222222222222222222222222222222222222222222222222');
const pub = secp256k1.getPublicKey(priv, true);
const p2wpkh = btc.p2wpkh(pub, btc.TEST_NETWORK);

// Build the UNSIGNED commit PSBT the SDK would hand the signer (base64).
function unsignedCommitPsbtBase64(): string {
  const tx = new btc.Transaction();
  tx.addInput({ txid: hex.decode('c'.repeat(64)), index: 0, witnessUtxo: { script: p2wpkh.script, amount: 30_000n } });
  tx.addOutputAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 20_000n, btc.TEST_NETWORK);
  return base64.encode(tx.toPSBT());
}

// Mock Turnkey: signs the given unsigned PSBT (hex) locally and returns a
// partially-signed PSBT — exactly Turnkey signTransaction's shape.
const mockClient: TurnkeyBitcoinClient = {
  async signTransaction({ unsignedTransaction, type }) {
    expect(type).toBe('TRANSACTION_TYPE_BITCOIN');
    const tx = btc.Transaction.fromPSBT(hex.decode(unsignedTransaction), { allowUnknownInputs: true, allowUnknownOutputs: true });
    tx.sign(priv); // partially-signed, NOT finalized
    return { signedTransaction: hex.encode(tx.toPSBT()) };
  },
  async createWalletAccounts() { throw new Error('not used'); },
  async getWallets() { throw new Error('not used'); },
};

describe('TurnkeySatSigner', () => {
  test('signAndFinalizeCommitPsbt returns broadcast-ready hex with a witness', async () => {
    const signer = new TurnkeySatSigner({ client: mockClient, signWith: 'tb1quseraddr' });
    const rawHex = await signer.signAndFinalizeCommitPsbt(unsignedCommitPsbtBase64());
    const parsed = btc.Transaction.fromRaw(hex.decode(rawHex));
    expect(parsed.inputsLength).toBe(1);
    expect(parsed.getInput(0).finalScriptWitness).toBeDefined();
  });

  test('rejects when Turnkey returns nothing signable', async () => {
    const bad: TurnkeyBitcoinClient = {
      async signTransaction() { return { signedTransaction: '' }; },
      async createWalletAccounts() { throw new Error('x'); },
      async getWallets() { throw new Error('x'); },
    };
    const signer = new TurnkeySatSigner({ client: bad, signWith: 'tb1quseraddr' });
    await expect(signer.signAndFinalizeCommitPsbt(unsignedCommitPsbtBase64())).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test src/sdk/turnkey-sat-signer.test.ts`
Expected: FAIL — `Cannot find module './turnkey-sat-signer'`.

- [ ] **Step 3: Implement `apps/landing/src/sdk/turnkey-sat-signer.ts`**

```typescript
/**
 * SDK BitcoinSigner backed by the user's Turnkey session key.
 *
 * The SDK's inscribe-on-sat path builds the commit PSBT and hands it here as
 * base64; we convert to hex, sign the P2WPKH funding input via Turnkey
 * signTransaction (SIGHASH_ALL; Turnkey owns sighash/DER/low-S), then finalize
 * with @scure/btc-signer into broadcast-ready hex (the SDK rejects a returned
 * PSBT). Only the COMMIT is signed here — the reveal is self-signed by the SDK's
 * ephemeral key. Signing is silent within the Turnkey session window.
 */
import type { BitcoinSigner } from '@originals/sdk';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { finalizeSignedPsbt } from './finalize-psbt';
import type { TurnkeyBitcoinClient } from '../auth/turnkey-session';

export class TurnkeySatSigner implements BitcoinSigner {
  private readonly client: TurnkeyBitcoinClient;
  private readonly signWith: string;

  constructor(opts: { client: TurnkeyBitcoinClient; signWith: string }) {
    this.client = opts.client;
    this.signWith = opts.signWith;
  }

  async signAndFinalizeCommitPsbt(psbtBase64: string): Promise<string> {
    const unsignedHex = hex.encode(base64.decode(psbtBase64));
    const result = await this.client.signTransaction({
      signWith: this.signWith,
      unsignedTransaction: unsignedHex,
      type: 'TRANSACTION_TYPE_BITCOIN',
    });
    const signed = result?.signedTransaction;
    if (!signed) {
      throw new Error('TurnkeySatSigner: Turnkey signTransaction returned no signedTransaction.');
    }
    // Turnkey may return raw hex (already finalized) or a partially-signed PSBT.
    // Raw hex round-trips through Transaction.fromRaw; anything else is a PSBT
    // (hex or base64) that finalizeSignedPsbt assembles into broadcast-ready hex.
    try {
      const raw = btc.Transaction.fromRaw(hex.decode(signed), { allowUnknownInputs: true, allowUnknownOutputs: true });
      if (raw.getInput(0).finalScriptWitness) return hex.encode(raw.extract());
    } catch { /* not raw finalized hex — treat as PSBT below */ }
    const psbtBase64Out = /^[0-9a-fA-F]+$/.test(signed) ? base64.encode(hex.decode(signed)) : signed;
    return finalizeSignedPsbt(psbtBase64Out);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/landing && bun test src/sdk/turnkey-sat-signer.test.ts`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/sdk/turnkey-sat-signer.ts apps/landing/src/sdk/turnkey-sat-signer.test.ts
git commit -m "feat(landing): TurnkeySatSigner — user Turnkey key signs the commit, scure finalizes"
```

---

## Task 7: Engine wiring — testnet4 config, login-gated inscribe, real txid

**Files:**
- Modify: `apps/landing/src/sdk/engine.ts` (constructor provider/network selection; `inscribe()` sat-selected path; explorer helper; `DemoAssetState.inscription.explorerUrl`)
- Test: `apps/landing/src/sdk/engine.inscribe.test.ts`

**Interfaces:**
- Consumes: `HttpOrdinalsProvider` (Task 5), `TurnkeySatSigner` (Task 6), `TurnkeyBitcoinClient` (Task 3).
- Produces:
  - Module helper `btcTestnetEnabled(): boolean` (`import.meta.env.VITE_BTC_TESTNET === '1'`).
  - Constructor: when `btcTestnetEnabled()`, `network: 'testnet'` + `ordinalsProvider: new HttpOrdinalsProvider()`; else `network: 'regtest'` + `OrdMockProvider()` (unchanged mock path).
  - `DemoEngine.inscribe(opts?: { feeRate?; funding?: { fundingUtxo; changeAddress; signingClient: TurnkeyBitcoinClient } })`. With `funding` present → sat-selected real path: build a `TurnkeySatSigner`, call `inscribeOnBitcoin(asset, { fundingUtxo, satSigner, changeAddress, feeRate })`. Without → the legacy bare-feeRate mock path.
  - `DemoAssetState.inscription` gains `explorerUrl?: string` (`https://mempool.space/testnet4/tx/<txid>` when testnet, else undefined).
  - Module helper `btcoExplorerUrl(txid: string): string | undefined`.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/sdk/engine.inscribe.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { DemoEngine, btcoExplorerUrl } from './engine';

describe('engine inscribe wiring', () => {
  test('btcoExplorerUrl builds a testnet4 mempool link', () => {
    // Only meaningful when testnet is enabled; the helper is pure.
    const url = btcoExplorerUrl('f'.repeat(64));
    // In the default (mock) test env VITE_BTC_TESTNET is unset → undefined.
    expect(url === undefined || url === `https://mempool.space/testnet4/tx/${'f'.repeat(64)}`).toBe(true);
  });

  test('inscribe() without funding runs the mock path and still yields an inscription', async () => {
    const engine = new DemoEngine();
    await engine.create('T', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await engine.publish();
    const state = await engine.inscribe(); // mock path (no funding) — OrdMockProvider/regtest
    expect(state.layer).toBe('did:btco');
    expect(state.inscription?.txid).toBeTruthy();
  });

  test('inscribe() with funding but a broken signer surfaces the failure (real path is attempted)', async () => {
    const engine = new DemoEngine();
    await engine.create('T', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await engine.publish();
    const brokenClient = {
      async signTransaction() { throw new Error('turnkey down'); },
      async createWalletAccounts() { throw new Error('x'); },
      async getWallets() { throw new Error('x'); },
    };
    // With funding provided, the engine takes the sat-selected path; the broken
    // signer makes the SDK throw (COMMIT signing fails) — proving the real path
    // is wired, not the mock.
    await expect(
      engine.inscribe({
        funding: {
          fundingUtxo: { txid: 'a'.repeat(64), vout: 0, value: 20_000 },
          changeAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
          signingClient: brokenClient as never,
        },
      })
    ).rejects.toThrow();
  });
});
```

Note: the third test attempts the real sat-selected path. Because the default engine uses `OrdMockProvider` (testnet disabled in the test env), `inscribeOnBitcoin` will attempt `getFirstSatOfOutput` on the mock provider; if the mock lacks it, the SDK throws `SAT_INDEX_UNSUPPORTED` before the signer runs — still a throw, still proving the funding branch is taken (not the mock bare-feeRate branch). Either failure mode satisfies the assertion. If `OrdMockProvider` DOES implement `getFirstSatOfOutput`, the broken signer throws instead. The assertion tolerates both.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test src/sdk/engine.inscribe.test.ts`
Expected: FAIL — `btcoExplorerUrl` is not exported from `./engine`; `inscribe()` does not accept an options object with `funding`.

- [ ] **Step 3: Add the testnet toggle + provider/network selection in the constructor**

In `apps/landing/src/sdk/engine.ts`, extend the imports:
```typescript
import {
  OriginalsSDK,
  OrdMockProvider,
  type OriginalsAsset
} from '@originals/sdk';
import { HttpHostingStorageAdapter } from './http-hosting-adapter';
import { sha256 } from '@noble/hashes/sha2.js';
```
becomes:
```typescript
import {
  OriginalsSDK,
  OrdMockProvider,
  type OriginalsAsset
} from '@originals/sdk';
import { HttpHostingStorageAdapter } from './http-hosting-adapter';
import { HttpOrdinalsProvider } from './http-ordinals-provider';
import { TurnkeySatSigner } from './turnkey-sat-signer';
import type { TurnkeyBitcoinClient } from '../auth/turnkey-session';
import { sha256 } from '@noble/hashes/sha2.js';
```
Replace the `network`/`ordinalsProvider` lines in the `OriginalsSDK.create({ ... })` call:
```typescript
    this.sdk = OriginalsSDK.create({
      network: 'regtest',
      webvhNetwork: 'magby',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: new OrdMockProvider(),
```
with:
```typescript
    // Track B: when the deploy enables testnet4 signing, inscribe for real over
    // the /api/btc/* QuickNode proxies on Bitcoin testnet4; otherwise keep the
    // self-contained OrdMockProvider mock (regtest) unchanged.
    const testnet = btcTestnetEnabled();
    this.sdk = OriginalsSDK.create({
      network: testnet ? 'testnet' : 'regtest',
      webvhNetwork: 'magby',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: testnet ? new HttpOrdinalsProvider() : new OrdMockProvider(),
```

- [ ] **Step 4: Rewrite `inscribe()` to take the sat-selected real path when funded**

Replace the whole `inscribe` method:
```typescript
  /** Step 3 — inscribe on Bitcoin (OrdMockProvider; regtest semantics). */
  async inscribe(feeRate = 7): Promise<DemoAssetState> {
    if (!this.asset) throw new Error('Create an asset first');
    await this.sdk.lifecycle.inscribeOnBitcoin(this.asset, feeRate);
    const state = this.snapshot();
    if (state.inscription) {
      this.emit(
        'asset:inscribed',
        `Inscribed on satoshi ${state.inscription.satoshi} — tx ${state.inscription.txid}`,
        state.inscription
      );
    }
    return state;
  }
```
with:
```typescript
  /**
   * Step 3 — inscribe on Bitcoin.
   *
   * With `funding` (Track B, login-gated): a REAL testnet4 inscription. The
   * server-funded UTXO's first sat becomes the did:btco identity, the user's
   * Turnkey session key signs the commit, the reveal is self-signed by the SDK,
   * and both broadcast via the /api/btc/* QuickNode proxies. Without `funding`:
   * the self-contained OrdMockProvider mock (regtest).
   */
  async inscribe(opts?: {
    feeRate?: number;
    funding?: {
      fundingUtxo: { txid: string; vout: number; value: number; scriptPubKey?: string; address?: string };
      changeAddress: string;
      signingClient: TurnkeyBitcoinClient;
    };
  }): Promise<DemoAssetState> {
    if (!this.asset) throw new Error('Create an asset first');
    const feeRate = opts?.feeRate ?? 7;
    if (opts?.funding) {
      // Real sat-selected path (#369): the user's Turnkey key signs the commit.
      const satSigner = new TurnkeySatSigner({
        client: opts.funding.signingClient,
        signWith: opts.funding.changeAddress, // the user's tb1q funding address IS signWith
      });
      await this.sdk.lifecycle.inscribeOnBitcoin(this.asset, {
        fundingUtxo: opts.funding.fundingUtxo,
        satSigner,
        changeAddress: opts.funding.changeAddress,
        feeRate,
      });
    } else {
      // Mock path (unchanged): bare feeRate against OrdMockProvider.
      await this.sdk.lifecycle.inscribeOnBitcoin(this.asset, feeRate);
    }
    const state = this.snapshot();
    if (state.inscription) {
      this.emit(
        'asset:inscribed',
        `Inscribed on satoshi ${state.inscription.satoshi} — tx ${state.inscription.txid}`,
        state.inscription
      );
    }
    return state;
  }
```

- [ ] **Step 5: Surface the explorer URL on the inscription snapshot**

Extend the `DemoAssetState.inscription` shape:
```typescript
  inscription?: {
    txid: string;
    inscriptionId: string;
    satoshi: string;
    feeRate?: number;
  };
```
becomes:
```typescript
  inscription?: {
    txid: string;
    inscriptionId: string;
    satoshi: string;
    feeRate?: number;
    explorerUrl?: string;
  };
```
In `snapshot()`, extend the inscription object:
```typescript
      inscription:
        last && last.to === 'did:btco' && last.transactionId
          ? {
              txid: last.transactionId,
              inscriptionId: last.inscriptionId ?? '',
              satoshi: last.satoshi ?? '',
              feeRate: last.feeRate
            }
          : undefined,
```
becomes:
```typescript
      inscription:
        last && last.to === 'did:btco' && last.transactionId
          ? {
              txid: last.transactionId,
              inscriptionId: last.inscriptionId ?? '',
              satoshi: last.satoshi ?? '',
              feeRate: last.feeRate,
              explorerUrl: btcoExplorerUrl(last.transactionId)
            }
          : undefined,
```

- [ ] **Step 6: Add the `btcTestnetEnabled` + `btcoExplorerUrl` helpers**

At the bottom of `apps/landing/src/sdk/engine.ts` (next to `demoHost`), add:
```typescript
// Track B is enabled only when the deploy sets VITE_BTC_TESTNET=1 (server has
// QUICKNODE_ENDPOINT + a faucet Turnkey wallet). Absent → the inscribe step is
// the self-contained OrdMockProvider mock.
export function btcTestnetEnabled(): boolean {
  return (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_BTC_TESTNET === '1';
}

// The testnet4 block explorer link for a real inscription's reveal txid. Only
// produced when testnet is enabled — a mock/regtest txid has no public explorer.
export function btcoExplorerUrl(txid: string): string | undefined {
  if (!btcTestnetEnabled() || !txid) return undefined;
  return `https://mempool.space/testnet4/tx/${txid}`;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd apps/landing && bun test src/sdk/engine.inscribe.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 8: Confirm the Track A engine tests still pass (no regression)**

Run: `cd apps/landing && bun test src/sdk/engine.summary.test.ts src/sdk/engine.publish-resolve.test.ts`
Expected: PASS — Track A create/publish/resolve behavior unchanged (the constructor still defaults to the mock/regtest path when testnet is disabled, which is the test env).

- [ ] **Step 9: Commit**

```bash
git add apps/landing/src/sdk/engine.ts apps/landing/src/sdk/engine.inscribe.test.ts
git commit -m "feat(landing): engine testnet4 wiring — login-funded real inscription + explorer link"
```

---

## Task 8: Demo UI — login-gated inscribe + "your Turnkey key signs this" + explorer link

**Files:**
- Modify: `apps/landing/src/content.ts` (add a `demo.inscribeGate` copy block)
- Modify: `apps/landing/src/components/Demo.tsx` (login gate on inscribe; fetch funding; pass to `engine.inscribe`; explorer link; error/faucet states)
- Modify: `apps/landing/src/components/demo.css` (styles for the gate + explorer block)
- Test: `apps/landing/src/components/demo-inscribe-content.test.ts`

**Interfaces:**
- Consumes: `demo` from `../content`; `useAuth()` (`isAuthenticated`, `bitcoin`); `DemoAssetState.inscription.explorerUrl`; `btcTestnetEnabled` from `../sdk/engine`.
- Produces: no new exports; a login-gated inscribe control + real-tx explorer panel.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/components/demo-inscribe-content.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { demo } from '../content';

describe('demo inscribe-gate copy', () => {
  test('has an inscribeGate copy block', () => {
    expect(demo.inscribeGate).toBeDefined();
    expect(typeof demo.inscribeGate.signInPrompt).toBe('string');
    expect(demo.inscribeGate.signInPrompt.length).toBeGreaterThan(0);
    expect(typeof demo.inscribeGate.yourKeyNote).toBe('string');
    expect(typeof demo.inscribeGate.explorerLabel).toBe('string');
    expect(typeof demo.inscribeGate.faucetEmpty).toBe('string');
    expect(typeof demo.inscribeGate.mockNote).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test src/components/demo-inscribe-content.test.ts`
Expected: FAIL — `demo.inscribeGate` is `undefined`.

- [ ] **Step 3: Add the `inscribeGate` copy block to `apps/landing/src/content.ts`**

Inside the `demo` object, add after the `resolved: { … }` block (added in Plan 1):
```typescript
  resolved: {
    heading: 'did:webvh log — live at this origin',
    resolvedBadge: 'resolved ✓',
    pendingBadge: 'resolves in production',
    linkLabel: 'Open the signed DID log',
    note: 'The SDK’s real resolver fetched this over HTTP(S) — no mock. Open it: it’s the signed version history.'
  },
```
becomes:
```typescript
  resolved: {
    heading: 'did:webvh log — live at this origin',
    resolvedBadge: 'resolved ✓',
    pendingBadge: 'resolves in production',
    linkLabel: 'Open the signed DID log',
    note: 'The SDK’s real resolver fetched this over HTTP(S) — no mock. Open it: it’s the signed version history.'
  },
  inscribeGate: {
    signInPrompt: 'Sign in to inscribe on Bitcoin testnet4 — your own key signs it.',
    yourKeyNote: 'Your Turnkey key signs this inscription in your browser. The server never sees a private key; funding comes from a testnet4 faucet (worthless tBTC).',
    fundingLabel: 'Requesting testnet4 funding…',
    signingLabel: 'Signing the commit with your key…',
    explorerLabel: 'View the real transaction on mempool.space',
    faucetEmpty: 'The testnet4 faucet is temporarily out of funds — try again in a bit.',
    mockNote: 'Bitcoin inscription runs against a mock provider in this environment (no wallet, no chain). Deploy with a testnet4 endpoint + faucet to make it real.'
  },
```

- [ ] **Step 4: Gate + drive the inscribe step in `Demo.tsx`**

In `apps/landing/src/components/Demo.tsx`, add the auth + testnet imports near the top:
```typescript
import { useAuth } from '../auth/useAuth';
import { btcTestnetEnabled } from '../sdk/engine';
```
Inside the component, read auth + testnet state (near the other hooks, e.g. after `const [phase, setPhase] = useState<Phase>('idle');`):
```typescript
  const { isAuthenticated, bitcoin } = useAuth();
  const testnet = btcTestnetEnabled();
```
Replace the `inscribe` action:
```typescript
  const inscribe = () =>
    run('published', 'inscribing', 'inscribed', (engine) => engine.inscribe(7));
```
with:
```typescript
  const inscribe = () =>
    run('published', 'inscribing', 'inscribed', async (engine) => {
      // Mock path (testnet disabled): unchanged bare inscribe.
      if (!testnet) return engine.inscribe();
      // Real path: must be signed in with a provisioned testnet4 session.
      if (!isAuthenticated || !bitcoin) {
        throw new Error(demo.inscribeGate.signInPrompt);
      }
      // Ask the server faucet to fund the user's address, then inscribe with the
      // user's Turnkey key. faucet_empty (507) surfaces a friendly message.
      const res = await fetch('/api/btc/funding', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ address: bitcoin.fundingAddress }),
      });
      if (res.status === 507) throw new Error(demo.inscribeGate.faucetEmpty);
      if (!res.ok) throw new Error(`Funding failed (${res.status})`);
      const { fundingUtxo, changeAddress } = (await res.json()) as {
        fundingUtxo: { txid: string; vout: number; value: number };
        changeAddress: string;
      };
      return engine.inscribe({
        funding: { fundingUtxo, changeAddress, signingClient: bitcoin.signingClient },
      });
    });
```

- [ ] **Step 5: Render the gate note + real-tx explorer link**

In `Demo.tsx`, find the `{phase === 'inscribed' && asset && ( … )}` "done" block and extend it to show the explorer link when the inscription is real. Replace:
```tsx
                {phase === 'inscribed' && asset && (
                  <div className="demo-done">
                    <p>
                      <strong>{demo.done.lead}</strong> {demo.done.beforeSatoshi}{' '}
                      <code>{asset.inscription?.satoshi}</code> {demo.done.beforeTx}{' '}
                      <code>{asset.inscription?.txid}</code>. {demo.done.after}
                    </p>
                    <button type="button" className="demo-reset" onClick={reset}>
                      {demo.reset}
                    </button>
                  </div>
                )}
```
with:
```tsx
                {phase === 'inscribed' && asset && (
                  <div className="demo-done">
                    <p>
                      <strong>{demo.done.lead}</strong> {demo.done.beforeSatoshi}{' '}
                      <code>{asset.inscription?.satoshi}</code> {demo.done.beforeTx}{' '}
                      <code>{asset.inscription?.txid}</code>. {demo.done.after}
                    </p>
                    {asset.inscription?.explorerUrl && (
                      <a
                        className="demo-explorer-link"
                        href={asset.inscription.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {demo.inscribeGate.explorerLabel}
                      </a>
                    )}
                    <button type="button" className="demo-reset" onClick={reset}>
                      {demo.reset}
                    </button>
                  </div>
                )}
```
And immediately BEFORE the inscribe step's action button area (where the step list renders the third action), surface the honest gate note. Add, just after the `{error && …}` line (and before the `demo-resolved` block):
```tsx
                {phase === 'published' && (
                  <p className="demo-inscribe-note">
                    {testnet
                      ? isAuthenticated && bitcoin
                        ? demo.inscribeGate.yourKeyNote
                        : demo.inscribeGate.signInPrompt
                      : demo.inscribeGate.mockNote}
                  </p>
                )}
```

- [ ] **Step 6: Add styles to `apps/landing/src/components/demo.css`**

Append to the end of `apps/landing/src/components/demo.css`:
```css
.demo-inscribe-note {
  margin-top: 0.75rem;
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--text-tertiary, #888);
}
.demo-explorer-link {
  display: inline-block;
  margin-top: 0.5rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--btco, #f7931a);
  text-decoration: none;
}
.demo-explorer-link:hover {
  text-decoration: underline;
}
```

- [ ] **Step 7: Run the content test to verify it passes**

Run: `cd apps/landing && bun test src/components/demo-inscribe-content.test.ts`
Expected: PASS — 1 test passes.

- [ ] **Step 8: Full Track B + regression sweep**

Run: `cd apps/landing && bun test src/sdk/finalize-psbt.spike.test.ts src/auth/turnkey-session.test.ts src/sdk/http-ordinals-provider.test.ts src/sdk/turnkey-sat-signer.test.ts src/sdk/engine.inscribe.test.ts src/components/demo-inscribe-content.test.ts server/tests/bitcoin.test.ts server/tests/auth-verify-token.test.ts server/tests/app.test.ts server/tests/webvh-host.test.ts src/sdk/engine.summary.test.ts src/sdk/engine.publish-resolve.test.ts`
Expected: PASS — all Track A + Track B suites green.

- [ ] **Step 9: SDK regression sweep**

Run: `cd packages/sdk && bun test tests/unit/testnet-support.test.ts tests/unit/bitcoin tests/unit/did tests/unit/lifecycle`
Expected: PASS — testnet support plus existing Bitcoin/DID/lifecycle unit suites green.

- [ ] **Step 10: Manual smoke — MOCK path (no secrets)**

Build the SDK if not already done this session (`cd /Users/brian/Projects/onionoriginals/sdk && bun run build`). Then in one terminal: `cd apps/landing && bun run serve.ts` (logs "auth unconfigured" AND "testnet4 inscription disabled" — expected without secrets). In another: `cd apps/landing && bun run dev`. Open the demo, Create → Publish → Inscribe. Confirm: the inscribe step shows the honest `mockNote` copy, inscribes via OrdMockProvider, shows the done panel, and shows NO explorer link (mock txid has no explorer). No console errors.

- [ ] **Step 11: Manual smoke — REAL testnet4 path (GATED ON PROVISIONED ENV; user-run)**

This step is NOT part of the automated suite. With the operational prerequisites provisioned (`QUICKNODE_ENDPOINT` testnet4 + Ordinals add-on, `BTC_FAUCET_WALLET_ID` + `BTC_FAUCET_ADDRESS` funded Turnkey faucet, `TURNKEY_*`, `JWT_SECRET`, `VITE_BTC_TESTNET=1`, and `getSpendableUtxos` wired in `serve.ts`): boot `serve.ts` (logs "/api/btc/* live"), sign in via email OTP, then Create → Publish → Inscribe. Confirm: the funding request succeeds, the browser signs the commit with the user's Turnkey key (silent within the session), the commit+reveal broadcast, and the done panel shows a REAL testnet4 txid with a working `mempool.space/testnet4/tx/<txid>` link. Verify: (a) Turnkey `signTransaction`'s result envelope matches `maybeFinalize`/`TurnkeySatSigner` expectations; (b) `otpLogin`'s `clientSignature` scheme + `secp256r1` DER shape are accepted; (c) the commit spends the still-unconfirmed faucet funding UTXO without a confirmation wait. These three are the flagged load-bearing unknowns — reconcile any mismatch here.

- [ ] **Step 12: Commit**

```bash
git add apps/landing/src/content.ts apps/landing/src/components/Demo.tsx apps/landing/src/components/demo.css apps/landing/src/components/demo-inscribe-content.test.ts
git commit -m "feat(landing): login-gated testnet4 inscribe UI — your-key note + real-tx explorer link"
```

---

## Self-review notes (done before saving)

- **Spec coverage (Track B / Phase 2):**
  - SDK `network: 'testnet'` (testnet4) end-to-end incl. `did:btco:test` prefix + `tb1` validation, plus SDK rebuild → Task 1 (identified the FULL exhaustive-switch surface: `common.ts`, `network.ts`, `btcoDid.ts`, `createBtcoDidDocument.ts`, `DIDManager.ts`, `LifecycleManager.ts`, `bitcoin-address.ts`, `BitcoinManager.ts`; the tx layer already handles testnet).
  - Signing SPIKE (Turnkey-shaped PSBT → `@scure/btc-signer` finalize → broadcastable P2WPKH hex; live e2e flagged manual) → Task 2, first after the SDK task, as required.
  - Turnkey OTP_LOGIN session + browser signing client + testnet4 P2WPKH account provisioning; verify-otp surfaces `verificationToken` → Task 3.
  - Server `bitcoin.ts`: Turnkey-org faucet (no raw key; signs the faucet's own funding tx) + `POST /api/btc/{funding,sat,fee,broadcast}`; auth-gated + rate-limited + per-user cap + faucet-empty; env-gated with mock fallback → Task 4.
  - `HttpOrdinalsProvider` (browser `OrdinalsProvider`; create/transfer reject) → Task 5.
  - `TurnkeySatSigner` (`BitcoinSigner`; user Turnkey key signs commit, scure finalizes) → Task 6.
  - Engine wiring: `network:'testnet'` + `HttpOrdinalsProvider`, login-gated `inscribe()` requesting funding then calling `inscribeOnBitcoin` sat path; real txid + testnet4 explorer link → Task 7.
  - Login-gated inscribe UI + "your Turnkey key signs this" moment + explorer link + faucet/error states → Task 8.
  - Testing plan (server units with mock Turnkey/QuickNode + auth-gating; browser adapters/signer vs. mock fetch/Turnkey; engine wiring; SDK unit) → Tasks 1-8. Live e2e is an explicit MANUAL SMOKE (Task 8 Step 11).
- **Explicitly out of scope (Plan 1 / Track A, untouched here):** `HttpHostingStorageAdapter`, `webvh-host.ts`, the unified server foundation, `resolveDID` confirmation, did:peer→did:cel labels, create/publish copy. Track A `engine.create()`/`publish()` behavior is only regression-checked, never modified.
- **No raw private keys on the server:** the faucet signs via `turnkey.apiClient().signTransaction` with the existing `TURNKEY_*` creds (Task 4); the user's commit is signed in-browser by the user's Turnkey session key (Task 6). Restated in Global Constraints + the funding handler comment.
- **Fallback preserved:** with env absent, the engine constructor keeps `network:'regtest'` + `OrdMockProvider` and `inscribe()` takes the unchanged bare-feeRate path; `/api/btc/*` are simply not mounted (Task 4 Step 5, Task 7 Step 3).
- **Placeholder scan:** every implementation step contains complete code. The ONE intentional throw-until-wired (`getSpendableUtxos` in `serve.ts`, Task 4 Step 5) is an honest operational "not configured" state, is called out as such, is bypassed by injected fakes in tests, and fails loudly (`faucet_unavailable`) rather than fabricating data — it is not a shipping-logic placeholder. All test commands are exact (`cd apps/landing && bun test <path>` / `cd packages/sdk && bun test <path>`) with expected PASS/FAIL.
- **Type/name consistency:** `TurnkeyBitcoinClient` (`signTransaction`/`createWalletAccounts`/`getWallets`) is defined once (Task 3) and consumed identically by `TurnkeySatSigner` (Task 6), the engine (Task 7), and `useAuth` (Task 3). `finalizeSignedPsbt` (Task 2) is reused by `TurnkeySatSigner` (Task 6) and mirrored by the server's `maybeFinalize` (Task 4). `BitcoinRoutes` type flows `bitcoin.ts` → `index.ts` → `serve.ts`. `HttpOrdinalsProvider`/`HttpHostingStorageAdapter` share the `{ baseUrl?; fetchImpl? }` constructor convention. `btcTestnetEnabled`/`btcoExplorerUrl` are exported from `engine.ts` and consumed by `Demo.tsx`. The engine `inscribe({ funding })` option shape matches what `Demo.tsx` passes and what the SDK's `InscribeOnBitcoinOptions` requires (`fundingUtxo`/`satSigner`/`changeAddress`/`feeRate`). `verificationToken`/`publicKey` flow verify-otp (server) → `completeOtp` (api.ts) → `useAuth` → `otpLoginToSession`.
- **Risks flagged for the live smoke (Task 8 Step 11):** (1) Turnkey `signTransaction` result envelope (raw hex vs. partially-signed PSBT) — tolerated by `maybeFinalize`/`TurnkeySatSigner`, confirm live; (2) `otpLogin` `clientSignature` scheme + `@noble/curves` P-256 DER method (`toDERRawBytes`) — confirm live; (3) commit spending the unconfirmed faucet UTXO without a confirmation wait; (4) QuickNode Ordinals add-on `ord_*` availability on testnet4 + a `getSpendableUtxos` address-index source. All four are isolated so a mismatch is a localized fix, not a redesign.
```
