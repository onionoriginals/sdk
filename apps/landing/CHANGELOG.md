# @originals/landing

## 0.2.0-next.3

### Minor Changes

- a88841b: **The demo names what it actually draws.**

  The MEDIUM control offered Artwork / Music / Writing / Photograph / Dataset, but the renderer mapped those five labels onto three shapes — and Artwork and Photograph were byte-identical. Picking "Photograph" drew vector orbits. A label the picture cannot keep is worse than no label.

  MEDIUM is now STYLE, named for what each one draws: **Orbits**, **Constellation**, **Radial Bars**, **Dot Grid**. Every style renders differently, and a test asserts no two produce the same picture.

  The title is now generated too, from the same (style, nonce) seed as the artwork — so one Regenerate moves the name and the picture together, and a visitor lands on a titled piece instead of a placeholder asking them to invent one. A **New name** button re-rolls it; typing your own still works.

  The picture is now seeded by style and nonce alone rather than by the title, so typing a name no longer reshuffles the art underneath you. The title still reaches the hashed bytes through the SVG's `<title>` element, so what you type is still what gets signed.

  `metadata.json` carries `style` where it carried `medium`. Readers accept either, so assets published before the rename — including the first real mainnet Original — keep rendering their label.

- a88841b: **The demo's asset can be your file or your words, not only generated art.**

  A Source picker offers three ways to make the asset's bytes:

  - **Generate** — the existing generative artwork, unchanged.
  - **Upload** — bring your own SVG or plain text file, up to 32 KB.
  - **Write** — type or paste raw text straight into the page.

  All three travel the same `did:cel → did:webvh → did:btco` lifecycle, and in every case the bytes published are exactly the bytes supplied — verbatim, not normalised or re-wrapped.

  **SVG and text only, deliberately.** `AssetResource.content` is a `string` and the SDK hashes it as `TextEncoder().encode(content)`, so there is no binary path: a PNG would either corrupt or have to be re-encoded into something whose hash no longer belongs to the user's file. Carrying real binary is an SDK change and belongs with the 3.0.0 API-freeze work, not here.

  **32 KB cap.** Inscription pays by the byte — witness data is roughly a vbyte per four bytes — so 32 KB is about 8,000 vB, a cost a creator can actually cover. A larger cap would let someone build an asset they can never afford to put on Bitcoin.

  Uploaded SVG is safe to host: the store already serves every stored object with `nosniff`, `default-src 'none'; sandbox` and `content-disposition: attachment`, so attacker-supplied markup cannot execute from this origin, and SVG rendered in an `<img>` cannot script either.

  `DemoEngine.create`/`update` now take an `AssetSource` (bytes, media type, filename); a bare string remains shorthand for generated SVG artwork, so existing callers are unchanged.

- 272feb8: **The did:webvh host is pinned to one canonical domain, not inherited from the visitor.**

  `demoHost()` fell back to `window.location.host`, so whichever hostname a visitor arrived on was written into their DID — and a `did:webvh` domain cannot be changed after publication. Railway keeps its generated `*.up.railway.app` hostname reachable alongside a custom domain, so the wrong host was one bookmark away, permanently.

  Three changes, all keyed on `VITE_WEBVH_HOST`:

  - **Required on mainnet, named at boot.** `validateConfig` reports an unset or malformed `VITE_WEBVH_HOST` when `BTC_NETWORK=mainnet`, alongside the existing contract; a value carrying a scheme, port or path — or any uppercase — is rejected, since the DID embeds it verbatim and `URL` lowercases every host the server parses. Warn-only until `CONFIG_STRICT=1`, like every other rule.
  - **A canonical-host redirect.** `buildFetch` takes a `canonicalHost` and 301s document requests arriving on any other host. `/api/*` is exempt: a 301 on a PUT is not safely replayable, and a platform probe must not chase a redirect to find a healthy process. Unset in dev and tests, where nothing redirects.
  - **Documented as the permanent value it is**, with a pre-mainnet check that greps the built bundle rather than trusting the dashboard — Vite deletes the branch entirely when the var is absent at build time, so its presence in the chunk is the only evidence it was baked.

### Patch Changes

- cef3e49: **Show the funding transaction while an inscription is still finishing.**

  Between broadcasting the commit and the reveal confirming, the page said the inscription would "finish shortly" and named the satoshi — and gave nothing else. No transaction id, no link, nowhere to look. At the one moment a creator has just spent real money, the step went quiet, which reads as nothing having happened.

  The commit-only view now carries the **funding transaction id, linked to a block explorer**, the fee rate it paid, a line stating the inscription transaction is already signed and broadcasts on its own, and a link to Your Originals, which the surrounding copy already told people to check but never linked.

  Every value shown was already in `DemoAssetState.inscription` — this was a display gap, not missing data. The explorer URL goes through the same helper as the completed view, so a simulated run still offers no link to a transaction that does not exist, and nothing here claims the inscription has landed.

- a6ba756: **The notes under the pipeline were unstyled, and titles could change without the art.**

  `.demo-inscribe-note` had no CSS rule at all — not a wrong one, none. Nine call sites used it (the mock disclaimer, the sign-in prompt, the deposit and session notes), so all nine rendered as raw `<p>`: body-sized, default margins, full-strength colour. They read as page copy that had escaped its card and collided with the panels above and below. Only `.demo-sim-note` carried a rule, contributing a dashed left border and no type styling — the stray vertical line. These are asides about the step, and are now typed like the other asides.

  **A new name now arrives with new art, and only then.** The "New name" button rolled a title from a random nonce, so a name could change while the picture stayed put — the two came apart, which is the opposite of the intent. The button is gone. Regenerating, or changing style, re-rolls the title _provided it is still the one that `(style, nonce)` generates_. That check needs no dirty flag, never overwrites a title the visitor typed, and recognises a restored title as generated again after Discard.

  Start over now takes a fresh name with its fresh artwork instead of carrying the previous run's title, and resets the source to Generate — an upload from the last run is not a clean slate.

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

- 7c76f9b: **Landing: say what durable did:webvh hosting actually buys, instead of "hosted for keeps".**

  Durability was settled at backups-only (#520). The publish step's `temporaryNote` told an anonymous visitor their log would be "hosted for keeps" once signed in, a promise the deploy cannot make. It now states only what the deploy delivers today: an own path on a persistent volume, kept for as long as this service runs. The scheduled backup is recorded in `apps/landing/DEPLOY.md` as a pre-mainnet item that is not yet enabled, so the copy does not claim it.

  The lifecycle timeline now states the did:btco distinction rather than implying it: once inscribed, the reveal metadata carries the whole signed log, so an inscribed Original's provenance survives even this service, while a log that stops at did:webvh lasts only as long as this service hosts it.

- e6cbcb0: Make editing an Original fluent: change the title and the artwork is regenerated from it.

  The title and medium fields were frozen the moment an asset was created, so the only route to a new version was a "Revise artwork" button that shuffled a hidden nonce — new art, but nothing you chose. The form is now the edit surface for the whole life of the asset: retitle it and the preview regenerates live, then **Commit update** signs it into the log. The shuffle button stays as a second route to fresh art. The form locks only while an operation is in flight, or once inscribed (that append costs sats).

  Pending-edit detection now compares the artwork **bytes** against the bytes in the log rather than tracking the nonce, so any route to new artwork counts — and typing the title back to its committed value correctly clears the pending state instead of leaving a phantom revision. Discard restores the committed title, medium and artwork together.

  Fixes an incoherence in the first pass at this: `metadata.json` embeds the title, the medium **and** the artwork's `sha256`, but only `artwork.svg` was being revised — so after an edit the asset's own metadata described a title and bytes it no longer carried. An edit now revises both resources, and genesis `created` is preserved (it records when the asset was made, not when it was last touched). The metadata blob is built by one shared function for genesis and every revision, so the two shapes cannot drift.

  No-op edits stay out of the log: committing without changing anything appends nothing, since `addResourceVersion` refuses a version identical to its predecessor.

- a8fe507: **Fix: the page claims first publication, and names the index its Bitcoin reads depend on.**

  Two overclaims, from the protocol design review.

  **"Proof you made it" is not what the protocol proves.** It proves that a key signed this content hash, that Bitcoin timestamped that signature, and that this key anchored this log first. Nothing binds the key to a person, and identity is the hash of the genesis event — so someone can pull a file off Twitter, mint it, inscribe first, and hold a proof that verifies exactly as green as the creator's, and earlier. The protocol has no answer to that and cannot have one.

  Priority of publication is the real claim, and it sells fine. The headline, page title, meta description, hero subhead and Why headline now say first publication and timestamping rather than authorship.

  **"Anyone can verify the whole chain — without trusting you, us, or any platform" was false.** Every on-chain fact in the verify path — which inscriptions sit on a sat, their block heights, their content — comes from an Ordinals indexer. There is no header chain and no SPV anywhere in it, so a dishonest index can hide the newest anchor, hide a competing earlier anchoring, or misreport heights, all undetectably.

  The provenance card now separates the two halves: the signature checks are genuinely trustless and say so, and the Bitcoin reads name the index they depend on. Stated plainly rather than softened into "decentralized infrastructure".

  **"If we vanish tomorrow, your provenance still verifies" was true only sometimes** — for an inscribed asset whose log someone kept. A pre-anchor asset is bytes on this host and dies with it. The claim is now conditioned on both, and points at the export.

  The protocol section also says which of the three method names are actually standards: `did:webvh` and `did:btco` are registered DID methods, `did:cel` is ours and is not.

  Tests pin the shape of each claim rather than its wording, so a future copy pass can rewrite freely but not back into any of them.

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

- 071b898: **A dry run of the inscription path that never broadcasts (#526).**

  `bun run dry-run:inscription` (`scripts/dry-run-inscription.ts`) builds and signs a commit and reveal pair through the code that ships: the server's deposit, fee, sat, prevtx and inscribe routes, the browser's provider and signer wrappers, and the SDK's commit and reveal builders. The provider underneath rejects every broadcast-shaped call and the broadcast route is not reachable, so the inscribe route runs every invariant, persists the pair, and stops at the broadcast step. With `QUICKNODE_ENDPOINT` it reads mainnet; without one it runs the mock provider over a fixture deposit.

  The record prints both raw transactions, the live fee estimate and the 1.5x quote against what the pair actually pays, every confirmed output at the address with its ordinal classification and whether it was selected, the reveal key with a freshness proof, the sat's path to the deposit address, and a pass/fail checklist with a one-line judgement. A local key stands in for the Turnkey API call when `DRY_RUN_WIF` is set; without it the commit stays unsigned and the verdict is INCOMPLETE, never PASS.

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

- 39a95e1: **Fix: the page clipped itself on phones, and the inscribe estimate quoted below its own numbers.**

  _Horizontal overflow at phone widths._ At 375px the demo card rendered 457px of content inside its own 325px shell, and `.demo-shell`'s `overflow: hidden` sliced the right-hand end off every line in it — step copy, buttons, the resolved DID log, the event entries. At 320px the whole page also scrolled sideways by 44px.

  One root cause in four places: a bare `1fr` grid track is `minmax(auto, 1fr)`, whose floor is the content's min-content width. Every desktop rule in this app already used `minmax(0, …)`; the mobile fallbacks were left as `1fr`, so a single unbreakable identifier set a floor no phone viewport could satisfy. `.demo-body`, `.example-shell`, `.footer-inner` and `.footer-columns` are fixed, the columns get `min-width: 0`, and the prose carrying raw `did:webvh`/`did:key` strings (`.cel-entry-summary`, `.cel-entry-proof`) now wraps. The footer was the page-scroll on its own: two 150px column floors plus a 40px gap demand 340px inside the 272px a 320px viewport leaves.

  Three narrow-phone concessions under one `≤420px` block: the asset artwork stacks above the form instead of beside it (side by side left the title input 78px wide at 320px), the controls gutter drops 24px → 16px, and the event-log tab strip scrolls in one row rather than being clipped.

  Verified by rendering at 320, 375 and 414, both idle and after Create → Publish: no horizontal page scroll and no clipped content at any width. `scripts/viewport.mjs` is that check, wired into `landing:ci` beside the existing smoke and TTI gates; it fails on the parent commit and passes on the fix.

  _The inscribe cost line._ It rounded its own figures down — the estimator produces 4,055 sats at 1 sat/vB and 18,089 at 5, and the copy said "around 4,000" and "18,000", quoting a creator 55 and 89 sats under what they would actually be asked for. Now 4,100 and 18,100, and the tests assert the direction (never below the estimator, within one 100-sat step of it) instead of pinning the strings. The line also sat directly above a button labelled "Run the simulation", so it read as that button's price; it moves below the button and now says plainly that the simulation is free and the price is for inscribing for real. Dropping "quoted live when you sign in" also removes a promise mock builds could not keep, since `demoTier('off', …).real` is false for every visitor there.

  No change to the estimator, the fee logic, or any figure it produces.

- d9a2938: **Money path: the server now verifies what it used to take on trust from the browser (#493).**

  `POST /api/btc/inscribe` classifies every declared funding outpoint for inscriptions itself and refuses to broadcast a commit that would spend an inscribed sat, or one it cannot classify — the fail-closed ordinal property no longer rests in the browser alone. It also asserts where the money goes: the commit's change output and the reveal's output must both pay `changeAddress`, and `changeAddress` must be the deposit address bound to the account.

  `GET /api/btc/deposit` says when its ordinal check was partial: an address holding more outputs than one poll can classify now reports `ordinalCheck: 'partial'` with the count of unchecked outputs, instead of `'ok'` over a silently truncated set. The page explains why the explorer balance reads higher.

  The deposit poll now sends a `contentBytes` hint sized from the media, metadata and CEL log that will actually be inscribed, so the quote no longer defaults to 8,000 bytes and under-funds a larger asset after the creator has already deposited.

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

- c140d67: **Three landing fixes: the demo's payoff step, the page title, and a price a signed-out visitor can see.**

  _The did:webvh payoff rendered unstyled._ The block that appears after Publish carried five class names — `demo-resolved`, `-head`, `-badge`, `-link`, `-note` — and none of them existed in `demo.css`. With no rules the spans butted together ("for nowresolved ✓", "Open the signed DID loghttps://…") and the log URL, one unbreakable did:webvh slug with no space or hyphen to break at, ran 71px out of the left column and across the divider into the event-log panel at 1280. It now gets the card treatment the revise panel beside it already had, the status drops to its own line rather than sitting next to a two-line heading, and the slug wraps inside its column. `demo-resolved-badge` is shared with the deposit heading, which was unstyled for the same reason.

  _The tab and the search snippet still sold an SDK._ `site.title` and `site.description` were the only copy the creator repositioning never reached — "Originals SDK — Provenance that survives the internet" over a description ending in did:cel → did:webvh → did:btco. That is the string in the browser tab, the Google result and every link preview, and it was a package listing in front of a page whose hero reads "Proof you made it. Carved into Bitcoin." Both are rewritten in the voice the hero and Why Originals already use, at 50 and 149 characters.

  _No price appeared anywhere until you signed in._ The Protocol table's "BTC fees / One-time network fees" names a category; the only real figure lives in the deposit panel, behind sign-in. The inscribe step now carries the estimate for anyone the deposit route will never quote — a signed-out visitor, or any visitor on a deploy with real Bitcoin off. The figures are `estimateInscriptionCostSats`, the server's own deposit quote, at the shape that route actually prices for this client: 4,055 sats at 1 sat/vB and 18,089 at 5. Its multiplier is a live mempool reading, so the copy says the exact amount is quoted live and rounds rather than pretending to four figures — and it keeps the deposit copy's two hard facts, that this is a one-time on-chain fee the creator pays and that none of it is refundable. Tests re-derive both numbers from the estimator instead of pinning the strings.

  Also fixes the Deploy API Docs workflow, which had failed on every push to main since `@originals/cel` was split out: typedoc typechecks `packages/sdk/src`, whose `@originals/cel` imports resolve through that package's `exports` to `./dist`, so on a runner that had only run `bun install` all 200 of them were TS2307 and typedoc exited 3. The job now builds the workspace packages first, as ci.yml's ESM job already did. No published package changes from that part.

- a8fe507: **Fix: `/context` serves the JSON-LD context instead of the SPA.**

  Every credential the SDK issues names `https://originals.build/context` in its `@context`. That URL returned `index.html` under `content-type: text/html`, so a conformant verifier's document loader had nothing to load and refused the credential. Any Originals credential was unprocessable outside this repo.

  Our own stack never noticed, and could not have: `packages/sdk/src/utils/serialization.ts` short-circuits those URLs with a bundled copy and never makes the request. The break survived to production with every test green.

  The route now answers with `application/ld+json`, ahead of the SPA fallback that used to catch it. Three details that matter:

  - The bytes are imported from `packages/sdk/src/contexts/originals.json` — the same module the SDK verifies against — rather than copied, so the hosted document cannot drift from the one credentials are actually checked with.
  - CORS is open. Without `access-control-allow-origin`, the route would be fixed for servers and still broken for any browser-based verifier.
  - It is host-agnostic, so the pichu/cleffa/magby context URLs in `types/network.ts` are satisfied by the same handler.

  Tests assert what a foreign loader checks: the media type, that the body parses as JSON-LD, CORS and its preflight, HEAD, and that the served document equals the SDK's copy read independently from disk.

  `/vocab` is still the SPA. `@vocab` is an IRI prefix that loaders never dereference, so no credential depends on it.

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

- 778931d: **Stop linking a reveal transaction that has not been broadcast.**

  An Original's detail page linked `revealTxId` to a block explorer unconditionally. The commit and reveal are both signed and persisted _before_ either is broadcast, so that id exists long before the transaction does — and while a commit is still confirming, the link is a 404 handed to someone who has just paid.

  Hit on a live mainnet run, moments after an inscription was submitted.

  `inscriptionStatus` cannot answer this: it is written `'pending'` at inscribe time whichever transaction went out. The four-state broadcast status was already fetched client-side from `GET /api/btc/inscribe`, but `withLiveInscriptionStatus` used it only to upgrade rows to `'confirmed'` and discarded the rest. It now carries `revealBroadcast` through as well.

  With that, the page links only what exists: the **reveal** once it is broadcast or confirmed, otherwise the **funding transaction**, which is genuinely on the network and is the thing worth watching. The reveal's id is still shown — with a line saying it is signed, saved, and goes out once the funding transaction confirms.

- f6bcc39: **Feature: finish a published Original that never reached Bitcoin, instead of re-running the demo.**

  A published Original that was never inscribed showed on `/me` with no way to inscribe it, and the detail page had no Bitcoin action at all — so the creator re-ran the demo and ended up with a second, different `did:webvh` Original.

  Closing that gap turned out to be a custody problem, not a UI one. An Original is a CEL, every lifecycle step appends a signed event to it, and the key that signed those events was minted by `createAsset` into the DemoEngine's in-memory Map and destroyed with the tab. Verified before writing anything: after create + publish in Chromium, `localStorage` is empty while the CEL genesis controller reads `did:key:z6Mkks2HT…`. Nothing could sign a later `migrate` event, so no button could have worked.

  Turnkey already provisions two `CURVE_ED25519` accounts per sub-org that nothing signed with. Ed25519 is what CEL requires, and Turnkey custody is what a browser-local seed is not: it comes back with the session on any device. A signed-in creator's Originals are now authored by that key from genesis onward, passed per-call so `Demo.tsx` is untouched — and `publish`/`inscribe` must use the same key, because pre-anchor the CEL accepts only its current controller as signer.

  `/me` and `/me/<did>` now offer "Inscribe on Bitcoin" for a row that was never built. It rebuilds the asset from the artifacts the Original hosts (`hostedAssetEnvelope` → `loadAsset`, verifying the signed chain, resource-to-genesis binding and DID-doc cross-checks fail-closed) and hands it to the existing `engine.inscribe({ funding })` — that path is not forked. Funding comes from the app's own `GET /api/btc/deposit` and the same `selectFundingUtxos` the demo uses; no fee estimation or selection rule is reimplemented here, and it refuses before building anything if the deposit does not cover the quote.

  Finish and Inscribe are decided by one shared selector and never both appear on a row: rebuilding over signed, paid-for transactions would strand that spend.

  **One limitation, stated plainly.** Originals created _before_ this change answer to a controller key that only ever existed in one tab and is gone. They cannot be inscribed, by anyone, on any device — the action is disabled for them with copy that says so rather than implying another device would help, and says what remains true: their history stays signed, verifiable and hosted. Only Originals created from now on are resumable.

- acff3a3: **Turnkey signing was rejected outright on Ed25519 keys.**

  `turnkeySignBytes` sent `hashFunction: 'HASH_FUNCTION_NO_OP'`. Turnkey refuses that combination:

  ```
  cannot use hash function NoOp to produce ed25519 signature
  ```

  Ed25519 takes the message itself and hashes internally as part of the signature scheme, so there is no pre-hash slot to declare as a no-op — that enum belongs to the ECDSA curves, where a caller may hand over a digest. The correct value is `HASH_FUNCTION_NOT_APPLICABLE`, which expresses the same intent the code always had: the SDK owns canonicalization, and Turnkey signs the given bytes verbatim.

  This is the one place Turnkey actually signs, so it blocked **every** Turnkey-authored signature: creating an Original on the deployed landing page, and signing a user's `did:webvh` log.

  The existing test captured the call's parameters but never asserted `hashFunction`, so a local stub accepted a value the real API rejects. It now asserts it.

- Updated dependencies [a8fe507]
- Updated dependencies [09ce651]
- Updated dependencies [71c81f3]
- Updated dependencies [6e6bc3d]
- Updated dependencies [6e6bc3d]
- Updated dependencies [6e6bc3d]
- Updated dependencies [08b9f17]
- Updated dependencies [6e6bc3d]
- Updated dependencies [acff3a3]
  - @originals/sdk@3.0.0-next.2
  - @originals/auth@3.0.0-next.1

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
