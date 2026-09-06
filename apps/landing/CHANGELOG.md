# @originals/landing

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
