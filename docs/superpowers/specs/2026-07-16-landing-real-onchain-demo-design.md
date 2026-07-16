# Landing demo: real on-chain did:webvh hosting + testnet4 inscription

**Issue:** #417 — "Landing demo: make it do real on-chain things (and fix did:peer / mock mislabeling)"
**Date:** 2026-07-16
**Status:** Approved design → implementation planning

## Problem

`apps/landing`'s "live demo" (`src/sdk/engine.ts`) runs the real `@originals/sdk`
in the browser, but only the crypto/protocol layer is genuinely real. Two steps
are mocked and the UI oversells them:

- `ordinalsProvider: new OrdMockProvider()` — "inscribed on Bitcoin" is a mock:
  no sat, no transaction, no chain.
- `storageAdapter: new MemoryStorageAdapter()` — "published to hosted storage" is
  in-memory: no real HTTPS host, nothing resolves.
- Mislabeling: `engine.ts:118` says "a private **did:peer** identity" (stale — it's
  did:cel now); `engine.ts:123` "published to hosted storage" implies real hosting.

## Goal

Make the demo do **real** on-chain work while staying public-safe:

1. **Track A — real did:webvh hosting:** `publishToWeb` uploads the signed DID log
   (+ CEL log + resources) to the demo's own origin over real HTTPS; the SDK's real
   resolver fetches it back and the UI proves it resolved. No funds.
2. **Track B — real testnet4 inscription (login-gated):** the logged-in user's own
   **Turnkey** key signs a real commit/reveal built in-browser, broadcast to Bitcoin
   **testnet4** via QuickNode. Funding comes from a **Turnkey-org faucet** (the server
   signs the faucet's own funding tx via its Turnkey creds — no raw key on the
   server). Real txid + inscription, worthless tBTC.
3. **Honesty:** fix the did:peer→did:cel labels and make every step's UI badge state
   exactly what is real vs. simulated.

## Decisions (locked)

| Question | Decision | Why |
|---|---|---|
| Inscription network | **testnet4 via QuickNode** | QuickNode supports only mainnet + testnet4 (no signet). Mainnet is unsafe for a public demo. testnet4 is a real chain with worthless tBTC. |
| Signing model | **User's Turnkey key signs the inscription** | Reuses the existing `@originals/auth` Turnkey OTP login + secp256k1 signer; the user's own key signs their own inscription (best self-custody narrative). Inscription becomes login-gated. |
| Funding model | **Turnkey-org faucet (zero raw keys)** | The faucet wallet is itself a Turnkey org key; the server signs only the faucet's *own* funding tx via its Turnkey creds. Both funding and user signing go through Turnkey → **no raw private key anywhere on the server**. |
| Fallback | **Raw-key faucet** (de-risk only) | If the Turnkey Bitcoin integration proves fiddly mid-build, drop the funding half to a raw testnet4 key without disturbing the user-signing story. |
| Unified server | **In scope (foundation)** | Real webvh hosting requires the DID log served from the demo's own origin. Matches this branch's purpose (`fix/landing-serve-unified-api`). |
| `content.ts` label reconciliation | **Out of scope** | Separately-tracked content issue. This work touches only demo-adjacent strings. |

## Constraints discovered

- **QuickNode:** mainnet + testnet4 only; no signet. Provides real
  `getFirstSatOfOutput` / `estimateFee` / `broadcastTransaction`; its
  `createInscription`/`transferInscription` fail by design (tx built locally).
- **`publishToWeb` needs no SDK change:** it routes all hosting (DID log, CEL log,
  resources) through `config.storageAdapter` (`put`/`putObject`). Injecting a real
  HTTP-backed adapter is sufficient.
- **`inscribeOnBitcoin` (merged PR #414)** signature:
  `inscribeOnBitcoin(asset, { fundingUtxo, satSigner, changeAddress, feeRate })`.
  - `fundingUtxo: Utxo` — its first sat becomes the did:btco identity (derived from
    the provider, never caller-asserted).
  - `satSigner: BitcoinSigner` — one method
    `signAndFinalizeCommitPsbt(psbtBase64) → broadcast-ready raw tx hex` (NOT a PSBT).
  - `changeAddress: string`.
  - Providing `fundingUtxo` without both `satSigner` and `changeAddress` throws
    `INVALID_INPUT`. Missing fee with no oracle throws `FEE_RATE_REQUIRED`.
  - Flow (`bitcoin/inscribe-on-sat.ts`): provider sat-lookup → build commit locally →
    `satSigner` signs → commit txid computed locally + invariant-checked → reveal
    built + self-signed locally with ephemeral key → broadcast commit, then reveal.
    `REVEAL_BROADCAST_FAILED` returns recovery data.
- **Browser feasibility:** the commit/reveal stack is `@scure/btc-signer` +
  `@noble/*` (browser-safe). Uses Node `Buffer` — must be polyfilled in Vite (the
  engine already imports `../shims/buffer-global`; confirm it covers this path).
- **Deployment now:** SPA (`serve.ts`, static) and API (`server/index.ts`, :8787) are
  separate; dev proxies `/api`. Prod Railway runs only the static server.
- **Turnkey signing already wired:** `@originals/auth` has `server/turnkey-signer.ts`
  and `client/turnkey-did-signer.ts`, both signing via Turnkey `signRawPayload`
  (secp256k1). OTP login provisions a per-user Turnkey sub-org + secp256k1 wallet
  (`server/turnkey-client.ts`), so a user Bitcoin signer needs no new primitive.
- **Turnkey has native Bitcoin signing:** `SIGN_TRANSACTION` covers P2PKH/P2SH/
  P2WPKH/P2WSH/P2TR with SIGHASH_ALL; `signRawPayload` handles pre-generated
  sighashes for anything exotic. Keeping funding addresses **P2WPKH** (ECDSA,
  SIGHASH_ALL) stays on the simplest native path — no schnorr for Turnkey-signed
  inputs. (Commit output + reveal are taproot but self-signed locally by the SDK's
  ephemeral reveal key, never by Turnkey.)
- **Current Turnkey user wallet has no Bitcoin account:** default accounts are
  ETHEREUM (secp256k1) + Solana (ed25519) (`turnkey-client.ts:59`). A testnet4
  P2WPKH account must be added to the user wallet provisioning (or derived from the
  existing secp256k1 pubkey).

## Architecture

One Bun server (prod entry) serving a single origin:

```
        ┌──────────────────────────── apps/landing (browser SPA) ────────────────────────────┐
        │  DemoEngine (src/sdk/engine.ts)                                                      │
        │    ├── HttpHostingStorageAdapter ──PUT/GET /api/host/*, GET /.well-known,/<path>─┐   │
        │    ├── HttpOrdinalsProvider ───────POST /api/btc/{sat,fee,broadcast}─────────┐   │   │
        │    └── TurnkeySatSigner ───signs commit sighash via USER's Turnkey session┐  │   │   │
        │           (existing client turnkey-did-signer / signRawPayload)           │  │   │   │
        └───────────────────────────────────────────────────────────────────────── │──│───│───┘
                                                          user Turnkey session ──────┘  │   │
   ┌──────────────────────────── apps/landing/server (Bun, one origin) ───────────────────▼───▼───┐
   │  static SPA + SPA fallback   │  /api/auth/* (unchanged)                                       │
   │  webvh-host.ts:  PUT /api/host/*  ·  GET /.well-known/…  ·  GET /<path>/did.jsonl (Map+TTL)   │
   │  bitcoin.ts:                                                                                  │
   │    POST /api/btc/funding  → build+sign faucet funding tx via TURNKEY-ORG creds, broadcast    │
   │                             (tops up the logged-in user's P2WPKH testnet4 address)           │
   │    POST /api/btc/{sat,fee,broadcast} → thin QuickNode proxy                                   │
   │  rate-limit.ts / cookies.ts / router.ts  (reused)                                            │
   └───────────────────────────────┬──────────────────────────────────┬───────────────────────────┘
              QUICKNODE_ENDPOINT ───┘ (testnet4)   Turnkey faucet org ──┘  (API creds, NOT a raw key)
```

**No raw private key anywhere on the server:** the faucet is a Turnkey org wallet;
the server authorizes its funding tx with the same Turnkey API credentials it already
uses for auth. The user's inscription is signed by the user's own Turnkey key.

### Units (each: purpose / interface / deps)

1. **Unified prod server** — `apps/landing/server/index.ts` (extended) + Railway
   `startCommand`. *Purpose:* one origin serving SPA + all API. *Interface:* Bun
   `fetch` → router; static + SPA fallback (moved from `serve.ts`). *Deps:* existing
   router/rate-limit/cookies; new `webvh-host.ts`, `bitcoin.ts`. `serve.ts` retired
   or reduced to a thin re-export.

2. **`HttpHostingStorageAdapter`** — `src/sdk/http-hosting-adapter.ts` (browser).
   *Purpose:* SDK `StorageAdapter` backed by HTTPS. *Interface:* `put(key, bytes,
   opts)` / `putObject(domain, path, bytes)` / `get(...)` → `PUT`/`GET /api/host/*`.
   *Deps:* fetch, same origin.

3. **`webvh-host.ts`** — server. *Purpose:* receive + serve DID/CEL/resource bytes at
   the exact URLs the resolver GETs. *Interface:* `PUT /api/host/*` (store),
   `GET /.well-known/…` + `GET /<path>/did.jsonl` (serve). *Deps:* in-memory Map,
   TTL, size cap, slug namespace; rate-limit.

4. **`HttpOrdinalsProvider`** — `src/sdk/http-ordinals-provider.ts` (browser).
   *Purpose:* SDK `OrdinalsProvider` via proxy. *Interface:* `getFirstSatOfOutput`,
   `estimateFee`, `broadcastTransaction` → `POST /api/btc/*`;
   `createInscription`/`transferInscription` throw. *Deps:* fetch.

5. **`TurnkeySatSigner`** — `src/sdk/turnkey-sat-signer.ts` (browser). *Purpose:* SDK
   `BitcoinSigner` backed by the **user's** Turnkey key. *Interface:*
   `signAndFinalizeCommitPsbt(psbt) → broadcast-ready hex` — computes the commit
   input's sighash, signs via the user's Turnkey session (reusing the
   `client/turnkey-did-signer` `signRawPayload` pattern, or Turnkey `SIGN_TRANSACTION`
   for the P2WPKH input), assembles the witness, returns finalized hex. *Deps:*
   Turnkey client + user session, `@scure/btc-signer`. Requires login.

6. **`bitcoin.ts`** — server. *Purpose:* Turnkey-org faucet + QuickNode proxy.
   *Interface:*
   - `POST /api/btc/funding` — authenticated (logged-in user). Builds a funding tx
     from the faucet's P2WPKH UTXOs to the user's testnet4 P2WPKH address, signs it
     with the **faucet Turnkey org** creds, broadcasts via QuickNode, returns the
     resulting `{ fundingUtxo, changeAddress }` (the user's own address) for the SDK
     call. Spendable immediately (commit may chain on the unconfirmed funding tx).
   - `POST /api/btc/{sat,fee,broadcast}` — thin proxies to `QuickNodeProvider`.
   *Deps:* `QUICKNODE_ENDPOINT`, faucet Turnkey org (via existing Turnkey client),
   `@scure/btc-signer`, rate-limit + auth middleware. Degrades to "unconfigured"
   (503) / `OrdMockProvider` when env absent.

7. **User Bitcoin account provisioning** — `@originals/auth` /
   `apps/landing/server`. *Purpose:* give each logged-in user a testnet4 P2WPKH
   address. *Interface:* add a `CURVE_SECP256K1` / testnet4-P2WPKH account to the
   user wallet (or derive from the existing secp256k1 pubkey) + expose the address to
   the browser. *Deps:* Turnkey `createWallet`/account APIs already used in
   `turnkey-client.ts`.

8. **`DemoEngine` changes** — `src/sdk/engine.ts`. Inject `HttpHostingStorageAdapter`
   + `HttpOrdinalsProvider` + (when logged in) `TurnkeySatSigner`; `network:
   'testnet'`; explicit webvh `domain` = the demo origin; post-publish `resolveDID`
   confirmation; fix labels; gate `inscribe()` on login + request funding first;
   surface the inscription txid/inscription for an explorer link.

9. **UI/UX** — `src/components/Demo.tsx` + demo-adjacent strings in `content.ts`.
   Honest per-step badges; resolvable did:webvh link + "resolved ✓"; a
   **sign-in-to-inscribe** gate + "your Turnkey key signs this" moment; testnet4
   explorer link; timing + error states (faucet empty / rate-limited /
   reveal-broadcast recovery).

## Data flow

**Publish (Track A):** `publishToWeb` → `HttpHostingStorageAdapter.put*` → `PUT
/api/host/*` (server stores) → demo calls `resolveDID(webvhDid)` → real resolver
`GET`s the live log over HTTPS → UI shows link + "resolved ✓".

**Inscribe (Track B, login-gated):** user is logged in → has a Turnkey testnet4
P2WPKH address → demo `POST /api/btc/funding` (server signs the faucet funding tx via
its Turnkey org creds, broadcasts, returns the user's now-funded `{ fundingUtxo,
changeAddress }`) → `inscribeOnBitcoin(asset, { fundingUtxo, satSigner:
TurnkeySatSigner, changeAddress, feeRate })` → SDK builds commit → `TurnkeySatSigner`
signs the commit input with the **user's** Turnkey key → SDK computes commit txid +
checks invariants → builds+signs reveal (ephemeral local key) →
`HttpOrdinalsProvider.broadcastTransaction` → `POST /api/btc/broadcast` (QuickNode) →
UI shows testnet4 explorer link. The commit may spend the still-unconfirmed funding
UTXO (unconfirmed chain), so there is no block-confirmation wait mid-demo.

## Security

- **No raw private keys on the server.** QuickNode key + the Turnkey API creds are
  server-side only. The faucet is a Turnkey org wallet; the user's inscription is
  signed by the user's own Turnkey key. The browser never sees any key.
- Faucet funding is **login-gated + rate-limited per user + per IP** (reuse
  `rate-limit.ts` + auth middleware); the server only ever signs the faucet's *own*
  funding tx to a *logged-in user's* address — it is not a general signing oracle.
- Faucet: small fixed funding amount, per-user inscription cap, "faucet empty"
  graceful state. Financial risk ≈ 0 (tBTC worthless); griefing risk (faucet drain)
  bounded by rate limits + small amounts.
- `/api/host/*` rate-limited; WebVH host store: size cap + TTL + slug namespacing to
  prevent storage abuse and cross-DID collisions.

## Phasing

- **Phase 0 — foundation:** unify SPA + API into one Bun server; Railway
  `startCommand`; keep dev proxy working. Fix did:peer→did:cel labels.
- **Phase 1 — Track A (real webvh):** `HttpHostingStorageAdapter` + `webvh-host.ts` +
  engine wiring + `resolveDID` confirmation + UI. Self-contained, no secrets.
- **Phase 2 — Track B (real testnet4 inscription):** user Bitcoin-account
  provisioning + `TurnkeySatSigner` + `bitcoin.ts` (Turnkey-org faucet + QuickNode
  proxy) + `HttpOrdinalsProvider` + engine wiring + login-gated UI. Gated on env;
  falls back to `OrdMockProvider` when `QUICKNODE_ENDPOINT`/faucet unset. If the
  Turnkey Bitcoin path proves fiddly, fall back to a raw-key faucet (funding half
  only) without changing user-signing.

## Operational prerequisites (user-provided)

- QuickNode **testnet4** endpoint with the Ordinals & Runes add-on → `QUICKNODE_ENDPOINT`.
- A **testnet4 faucet as a Turnkey org wallet** (P2WPKH), funded with a pool of small
  confirmed UTXOs; the server reaches it with the existing Turnkey API credentials —
  no raw key secret.
- The user wallet provisioning must include a **testnet4 P2WPKH secp256k1 account**.
- Turnkey environment reachable from the deployed server (already true for auth).

## Risks to verify during implementation

- SDK support for `network: 'testnet'` (testnet4) end-to-end, incl. the `did:btco`
  network prefix; may need a small tier addition. QuickNodeProvider accepts
  `BITCOIN_NETWORK=testnet`.
- **Turnkey commit-input signing shape:** whether Turnkey `SIGN_TRANSACTION`
  (P2WPKH, SIGHASH_ALL) or `signRawPayload`-of-sighash + local witness assembly is the
  cleaner path; low-S / DER encoding correctness. Prototype early — it is the
  load-bearing unknown for Phase 2.
- **User session signing UX:** whether the OTP-bound P-256 session can authorize the
  inscription signature without an extra Turnkey credential/passkey step.
- Deriving/adding a testnet4 P2WPKH account on the existing user Turnkey wallet.
- **Unconfirmed funding-input spend:** QuickNode/ord accepting a commit that spends
  the still-unconfirmed faucet funding UTXO; else a short confirmation wait.
- Exact URL layout didwebvh-ts's resolver GETs, so the host store serves identical
  paths (`.well-known` vs. `/<path>/did.jsonl`).
- `Buffer` coverage for the browser commit/reveal path (existing
  `shims/buffer-global`).
- QuickNode Ordinals add-on availability on testnet4 specifically (docs list
  mainnet + testnet4 for base RPC; confirm `ord_*` methods on testnet4).

## Testing

- **Server units** (`server/tests/`): `webvh-host` store/serve + caps/TTL; `bitcoin`
  faucet funding-tx build/sign (Turnkey mock), auth-gating (rejects anonymous),
  proxy error mapping; rate-limit enforcement. Bun tests, no live network.
- **Browser adapters:** `HttpHostingStorageAdapter` / `HttpOrdinalsProvider` against a
  mock fetch; `TurnkeySatSigner` against a mock Turnkey client — assert it returns
  finalized, low-S, broadcast-ready hex for a P2WPKH commit input.
- **Engine integration:** publish → resolve round-trip against an in-process host;
  inscribe against a stubbed `/api/btc/*` + mock Turnkey signer, mirroring the
  existing `inscribeOnBitcoin.satSelect.test.ts` convention.
- **Manual smoke:** real testnet4 inscription end-to-end (login → fund → inscribe)
  once env is provisioned.

## Out of scope

- Broad `content.ts` did:peer→did:cel reconciliation (separate issue).
- Mainnet inscription; signet (unsupported by QuickNode).
- Persistent hosting of demo DIDs beyond the TTL window.
