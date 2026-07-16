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
2. **Track B — real testnet4 inscription:** `inscribeOnBitcoin` builds+signs a real
   commit/reveal in-browser and broadcasts to Bitcoin **testnet4** via QuickNode,
   funded by a rate-limited server faucet wallet. Real txid + inscription, worthless
   tBTC.
3. **Honesty:** fix the did:peer→did:cel labels and make every step's UI badge state
   exactly what is real vs. simulated.

## Decisions (locked)

| Question | Decision | Why |
|---|---|---|
| Inscription network | **testnet4 via QuickNode** | QuickNode supports only mainnet + testnet4 (no signet). Mainnet is unsafe for a public demo. testnet4 is a real chain with worthless tBTC. |
| Funding model | **Server faucet wallet** | A public browser demo can't hold a spendable key. Server holds the faucet key + QuickNode key; browser proxies through same-origin routes. |
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

## Architecture

One Bun server (prod entry) serving a single origin:

```
                 ┌───────────────────────────── apps/landing (browser SPA) ─────────────────────────────┐
                 │  DemoEngine (src/sdk/engine.ts)                                                        │
                 │    ├── HttpHostingStorageAdapter ──PUT/GET /api/host/*, GET /.well-known,/<path>──┐    │
                 │    ├── HttpOrdinalsProvider ───────POST /api/btc/{sat,fee,broadcast}──────────┐   │    │
                 │    └── HttpSatSigner ──────────────POST /api/btc/sign-commit───────────────┐  │   │    │
                 └──────────────────────────────────────────────────────────────────────────│──│───│────┘
                                                                                             │  │   │
   ┌──────────────────────────── apps/landing/server (Bun, one origin) ──────────────────────▼──▼───▼────┐
   │  static SPA + SPA fallback   │  /api/auth/* (unchanged)                                              │
   │  webvh-host.ts:  PUT /api/host/*  ·  GET /.well-known/…  ·  GET /<path>/did.jsonl   (Map+TTL+caps)   │
   │  bitcoin.ts:     POST /api/btc/funding · sign-commit · sat · fee · broadcast   (faucet + QuickNode)  │
   │  rate-limit.ts / cookies.ts / router.ts  (reused)                                                    │
   └──────────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                          QUICKNODE_ENDPOINT ──────┘  (testnet4)          faucet wallet key (Railway secret)
```

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

5. **`HttpSatSigner`** — `src/sdk/http-sat-signer.ts` (browser). *Purpose:* SDK
   `BitcoinSigner`. *Interface:* `signAndFinalizeCommitPsbt(psbt) → hex` via
   `POST /api/btc/sign-commit`. *Deps:* fetch.

6. **`bitcoin.ts`** — server. *Purpose:* faucet + QuickNode proxy. *Interface:*
   `POST /api/btc/funding` (faucet UTXO + changeAddress), `sign-commit` (validate
   PSBT spends only the faucet UTXO → commit output, then sign+finalize with faucet
   key), `sat`/`fee`/`broadcast` (proxy to `QuickNodeProvider`). *Deps:*
   `QUICKNODE_ENDPOINT`, faucet key, `@scure/btc-signer`, rate-limit. Degrades to
   "unconfigured" (503 / mock) when env absent.

7. **`DemoEngine` changes** — `src/sdk/engine.ts`. Inject the three browser adapters;
   `network: 'testnet'`; explicit webvh `domain` = the demo origin; add a
   post-publish `resolveDID` confirmation; fix labels; surface inscription
   txid/inscription for an explorer link.

8. **UI/UX** — `src/components/Demo.tsx` + demo-adjacent strings in `content.ts`.
   Honest per-step badges; resolvable did:webvh link + "resolved ✓"; testnet4
   explorer link; timing + error states (faucet empty / rate-limited /
   reveal-broadcast recovery).

## Data flow

**Publish (Track A):** `publishToWeb` → `HttpHostingStorageAdapter.put*` → `PUT
/api/host/*` (server stores) → demo calls `resolveDID(webvhDid)` → real resolver
`GET`s the live log over HTTPS → UI shows link + "resolved ✓".

**Inscribe (Track B):** demo `POST /api/btc/funding` → `{ fundingUtxo, changeAddress }`
→ `inscribeOnBitcoin(asset, { fundingUtxo, satSigner: HttpSatSigner, changeAddress,
feeRate })` → SDK builds commit → `HttpSatSigner` → `POST /api/btc/sign-commit`
(faucet signs) → SDK computes commit txid + checks invariants → builds+signs reveal →
`HttpOrdinalsProvider.broadcastTransaction` → `POST /api/btc/broadcast` (QuickNode) →
UI shows testnet4 explorer link.

## Security

- QuickNode key + faucet key **server-side only**; never sent to the browser.
- All `/api/btc/*` and `/api/host/*` routes rate-limited per IP (reuse
  `rate-limit.ts`).
- `sign-commit` is not a generic signing oracle: it signs only a PSBT whose sole
  input is the issued faucet UTXO and whose output[0] is the commit output.
- Faucet: small funding UTXOs, per-IP inscription cap, "faucet empty" graceful state.
  Financial risk ≈ 0 (tBTC worthless); griefing risk mitigated by rate limits.
- WebVH host store: size cap + TTL + slug namespacing to prevent storage abuse and
  cross-DID collisions.

## Phasing

- **Phase 0 — foundation:** unify SPA + API into one Bun server; Railway
  `startCommand`; keep dev proxy working. Fix did:peer→did:cel labels.
- **Phase 1 — Track A (real webvh):** `HttpHostingStorageAdapter` + `webvh-host.ts` +
  engine wiring + `resolveDID` confirmation + UI. Self-contained, no secrets.
- **Phase 2 — Track B (real testnet4 inscription):** `bitcoin.ts` faucet/proxy +
  `HttpOrdinalsProvider` + `HttpSatSigner` + engine wiring + UI. Gated on env; falls
  back to `OrdMockProvider` when `QUICKNODE_ENDPOINT`/faucet unset.

## Operational prerequisites (user-provided)

- QuickNode **testnet4** endpoint with the Ordinals & Runes add-on → `QUICKNODE_ENDPOINT`.
- A funded **testnet4** faucet wallet; private key as a Railway secret; a small pool
  of confirmed UTXOs to hand out.

## Risks to verify during implementation

- SDK support for `network: 'testnet'` (testnet4) end-to-end, incl. the `did:btco`
  network prefix; may need a small tier addition. QuickNodeProvider accepts
  `BITCOIN_NETWORK=testnet`.
- Exact URL layout didwebvh-ts's resolver GETs, so the host store serves identical
  paths (`.well-known` vs. `/<path>/did.jsonl`).
- `Buffer` coverage for the browser commit/reveal path (existing
  `shims/buffer-global`).
- QuickNode Ordinals add-on availability on testnet4 specifically (docs list
  mainnet + testnet4 for base RPC; confirm `ord_*` methods on testnet4).

## Testing

- **Server units** (`server/tests/`): `webvh-host` store/serve + caps/TTL; `bitcoin`
  faucet issuance, `sign-commit` PSBT validation (rejects non-faucet inputs),
  proxy error mapping; rate-limit enforcement. Bun tests, no live network.
- **Browser adapters:** `HttpHostingStorageAdapter` / `HttpOrdinalsProvider` /
  `HttpSatSigner` against a mock fetch.
- **Engine integration:** publish → resolve round-trip against an in-process host;
  inscribe against a stubbed `/api/btc/*` mirroring the existing
  `inscribeOnBitcoin.satSelect.test.ts` convention.
- **Manual smoke:** real testnet4 inscription end-to-end once env is provisioned.

## Out of scope

- Broad `content.ts` did:peer→did:cel reconciliation (separate issue).
- Mainnet inscription; signet (unsupported by QuickNode).
- Persistent hosting of demo DIDs beyond the TTL window.
