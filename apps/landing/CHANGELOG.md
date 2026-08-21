# @originals/landing

## 0.1.3-next.3

### Patch Changes

- 6590578: **Fix: authenticate the signing bootstrap with Turnkey's attested stamp.**

  Signing failed on every real-network sign-in with:

  ```
  Turnkey error 16: could not find public key in organization or its parent
  organization ... PUBLIC_KEY_NOT_FOUND
  ```

  thrown at the request stamp, not the body. The bootstrap called the `otp_login`
  activity stamped with the browser's session key — a credential Turnkey has
  never seen, because logging in is what installs it. The request could not
  authenticate by construction.

  Turnkey's own SDK does not use that activity here. For a credential-less
  sub-org it configures an _attested_ stamper from the verification token and
  calls `stamp_login`. The verification token is Turnkey's own signed artifact
  from verify-otp, so it authenticates a request from an org that holds no
  credential yet — which is precisely the moment this runs.

  The bootstrap now does the same: `X-Stamp-Attested` carrying the token, the
  bound public key, and a DER signature over the exact request body, exchanged at
  `/public/v1/submit/stamp_login`. Reproduced from `@turnkey/core` rather than
  depended on, since that package pulls ethers, viem and WalletConnect into a
  landing bundle.

- 2333f27: **Fix: a commit-only broadcast is no longer reported as an inscription.**

  On the first real mainnet inscription the site said "inscribed" and offered an
  explorer link to a reveal txid that returned 404.

  The server had answered `status: 'commit_broadcast'` — the commit was on the
  network, the reveal had not propagated, and the recovery sweep still owed the
  creator an inscription. The server distinguishes the two outcomes and the
  provider types them, but the SDK discards `submitInscription`'s return value,
  so nothing downstream could tell them apart and every 200 rendered as done.

  The provider now records what the submit achieved and the demo says it plainly:
  the commit is on the network, the reveal follows automatically once it
  confirms, nothing is stuck and nothing more is owed.

- 3b2c1db: Reframe the landing page for creators — the dependency-free slice of the 2026-08 punch list.

  The page's first screen was library marketing: an install command above the fold, "Run the live demo" as the primary CTA, and a nav that sent "Get started" clicks to npm instructions. The hero now speaks to the person the page is for — eyebrow "Anchored on Bitcoin · Yours even if we disappear", headline "Proof you made it. Carved into Bitcoin.", primary CTA "Make your first Original" (interim target `#demo` until the creator-app upload flow ships) — and the install command gives way to a quiet "See one that already exists" link to the First Light section. Nav follows: "Live demo" → "Try it", "Start" → `#demo`.

  The Developers section keeps its headline, subhead, bullets and install command, but the 60-line inline quickstart and events snippet are replaced by one line and a link to the GitHub README, taking the hand-rolled syntax highlighter with them. A new content test pins the CTA targets and the no-inline-quickstart rule.

  Copy that would claim more than the product does today — deleting the inscribe step's "coming soon", creator-pays cost rows, First Light's did:btco completion — is deliberately left for the Bitcoin build plan and creator-app v1.

- 67bc822: **Tell creators when their deposit is underpriced — and typecheck the server.**

  A deposit paying below the going rate sits in the mempool with nothing on
  screen to say why. Working that out meant opening a block explorer.

  The deposit screen now shows the pending payment's fee rate against what the
  network is clearing, and what to do about it. It is deliberately **not** a
  button: replace-by-fee re-signs the original inputs, and those belong to
  whatever wallet the creator paid from — not their Turnkey wallet — so the app
  cannot replace that transaction. Only the sending wallet can. Offering an
  action we cannot perform is the same defect as telling someone to sign in again
  when signing in is what failed.

  Where it can help is the arithmetic. BIP-125 requires a replacement to pay for
  its own bandwidth on top of the original fee, so the floor is
  `originalFee + vsize` — roughly triple a 1 sat/vB fee — and a small nudge is
  rejected outright. The suggested rate clears both that floor and the network
  rate, and the copy says to take the increase from change rather than from the
  deposit amount.

  Also adds `server/` to the landing typecheck. It was excluded, so the entire
  money path — every route that moves a stranger's BTC — was unchecked. Adding it
  required only Bun's types; there were no existing errors. It immediately caught
  a call to an undefined function in this very change.

- 8bd8328: **Deposit screen: pay first, read second — plus a QR and a copy button.**

  The amount was stated, then five paragraphs of disclosure, then the address.
  Someone who had already decided to pay had to read ~250 words of terms to
  reach the string they needed — which is how a person learns to scroll past
  terms rather than read them.

  Now the action comes first: amount, address, copy button, and a scannable
  BIP-21 QR in one block. Below it, the substance of the two money risks (no
  withdraw or refund, no reversing a broadcast fee) in a form that needs no
  click. Below that, the full R27 text — complete and unedited — in a `<details>`
  on the same screen.

  Nothing was deleted and nothing moved off the page. A test asserts every line
  of the disclosure contract is still rendered, and that the short lines are
  additions rather than replacements.

  Also: the deposit address had no copy button, on the one screen in the app
  where a string has to be exact because real money depends on it, while three
  other screens had one. The `bitcoin:` link carries the address and the exact
  amount, so paying involves no transcription at all.

- e6cbcb0: Make editing an Original fluent: change the title and the artwork is regenerated from it.

  The title and medium fields were frozen the moment an asset was created, so the only route to a new version was a "Revise artwork" button that shuffled a hidden nonce — new art, but nothing you chose. The form is now the edit surface for the whole life of the asset: retitle it and the preview regenerates live, then **Commit update** signs it into the log. The shuffle button stays as a second route to fresh art. The form locks only while an operation is in flight, or once inscribed (that append costs sats).

  Pending-edit detection now compares the artwork **bytes** against the bytes in the log rather than tracking the nonce, so any route to new artwork counts — and typing the title back to its committed value correctly clears the pending state instead of leaving a phantom revision. Discard restores the committed title, medium and artwork together.

  Fixes an incoherence in the first pass at this: `metadata.json` embeds the title, the medium **and** the artwork's `sha256`, but only `artwork.svg` was being revised — so after an edit the asset's own metadata described a title and bytes it no longer carried. An edit now revises both resources, and genesis `created` is preserved (it records when the asset was made, not when it was last touched). The metadata blob is built by one shared function for genesis and every revision, so the two shapes cannot drift.

  No-op edits stay out of the log: committing without changing anything appends nothing, since `addResourceVersion` refuses a version identical to its predecessor.

- c6adafe: **Fix: the Bitcoin funding account is found instead of re-created every sign-in.**

  Every sign-in after the first failed with:

  ```
  create_wallet_account {"code":6,"message":"path already exists in wallet account …"}
  ```

  `ensureBitcoinFundingAccount` looked for the existing account by reading
  `wallet.accounts` off `getWallets`. Turnkey's `v1Wallet` has no `accounts`
  field — it returns wallet metadata only, and accounts come from
  `getWalletAccounts`. So the lookup was always `undefined`, the account was
  never found, and the first sign-in created it while every later one tried to
  create the same BIP-32 path again.

  The path is fixed, so re-reading returns the same address a previous session
  created — which matters, because a creator may already have BTC sitting at it.

  Also made genuinely idempotent rather than only claiming to be: if creation
  reports the path already exists, that is itself proof the account is there, so
  it re-reads and returns it rather than failing a sign-in over an account that
  already works. And the network-prefix check now covers a re-read account, not
  just a freshly created one.

- 42c68ff: **Fix: the signing bootstrap now says which step failed, at error level.**

  Three unrelated subsystems failed into one catch — the browser's IndexedDB key,
  Turnkey's OTP_LOGIN, and the Bitcoin funding account — and all three reported
  the same `console.warn`. Warn is hidden by the default "Errors" console filter,
  which is the filter in use when someone is debugging a broken page, so the one
  line explaining the failure was the one line they could not see.

  It now reports at error level and names the step and the origin (fresh sign-in
  vs. restore-on-reload), with the error object passed through unflattened so
  Turnkey's own fields stay inspectable.

  Also closes the last silent path: on a real-network build, a missing browser
  key or a missing `verificationToken` returned early with signing left at
  `'none'`, which renders "sign in again to get one" for a browser that just did
  — the same defect as the gate, one layer earlier, and reporting nothing at all.
  Both now report and set `unavailable`.

- 67bc822: **Fix: attach the previous transaction Turnkey requires to sign the commit.**

  The first real mainnet inscription failed at signing:

  ```
  sign_transaction code 3: input 0 is missing non_witness_utxo for
  SegWit v0 input; provide both witness_utxo and non_witness_utxo
  ```

  BIP-143 does not need the full previous transaction to compute a SegWit v0
  sighash, so the SDK's commit builder attaches only `witnessUtxo`. Turnkey
  requires it anyway — the defence against the fee-inflation attack on remote
  signers, which otherwise learn the input's true value only from the party
  asking for a signature.

  The browser now fetches each funding input's previous transaction and attaches
  it before signing, and **verifies** rather than trusts it: the bytes must hash
  to the txid the PSBT names, and the output being spent must match the
  `witnessUtxo` already in the PSBT in both amount and script. A mismatch is
  refused, not signed.

  The lookup goes through `GET /api/btc/prevtx`, which is scoped to the caller's
  own bound deposit address rather than being a general transaction proxy, and
  keeps a creator's funding txids away from a public indexer tied to their IP.

- 800f181: **Fix: OTP_LOGIN sent a DER signature where Turnkey verifies raw IEEE-P1363.**

  Signing never worked on a real network build. Turnkey verifies OTP_LOGIN's
  `clientSignature` over a raw (IEEE-P1363) P-256 signature — `@turnkey/core`
  passes `SignatureFormat.Raw` explicitly — but every Turnkey stamper defaults to
  DER, and the browser client called `sign(message)` with no format. Turnkey
  rejected the signature, the session bootstrap threw, and the user was left
  signed in but unable to inscribe.

  Nothing local could catch it: both encodings are plain hex strings, so the
  types, the build, and the test suite all passed. The suite's fake signer
  returned `'deadbeef'`, which is neither shape.

  The encoding is now pinned by `OTP_LOGIN_SIGNATURE_FORMAT` and passed
  explicitly, and `otpLoginToSession` refuses a non-raw signature before the
  network call, naming DER when it sees it — so a regression fails locally with
  its cause in the message rather than as an opaque bootstrap failure in
  production.

- 449ac28: **Fix: a failed signing bootstrap no longer tells the user to sign in again.**

  A signed-in browser with no signing client fell through to one message — "sign
  in again to get one" — whether it had never minted a key or had just tried and
  failed. In the second case that instruction is unactionable: signing in is
  exactly what failed, so following it loops.

  `SigningStatus` gains `'unavailable'`, set by both catch paths that mean "we
  tried and could not" (restore-on-reload and the post-OTP bootstrap). It renders
  its own message — signing is down on our end, re-authenticating will not fix
  it, the Original and any deposited BTC are untouched — and deliberately offers
  no re-auth button, since offering the action that just failed is the defect.

  `'none'` and `'expired'` are unchanged: there, signing in again is the remedy.

- Updated dependencies [09ce651]
- Updated dependencies [71c81f3]
  - @originals/sdk@3.0.0-next.2

## 0.1.3-next.2

### Patch Changes

- 2c931ca: Let the SDK's layer-agnostic CEL copy through the durable host-key guard, so `did:cel` resolves from storage for signed-in users.

  `LifecycleManager.persistCelArtifacts` writes two copies after genesis and after every append: the webvh-hosted `<host>/<path>/cel.json`, and `cel/<did:cel digest>.json` — the conventional key `DIDManager.resolveDID`'s `did:cel` branch reads back. `isWebvhArtifactKey` only recognised `…/did.jsonl`, `…/cel.json` and `…/resources/<multibase>`, so the second key was rejected as `forbidden_path` (403), swallowed as a `cel:host-failed` warning. On the durable path that copy never landed and `did:cel` never resolved from storage. (The anonymous ephemeral host has no key guard, so only signed-in users were affected.)

  The allowance is tight: exactly two segments, the first literally `cel`, the second `u<base64url>.json`. `serve()` keys on `${url.host}${url.pathname}`, so this key is only reachable as host `cel` plus `/<digest>.json` — it cannot name a path on the app's own origin, which is the static-asset shadowing the guard exists to prevent.

- 2c931ca: Fix `/me/<did>` verification going red on every Original that was inscribed on Bitcoin.

  `verifyOriginal` resolved the CEL through `resolveDidCel` with no `ordinalsProvider`. Inscribing appends a `migrate`/`btco` event carrying a `bitcoin-ordinals-2024` witness proof, which `verifyEventLog` fails closed on without one — so the check reported `CEL event chain did not verify` and the page showed "Verification incomplete", even though nothing was wrong with the chain. No provider can fix this in the browser: this origin proxies `/api/btc/sat|fee|broadcast`, not inscription lookups, so `HttpOrdinalsProvider.getInscriptionById` rejects by design.

  The check now verifies the chain with `verifyEventLog` directly, and when the _only_ failures are anchor lookups on events **after** the `did:webvh` migrate, it re-verifies the log up to that migrate — which is exactly the claim the page makes (genesis → this `did:webvh`) — and says how much it proved: `2 of 4 signed events verified → did:cel:… · the Bitcoin anchor needs an on-chain lookup this page can't make`. A tampered genesis, a bad signature, or an error on an earlier event still fails the check. A CEL whose migrate targets a different DID is now called out separately rather than being conflated with "could not be fetched".

- c9f0842: Let the demo revise an asset after creating it — a real signed `update` event appended to its event log.

  Once an asset exists, a **Revise artwork** control regenerates the SVG and **Commit update** calls `asset.addResourceVersion(...)`, which appends a signed `update` event chaining the new bytes to the version before them. Revisions stack, and each one shows up in the Event log panel alongside `create` and `migrate` — the chain visibly grows rather than just the preview image changing.

  Revising works at `did:cel` (free and offline, nothing hosted yet) and at `did:webvh`: the SDK now hosts the new bytes before it signs, so a published revision is fetchable at the URL its DID implies and earlier versions stay resolvable. An **inscribed** asset is refused with a stated reason — that append writes a new inscription on its satoshi, which is a paid on-chain operation rather than a demo click.

  While a regenerated preview is uncommitted it is badged `not in the log yet`, Publish is disabled (publishing then would publish bytes other than the ones on screen), and a Discard control restores the committed artwork. Revising is modelled as a flag rather than a lifecycle phase, since it is authorship _at_ the current layer and never moves the asset on; the pipeline holds its current stage instead of lighting up the layer the asset hasn't reached.

  Also fixes a latent bug this surfaced: `DemoAssetState` was read out of `asset.resources` **by index**, but `addResourceVersion` _appends_ a new version rather than replacing the old one — so the Resource tab and the `/me` summary hash would have stayed pinned to genesis after any revision. The snapshot now selects the newest version of each logical resource by id, and reports `resource.version`.

- Updated dependencies [5f0788f]
- Updated dependencies [c9f0842]
  - @originals/sdk@3.0.0-next.1

## 0.1.3-next.1

### Patch Changes

- 1b8717a: Show the asset's real Cryptographic Event Log in the live demo, replacing the SDK emitter-event stream.

  The demo's first tab streamed `asset:created` / `resource:published` / `asset:migrated` — app-level notifications the SDK emits to your code. Those are not the provenance record. The asset **is** its CEL, and the landing page never showed it: the signed chain only appeared on the authenticated `/me/<did>` page.

  The tab now renders the log itself, built entry by entry as the pipeline runs: each event's type, a plain-English gloss of what its signed body asserts, the `did:key` that signed it, its proof value, and — drawn _between_ entries, because it is entry N's claim about entry N-1 — the `previousEvent` digest that chains them. Entries are accented by destination layer, matching the pipeline above.

  `DemoAssetState` gains a `celLog` field, read defensively from `OriginalsAsset.celLog` so an unexpected shape degrades to an empty chain rather than breaking a lifecycle step.

## 0.1.3-next.0

### Patch Changes

- 71e5f19: **Fix: the shipped "First Light" example's credential no longer verifies — regenerated.**

  The landing page's whole claim is that the visitor's browser re-checks the example rather than trusting the page. Since 2026-07-26 it had been rendering "Credential signature did not verify" to every visitor.

  Cause: the example was minted 2026-07-15, and #445 then added `migratedTo`, `resourceId`, `fromLayer`, `toLayer` and `migratedAt` to `contexts/originals.json` — the exact five terms this credential's `credentialSubject` uses. Before that change `@vocab` absorbed them into `…/vocab#X`; after it they expand to `Originals:X`. `eddsa-rdfc-2022` signs over the RDF canonicalization of the _expanded_ document, so the signing bytes changed and the existing signature stopped verifying. #445's "no signature impact" note held for credentials signed and verified against the same context version, but not for ones already signed.

  The example is regenerated with the current SDK, and `verifyExample()` now has a test asserting every check passes — the gap that let this ship, since all three checks fail _softly_ into a red row rather than throwing.

  Worth noting for consumers generally: changing a JSON-LD context that credentials reference by URL invalidates signatures over already-issued credentials.

- Updated dependencies [18fb3bf]
- Updated dependencies [636417c]
- Updated dependencies [ae9f8cb]
- Updated dependencies [5e89cba]
- Updated dependencies [00d0c07]
- Updated dependencies [ae9f8cb]
- Updated dependencies [0d241bc]
- Updated dependencies [636417c]
- Updated dependencies [ed327d9]
  - @originals/sdk@3.0.0-next.0
  - @originals/auth@3.0.0-next.0

## 0.1.2

### Patch Changes

- Updated dependencies [99dfa90]
  - @originals/sdk@2.1.0

## 0.1.1

### Patch Changes

- 76d0116: Warn loudly at boot when durable Originals will not persist. On a deployed instance (Railway markers / `NODE_ENV=production`) with the auth API enabled but `ORIGINALS_DATA_DIR` unset, the server now logs the resolved durable dir and a prominent warning that signed-in users' Originals are being written to an ephemeral container path and will be lost on redeploy. Warn-not-throw: the anonymous demo and Track-A did:webvh hosting still run without durable storage.
- 1e9c77f: Add Railway deploy config for the landing page (#330): `railway.json` builds the workspace (SDK + auth via turbo) then the Vite SPA, and `apps/landing/serve.ts` is a small Bun static server (SPA fallback, path-traversal guard, binds `0.0.0.0:$PORT`).
- 7384c60: Landing production server (`apps/landing/serve.ts`) now serves the SPA **and** mounts the `/api` auth routes in the same process when Turnkey env (`TURNKEY_*` + `JWT_SECRET`) is set, so the Railway deploy supports Sign-in same-origin. Without that env it serves static only and `/api/*` returns a clear JSON 404 instead of SPA-falling-back to `index.html` (which made the client parse HTML as JSON — "Unexpected token '<'").
- c579e07: Fix header nav links being dead on the `/me` (Your Originals) route. The nav renders on every route, but its in-page section anchors (`#why`, `#demo`, `#protocol`, `#developers`, and the wordmark's `#top`) had no target when those sections weren't mounted — so on `/me` only the JS-driven buttons (Sign out, Your Originals) responded. A shared `goToSection()` now routes home first when off `/`, then smooth-scrolls to the section once it mounts (and smooth-scrolls in place when already on `/`).
- e78c309: Harden the durable Originals host routes (issues surfaced by review of #431's merged code):

  - **Namespace pre-squat blocked.** `hostPut` now rejects a write to a `user-<slug>` path segment that isn't the caller's own, so an authenticated user can no longer claim another user's predictable publisher DID path (`user-<victim>/did.jsonl`) before them and lock them out. Asset paths are hash-derived (not `user-`-prefixed) and remain guarded by the store's first-writer-wins owner sidecar. The `webvh.ts` doc now describes the enforcement accurately.
  - **Malformed URL → 400, not 500.** A crafted percent-encoding (`%GG`) made `decodeURIComponent` throw an uncaught `URIError` (500). Both `hostPut` and `hostGet` now decode via a guarded helper and return a clean 400.
  - Removed a stray empty changeset (`red-dots-grab.md`).

- 75cfba7: Fix a production outage where every request to `originals.build/` (pathname `/`) returned 500 with `EISDIR: illegal operation on a directory, read`. The durable Originals `serve()`/`read()` mapped a directory-resolving key (e.g. `<host>/` for `/`, which exists once anything is hosted) through `readFileSync`, throwing `EISDIR` and crashing the request instead of falling through to the SPA. Both now guard with `statSync(path).isFile()` inside a try/catch (also closing the `existsSync`→`stat` TOCTOU), so a directory or vanished key is a clean miss/404.
- Updated dependencies [9d3c682]
- Updated dependencies [6ef2c47]
- Updated dependencies [cf78590]
- Updated dependencies [c23eeef]
- Updated dependencies [fca65b5]
- Updated dependencies [d5ebec2]
- Updated dependencies [db8beba]
- Updated dependencies [db8beba]
- Updated dependencies [fbaf69a]
- Updated dependencies [6bb75c1]
- Updated dependencies [784d0ea]
- Updated dependencies [37e8730]
- Updated dependencies [d0d88e9]
- Updated dependencies [06490bb]
- Updated dependencies [8f73929]
- Updated dependencies [e845cb7]
- Updated dependencies [49cf1d5]
- Updated dependencies [0e6674a]
- Updated dependencies [73eac12]
- Updated dependencies [e236aee]
- Updated dependencies [b1c05f0]
- Updated dependencies [15faa98]
- Updated dependencies [20df4be]
- Updated dependencies [7d02dc8]
- Updated dependencies [a07ff36]
- Updated dependencies [dbe3f10]
- Updated dependencies [0e6674a]
- Updated dependencies [dbe3f10]
- Updated dependencies [9e61052]
- Updated dependencies [122139b]
- Updated dependencies [a4e440f]
- Updated dependencies [9dddc24]
- Updated dependencies [e571787]
- Updated dependencies [ae15309]
- Updated dependencies [06644c5]
- Updated dependencies [a546db1]
- Updated dependencies [2443dc2]
- Updated dependencies [88d6eac]
- Updated dependencies [5981ec2]
- Updated dependencies [cb16f02]
- Updated dependencies [be4c5b6]
- Updated dependencies [f10e112]
- Updated dependencies [a546db1]
- Updated dependencies [7f4c42d]
  - @originals/sdk@2.0.0
  - @originals/auth@2.0.0
