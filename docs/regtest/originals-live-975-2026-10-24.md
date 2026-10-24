# #975 Stage A: live Turnkey on disposable regtest

Recorded 24 October 2026 UTC (23 October in America/Vancouver). The owner
explicitly authorized use of the existing production Turnkey organization for
this regtest run. No mainnet, testnet or signet activity or real Bitcoin
spending was authorized or performed. No public deployment was made.

## Revisions and artifacts

The successful run used clean SDK/landing commit
`b4e56bb159fd70232094d0cdaeb102a165ce2f09`. Package versions are SDK 4.0.0,
VH 0.1.0, auth 4.0.0 and landing 0.2.1. Protocol pins are those in
`specs/README.md` at that commit: Originals `1039c471c` plus the owner-approved
open proposal #50 at `555ce24d3`, including the VH-Log and DID pins in that
manifest.

The SPA was built locally with `VITE_BTC_NETWORK=regtest`,
`VITE_ORIGINALS_BITCOIN_ANCHORING=1` and
`VITE_TURNKEY_SESSION_SECONDS=300`. Its `dist/index.html` SHA-256 was
`b6f554229f7afd2c677451dbac91e61cf4176e6803ba75e882633b0489711916`.
The server used `apps/landing/serve.ts`, a durable per-Original recovery store,
Bitcoin Core 31.1 and ord 0.29.0. The shipped feature default remains off.

- [Live Turnkey receipt](receipts/originals-live-turnkey-975-2026-10-24.json),
  SHA-256 `cb01a20c20db066492d8f7dd1f2580b0b0b93ce8d1d91d9bb97b901b55ea62b4`.
- [Evidence ZIP](receipts/originals-live-turnkey-975-2026-10-24.zip),
  SHA-256 `129736c9c1e08b9944eb1832c3f1303a527fe022d530e5c74d5782638265ad9c`.
- [Separate automated landing journey receipt](receipts/originals-landing-975-2026-10-24.json),
  SHA-256 `5cc641f064771b8b7750681624a7d5c605bfdedbff8772de89ddd1b56cea38b2`.
  This supplies the reorg evidence at the same clean revision, using local
  stand-in keys; it does not claim live Turnkey or browser evidence.

## Live observations

The owner completed email OTP in the B3 shared browser. Subsequent actions
were driven in that browser through the actual landing UI, using its real
Turnkey session and IndexedDB outbox. Parent server credentials never signed
the user's entry or Bitcoin transaction. A browser fetch wrapper recorded only
signing response metadata, without altering requests or responses. Initial
identity/create signatures preceded that wrapper; later activity IDs are in
the receipt notes.

The final Original is
`did:vh:QmRBdNNBMkjWTtXDhGTMY3E5eWKY7nGaAfMHDYXKxehtTB`, anchored to
`did:btco:reg:5000000000`.

1. Created a did:webvh author identity through Turnkey. The initial OTP
   request was refused by Turnkey policy; the owner added scoped sign-in
   permissions and retried successfully.
2. Funded the bound `bcrt1…` address twice with 0.002 regtest BTC. These are
   disposable test coins.
3. Cancelled at the start of anchoring, then on the fixed build cancelled again immediately
   after the real authorship signature committed anchoring entry
   `2-QmUXGNhMT8q4irjvsu4FHkPa3e9fGsHbGRiQfXdX6LBsC8`. The normal Cancel
   button was clicked when the engine emitted `asset:anchoring`. Both attempts
   reported cancellation before send, with zero recorded pairs.
4. Let the five-minute session expire naturally, including its 60-second guard.
   The UI refused anchoring and offered re-authentication. No expiry timestamp
   or signing response was fabricated.
5. After a real OTP renewal, retried the retained entry. It kept the exact
   version ID, made no new authorship signature, and requested only
   `SIGN_TRANSACTION_V2` activity `01a16c08-ed46-71e2-9e02-177111e5b4bd`.
   The UI moved from Pending Bitcoin acceptance to Anchored on Bitcoin at one
   confirmation. It stated holder versus authorship authority and the single
   index boundary separately (P9.12, P9.18).
6. Revised and reinscribed on the same sat through real Turnkey signing, then
   confirmed that reveal in a new block. The revision's authorship signature
   also establishes that the cached author signer used the renewed session.
7. Revised again, held the reveal at the real Core RPC boundary, then SIGKILLed
   the server after its commit broadcast. A fresh server process reopened the
   same durable store and resumed the reveal on boot. The browser's Send again
   returned `outcome: recorded` for the identical pair; the IndexedDB outbox
   cleared. The pass-through signing count stayed at five before and after
   retry. The held, resumed and confirmed reveal ID was
   `3b6d60c061642d5c5f218a3aa04a231bc60e773ca0bde9e713ed512f921d356f`.
8. Exported the evidence ZIP and verified it with the harness's fresh SDK reader:
   empty store, no author list, only the ZIP and live Core/ord reads. History
   and author binding were valid, identity evidence complete, all six resource
   versions had verified bytes and SHA-256 values, and accepted head
   `4-QmTfH5NP9qQs2YUTUafCodBefqHdeW4udiKwpgsWbG1MYS` was anchored at one
   confirmation. All three recorded commits were signed by the bound deposit
   address key. The UI subsequently showed the final holder output and no
   pending version.

## Bug found and fixed

The first real re-authentication attempt found that an existing Original cached
its expired Turnkey client. The new browser session was active, but the old
author signer still received a Turnkey 401; nothing was broadcast. Commit
`b4e56bb1` resolves the current browser client for each authorship signature,
while keeping the author DID/key fixed (P5.3). A regression failed before the
fix, then passed. All 1,147 landing tests, landing typecheck and regtest
typecheck passed, along with the separate Core/ord landing journey.

## Remaining limits and release gates

- One local ord index only; no independent index comparison. Ownership is
  provisional. No QuickNode or public fee-market behavior was tested here.
- Fresh-reader evidence is from a fresh SDK store. A separate fresh browser
  profile was not exercised.
- Live cancellation, expiry, retry, reinscription and crash recovery are in the
  Turnkey receipt. Reorg evidence is in the separate local-key journey receipt.
- The author identity was served from the local landing's durable storage;
  this does not establish public-host availability.
- The owner's mainnet receipt remains pending. The production Turnkey approval
  for this regtest run does not authorize mainnet spending or deployment.

## Library recovery follow-up (PR 10c, 2026-10-24)

The refresh/reopen gap above is addressed separately in
[the library recovery report](originals-library-975-2026-10-24.md). That work
adds `/me`, account-scoped local persistence, authenticated durable discovery,
and verified consumer reopening. The exact Stage A ZIP above was imported
through the browser's recovery file input: all four entries, author binding,
identity evidence and resource bytes verified, including the recorded final
head. This was an offline-copy recovery check against a separate test chain,
not a fresh reading of the original Stage A chain or another live Turnkey run.

Separate disposable Core/ord evidence proves server-library reopening and
signer-free retry after a process kill. Browser checks use local keys and
fixture authentication, without production credentials. The original report's
live-signing and fresh-profile limits remain historical facts, and the
public-host/mainnet release gates remain pending.
