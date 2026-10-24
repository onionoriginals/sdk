# Originals anchoring: live acceptance (#975)

This runbook covers the parts of #975 that automated regtest cannot establish:
- live, client-authorized Turnkey signing through the landing, including
  cancellation, session expiry and retry;
- the owner's mainnet receipt.

It assumes plan 011 PR 10b. Nothing here runs without the owner's approval
for that stage. `bitcoinAnchoring` stays off in every shipped build: each
stage below runs a local landing built with it on.

Stage A's [24 October 2026 UTC live receipt and observations](originals-live-975-2026-10-24.md)
record real browser-authorized Turnkey signing on disposable regtest, including
the separately approved production organization, cancellation, natural expiry,
retry, reinscription, durable restart and a fresh SDK reader. Stage C remains
pending.

## What is already established, and by what

| Evidence | Where | What it proves | What it does not |
|---|---|---|---|
| SDK writer journeys | `scripts/regtest/originals-anchor.ts`, `originals-restart.ts` | the writer on Core 31.1 / ord 0.29.0: anchor, reinscribe, reorg, SIGKILL between commit and reveal, identical-pair resume, fresh reader | the landing; Turnkey |
| Landing journey | `scripts/regtest/landing-anchor.ts` (in `bun run regtest`) | `apps/landing/serve.ts` with anchoring on, and the landing's own engine over HTTP: deposit read, anchoring entry, checked submit, reinscription of the Original's own sat, the server SIGKILLed between commit and reveal and a fresh process resuming the identical reveal, the browser's retry answered from the record, a reorg, a fresh reader | Turnkey (local keys stand in, and the receipt says so); a real browser; mainnet |
| Unit and route tests | `apps/landing/server/tests/originals-*.test.ts`, `src/sdk/engine-anchoring.test.ts` | refusals: a foreign inscription on input 0, an inscribed fee input, a moved sat, a browser-named replacement, a forked copy, the switch off | anything on a real node |

## Stage A: regtest with a real Turnkey signer

**Authorization:**
- a Turnkey organization: parent API public and private keys, and the
  organization id; non-production is the default;
- the owner's inbox for the email OTP.

A production organization requires separate explicit owner approval, limited
to Turnkey activity with disposable regtest coins. On 23 October 2026 the
owner granted that approval for this Stage A run. This does not authorize
mainnet, testnet, signet or real Bitcoin spending. The receipt records whether
the organization was declared non-production or production use was approved.

**Budget:** no Bitcoin; regtest coins only. A few dozen Turnkey signing
activities (each anchoring step is one Ed25519 signature and one
`signTransaction`).

**Who:** the owner signs in and clicks. The harness runs the nodes and the
server and writes the receipt.

1. Pass the credentials through the shell only. Do not commit them or put
   them in chat:
   ```sh
   # Choose exactly one declaration:
   export LIVE_TURNKEY_NON_PRODUCTION_ORG=1   # for a non-production organization
   # For separately approved production use instead, unset the above and set:
   # export LIVE_TURNKEY_PRODUCTION_ORG_APPROVED=1
   export TURNKEY_API_PUBLIC_KEY=… TURNKEY_API_PRIVATE_KEY=… TURNKEY_ORGANIZATION_ID=…
   bun run regtest:install
   BITCOIND_BIN=… ORD_BIN=… bun scripts/regtest/landing-live.ts   # VITE_TURNKEY_SESSION_SECONDS=300 by default
   ```
   This builds the SPA with `VITE_BTC_NETWORK=regtest`,
   `VITE_ORIGINALS_BITCOIN_ANCHORING=1` and a five-minute session. It then
   starts `serve.ts` on <http://localhost:3000> with anchoring on.
2. In a normal browser profile, sign in by email OTP.
   - The session key is created in that browser's IndexedDB.
   - The landing provisions the authorship key (`#key-1`) and the regtest
     deposit address (`bcrt1q…`, the `m/84'/1'/0'/0/0` P2WPKH account).
   - Create your did:webvh when asked.
3. `fund <your bcrt1q address> 0.002` twice, then create an Original.
4. **Cancel.**
   1. Click *Add to Bitcoin*.
   2. Read *Before you sign*. Check that it lists the files and your DID's
      history as staying off chain.
   3. Press *Cancel* while it signs.
   4. Expect *Cancelled before anything was sent*.
   5. Run `mine`. In the receipt, no pair is recorded for it.
   6. `note` what you saw.
5. **Session expiry.**
   1. Wait until the session is past its five minutes, minus the 60 s margin.
   2. Click *Add to Bitcoin*.
   3. Expect the expired-session message, and nothing sent.
   4. Sign in again (re-auth), then retry.
   5. The anchoring entry committed during the cancelled attempt is not
      signed again. Only the commit is signed this time.
   6. Expect *Pending Bitcoin acceptance*.
6. `mine`.
   - Expect *Anchored on Bitcoin*, with 1 confirmation.
   - The holder is reported as your address, and as no right to change the
     Original.
   - Expect *Read from one index (ord@regtest-local); no second index was
     compared*.
7. **Reinscribe.**
   1. Revise the Original. Expect *1 version is not on Bitcoin yet*.
   2. Click *Inscribe the next version*, then run `mine`.
8. **Server killed between commit and reveal, then retry.**
   1. Revise again and run `hold-reveal`.
   2. Click *Inscribe the next version*. Wait for `live: reveal-held`.
   3. Run `kill`. The page reports a failed send and keeps the pair:
      *Send again* appears.
   4. Run `restart`. The fresh server resumes the identical reveal on boot.
   5. Click *Send again*. The server answers from its record; nothing is
      signed or paid twice.
   6. Run `mine`.
9. **Fresh reader.**
   1. Click *Download evidence*.
   2. In a **fresh browser profile**, or a new machine, with no landing state,
      keep only that ZIP.
   3. Run `verify <did:vh…> <path to zip>`. Expect:
      - history and author binding valid;
      - the anchor `anchored` at the last version;
      - the resource sha256 values;
      - one index;
      - ownership provisional.
10. Record the Turnkey activity ids for the signatures from the Turnkey
    dashboard (`note …`), then run `receipt`. Attach the receipt to #975.

The receipt states:
- which signer signed what;
- that every recorded commit input was signed by the key behind the
  account's bound deposit address (`signedByBoundAddressKey`);
- the Turnkey organization only as a SHA-256;
- the session length.

It does not contain credentials or keys.

## Stage B: signet

**Skipped**, by owner decision on 22 October 2026: QuickNode offers no signet
ord API with the extension the writer needs.

A later signet stage would need an ord signet node the owner runs, plus
`BTC_NETWORK=signet` support in the landing (not built).

## Stage C: the owner's mainnet receipt

**Authorization, all given by the owner at run time and not before:**
- mainnet spending, with the exact fee-rate ceiling and total cap;
- production Turnkey credentials;
- where the flag-on build runs (a local or staging landing; no public
  deployment turns anchoring on without a separate approval).

**Budget, an estimate for the owner to cap:**
- **Anchoring inscription.** It carries the log through the anchoring entry,
  about 4–6 KB for a one-version Original: about 1.3–1.8 kvB with the commit.
- **One reinscription.** About 0.6–0.9 kvB.
- **Fees.** About 2–2.7 kvB in total: roughly 10–14k sats at 5 sat/vB, or
  20–27k sats at 10 sat/vB.
- **Postage.** 546 sats rides on the sat's output and stays with the owner.
- **Suggested cap.** 50,000 sats at no more than 10 sat/vB.
- **QuickNode cold start.** The server's inscription clock walks the chain
  once on first start:
  - about 900,000 headers, in JSON-RPC batches of 1,000 (`getblockhash` and
    `getblockheader`);
  - it then persists them (`inscription-clock-mainnet.bin`).

  On a fresh data directory, expect on the order of 1.8 million QuickNode
  calls once. Approve that, or seed the data directory from a prior run.

**Steps:**
1. Build with `VITE_BTC_NETWORK=mainnet VITE_ORIGINALS_BITCOIN_ANCHORING=1`.
2. Run `serve.ts` with `ORIGINALS_BITCOIN_ANCHORING=1`, the production
   Turnkey credentials and `QUICKNODE_ENDPOINT`, on a private host.
   `config.ts` reports a deployed instance with anchoring on as an error. That
   is expected only if the owner approved it.
3. The owner funds their own bound `bc1q…` deposit address with at most the
   approved cap.
4. Repeat stage A steps 4–9 without the fault steps:
   - anchor;
   - wait one confirmation;
   - one reinscription;
   - a fresh reader from a fresh profile, with the sat read from QuickNode's
     ord and the evidence package.
5. Write the receipt. State the limits:
   - one index (PROVISIONAL);
   - QuickNode as the only provider;
   - ownership provisional;
   - the exact revisions, network and depth.

## Limits that stay visible until removed

- **One index.** Mainnet reads use one index, QuickNode's ord, PROVISIONAL
  (owner decision). Every status says `indexes.compared: false`. P9.10's
  SHOULD is not met.
- **The browser trusts the server for its reads.** The browser's prepare reads
  the sat, transaction states and inscription times through the landing
  server. The server's own checked submit, against its own reads, gates every
  broadcast.
- **Replication is not guaranteed.** The server keeps a copy of each anchored
  Original's evidence package, files included, and the privacy page says so.
  Bitcoin holds only the signed history.
- **4 MiB submit limit.** An Original whose evidence package is larger cannot
  be anchored through the landing (PROVISIONAL).
