# @originals/auth

## 4.0.1

### Patch Changes

- 5924062: Allow verified email login to an existing identity when the parent Turnkey key lacks permission to repair missing wallet accounts. Keep other repair failures visible and leave account creation to the authenticated user session.

## 4.0.0

### Major Changes

- 7781ab8: **`verifyEmailAuth` now claims a session before verifying its OTP code, closing both a replay gap and a concurrent brute-force gap** (#710, #819).

  Previously, `verifyEmailAuth` never checked `session.verified` before running a full OTP-verify round trip, so a second call with the same `sessionId` and code re-submitted the already-consumed OTP to Turnkey and minted a second, independent verification token (#710). Separately, `MAX_OTP_ATTEMPTS` was only checked reactively — after a failed `verifyOtp` round trip — so a burst of concurrent wrong-code guesses for one session could all reach Turnkey before any of them incremented the local attempt counter, bypassing the documented local brute-force cap (#819).

  A new `session.verifying` claim, taken atomically through the store's `claimForVerification` before any Turnkey call, now rejects a sequential replay on an already-verified session and serializes concurrent calls racing the same unverified session — only the claim winner ever dispatches to Turnkey, so at most one guess is in flight per session at a time. The claim is released on any failure path that leaves the session alive (a failed encryption attempt, a transient Turnkey failure, or a definitively wrong code within budget), so a corrected retry still works.

  `SessionStorage` gains a required `claimForVerification(sessionId)` method so a shared, multi-instance store (Redis, a database) makes the claim atomic across processes via a real conditional write; `createInMemorySessionStorage` implements it trivially. **Breaking for custom stores:** `verifyEmailAuth` rejects a store without it with `AUTH_SESSION_STORAGE_CLAIM_REQUIRED` rather than falling back to a get-then-set claim that two instances can both win.

- 9d770cd: **Breaking: `getAuthCookieConfig`/`getClearAuthCookieConfig` now default `secure: true` unconditionally**, instead of inferring it from `process.env.NODE_ENV === 'production'` (#676).

  Not every deployment platform sets `NODE_ENV` to exactly `"production"`, so the previous default silently shipped the 7-day auth JWT cookie without `Secure` on any platform that doesn't. That was the bug this closes — but it also means any consumer currently serving over plain HTTP without passing an explicit `secure` option will start receiving `Secure` cookies, which browsers drop on a non-HTTPS origin, breaking auth. Pass `{ secure: false }` explicitly on **both** the set and the clear cookie config to keep the previous plain-HTTP behavior.

### Minor Changes

- 339c91a: `verifyToken` (from `@originals/auth/server`) now throws a `StructuredError` with a stable `code` — `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`, or `AUTH_TOKEN_MISSING_SUBJECT` for a bad token, and `AUTH_JWT_CONFIG_SECRET_MISSING`/`AUTH_JWT_CONFIG_SECRET_WEAK` for a misconfigured server secret — instead of a bare `Error` that made the two indistinguishable. A new `isAuthTokenCredentialError(error)` helper reports whether an error is one of the credential-failure codes.

  `createAuthMiddleware` and `createOptionalAuthMiddleware` use this to fix a correctness bug (#729): a valid JWT combined with a rejection from the caller-supplied `getUserByTurnkeyId`/`createUser` callback, or a misconfigured `JWT_SECRET`, previously read as bad credentials — `createAuthMiddleware` returned `401 { error: 'Invalid or expired token' }` and `createOptionalAuthMiddleware` silently continued as an anonymous guest. Both now call `next(error)` for these operational/config failures so they reach Express's error-handling middleware, while an actually invalid/expired/malformed token keeps its existing behavior (401, or anonymous continuation) unchanged.

- 1dc28aa: `sendOtp`/`verifyOtp` (from `@originals/auth/client`) now throw an `AuthApiError` (extends `Error`) instead of a bare `Error` on a non-ok server response. `message` behavior is unchanged for existing callers; `AuthApiError` additionally carries `status` (the HTTP status) and `code` (the server's machine-readable `error` field, when present), so a caller can branch on the failure kind instead of parsing display text. This pairs with the landing app's `auth-routes.ts`, which now returns `{ error: 'invalid_email' | 'rate_limited' | 'send_otp_failed' | 'missing_fields' | 'verification_failed' | 'unauthorized' | 'invalid_token', message }` on every named failure instead of `{ message }` only.
- 64b2d19: `packages/auth/src/server/email-auth.ts`, `turnkey-client.ts`, and `turnkey-signer.ts` now throw `StructuredError` with a stable `.code` instead of a plain `Error`, completing the remainder of #747 (the JWT slice landed separately). New exported codes: `AUTH_EMAIL_ERROR_CODES`, `AUTH_TURNKEY_ERROR_CODES`, `AUTH_TURNKEY_SIGNER_ERROR_CODES`. Every thrown error keeps its exact original message, so existing `catch (e) { ... e.message ... }` callers are unaffected; callers wanting typed discrimination can now branch on `e.code` (`StructuredError` still extends `Error`).

  **Behavior fix (not just typing):** `verifyEmailAuth`'s OTP-verification catch block previously charged a transient/network failure calling Turnkey's `verifyOtp` (timeout, 5xx, `ECONNRESET`) against the same `MAX_OTP_ATTEMPTS` budget as a genuinely wrong code, so a Turnkey blip during the 15-minute OTP window could exhaust a legitimate user's attempts and lock them out. A definitive Turnkey rejection (a `TurnkeyRequestError`-shaped error carrying a numeric `code`) now throws `AUTH_OTP_CODE_INCORRECT` and still consumes an attempt; anything without that evidence throws the new `AUTH_OTP_VERIFY_TRANSIENT_FAILURE` instead, does not consume an attempt, and leaves the session alive so the same code can be resubmitted. New exported helper `isOtpVerifyTransientFailure(error)` and `extractTurnkeyErrorCode(error)` (also from `turnkey-client.ts`) let callers detect this distinction.

### Patch Changes

- 5679c89: **Fix (#684): `SessionStorage`'s `get`/`set`/`delete`/`cleanup` now support a Promise-returning implementation.** The interface was declared fully synchronous and `email-auth.ts` called it without `await`, even though the package's own docs recommend a persistent Redis/DB-backed store for production and `specs/auth/authentication-flows.md` documents exactly that. A real async store's `get()` returns a `Promise`, which is truthy, so `verifyEmailAuth`'s "session not found" guard never fired and every field read off the unresolved Promise came back `undefined` (surfacing as a misleading `"OTP ID not found in session"` error); an unawaited `set()` also let `initiateEmailAuth` return before an async write had landed.

  Every `SessionStorage` method is now typed `T | Promise<T>`, and all call sites `await` the result. `isSessionVerified`, `getSession`, and `cleanupSession` are now `async` (previously synchronous), since they call `storage.get`/`delete` internally — existing callers using them without `await` will start receiving a `Promise` instead of the resolved value. `createInMemorySessionStorage` is unaffected: a synchronous return still satisfies the widened interface.

- 37e9468: Allow required and optional authentication middleware to verify custom JWT issuer and audience values while preserving defaults and rejecting mismatches. Keep successful next calls outside authentication error handlers so consumer errors do not trigger duplicate continuation.
- a136520: **Server-side Turnkey sub-org provisioning now assigns the secp256k1 "Bitcoin auth-key" account a Bitcoin address format instead of an Ethereum one** (#689).

  `DEFAULT_WALLET_ACCOUNTS` in `server/turnkey-client.ts` provisioned its `m/44'/0'/0'/0/0` account — its own comment labels it "Bitcoin path for auth-key" — with `ADDRESS_FORMAT_ETHEREUM`, while the identical curve/path account in `client/turnkey-client.ts` already used `ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR`. `getOrCreateTurnkeySubOrg` is the function `apps/landing`'s email-auth flow actually calls to provision real user sub-orgs, so every user's Bitcoin auth-key account was getting an Ethereum-formatted `.address` for a key meant for Bitcoin funding and sat verification.

- 820f38c: Use the Turnkey client's configured organization for sub-organization lookup and creation, so explicit configuration works without environment variables and cannot be redirected by a conflicting environment. Preserve the environment fallback for injected clients without configuration.
- 013a6fe: **`createDIDWithTurnkey` and `buildUserWebVHDid` no longer bake an empty-string `controller` into every verification method (#804).** Both called `OriginalsSDK.createDIDOriginal()` with `controller: ''` on each entry in `verificationMethods`, because the DID being minted isn't known until creation completes and the SDK's input type required `controller` up front. `didwebvh-ts` passes that value straight through instead of filling it in itself, so every verification method in the resulting DID document — and everywhere that document is published or resolved — carried a literal empty string instead of the DID.

  - `CreateDIDOriginalOptions`/`UpdateDIDOriginalOptions` (`@originals/sdk`) now accept a `VerificationMethodInput` shape whose `controller` is optional. Omitting it lets `didwebvh-ts` derive the correct value; the returned `DIDDocument`'s `VerificationMethod.controller` is unaffected and remains required.
  - `createDIDWithTurnkey` (`@originals/auth`) and `buildUserWebVHDid` (`@originals/landing`) now omit `controller` entirely instead of passing `''`.

- 4fd2969: Reject non-string or malformed OTP codes and invalid supplied P-256 public keys locally before claiming a verification session or consuming its attempt budget. Preserve valid compressed and uncompressed hex keys, and generate a fallback key only when no key is supplied. Apply the same validation to the OTP encryption helper, with structured input errors that contain no OTP or key material.
- d29a9d5: Reject non-Ed25519 or missing update account curves in createDIDWithTurnkey with an actionable StructuredError before constructing the signer or creating a DID.
- b1fd4c8: **Fix (regression of #341/#356, identity-fork): `getOrCreateTurnkeySubOrg`'s sub-org lookup no longer treats a generic transport error as "no existing sub-org."** `isDefinitiveNotFound` previously fell through to `createSubOrganization` on gRPC code `5` (NOT_FOUND) **or** any lookup error whose message matched `/not[ _-]?found|does not exist/i`. That message-substring match also matched errors unrelated to Turnkey's own not-found response — a plain-text `404 Not Found` from a routing/proxy layer, for example — silently minting a duplicate sub-organization (the user's stable identity) for an email that already had one.

  `isDefinitiveNotFound` now trusts only the strongly-typed `code === 5` evidence (still walking a wrapped `cause` chain). `@turnkey/http`'s `TurnkeyRequestError` always carries a numeric `code` parsed from Turnkey's own JSON error body, so a genuine not-found response is never missing it; an unrelated transport/routing failure throws a plain `Error` with no `code` and is now correctly rethrown instead of authorizing creation.

- 81cee2d: **Client-side `initOtp` now normalizes email (trim + lowercase) before calling Turnkey**, matching the server flow (#737).

  Turnkey sub-org lookup filters on the exact `contact` string. `getOrCreateTurnkeySubOrg`/`initiateEmailAuth` already normalized email before every server-side Turnkey call for that reason, but the direct client `initOtp` helper sent the caller-supplied email through verbatim — so a user could be routed to two different Turnkey sub-orgs for differently-cased/padded spellings of the same mailbox. `normalizeEmail` now lives in an isomorphic `packages/auth/src/email.ts`, re-exported from `server/turnkey-client.ts` for compatibility.

- cda2abb: **`createOptionalAuthMiddleware` is now exported from `@originals/auth/server`** (#730).

  It was implemented and documented in `server/middleware.ts` (and in `server/index.ts`'s own module doc comment) alongside `createAuthMiddleware`, but only `createAuthMiddleware` was actually re-exported from the package's public entry point. `import { createOptionalAuthMiddleware } from '@originals/auth/server'` resolved to `undefined` at runtime, forcing consumers onto the undocumented deep-import path `@originals/auth/server/middleware` instead of the package's stable public surface.

- e7a8fd1: **Fix: `verifyEmailAuth` no longer loses failed-attempt counts with a shared `SessionStorage`.** It read the session before `claimForVerification` and charged the failed attempt against that pre-claim snapshot. With a store whose `get` returns a copy (Redis, SQL), a guess that claimed after an earlier failure had persisted wrote back the stale `otpAttempts`, so concurrent guesses could keep resetting the counter and bypass `MAX_OTP_ATTEMPTS`. The session is now re-read after a successful claim and that snapshot drives every check and the attempt count; a session that disappears or expires in between fails as `AUTH_SESSION_INVALID` / `AUTH_SESSION_EXPIRED` without calling Turnkey. A session missing its `otpId` or encryption target bundle is now deleted when rejected. `createInMemorySessionStorage` was not affected.
- 1ee9941: **`getOrCreateTurnkeySubOrg` now repairs missing required account roles in an existing sub-org's wallet(s), not just a totally missing wallet** (#784).

  Previously, the existing-sub-org branch of `getOrCreateTurnkeySubOrgUnlocked` only checked whether the sub-org had _a_ wallet at all (`walletCount > 0`); it never checked whether that wallet actually carried all three required accounts (`bitcoin-auth`, `did-assertion`, `did-update`). A sub-org whose wallet was missing one or more of those roles — for example from a partial provisioning failure, or from external tooling that added a wallet without the full account layout — stayed incomplete on every login, unlike the client-side `ensureWalletWithAccounts`, which already checked per-role completeness.

  `getOrCreateTurnkeySubOrg` now enumerates accounts across all of the sub-org's wallets, computes which required roles are missing sub-org-wide (a role satisfied in any wallet counts as present), and adds any globally-missing role in place on one deterministic wallet — never duplicating a role that already exists elsewhere in the sub-org, and never minting a replacement sub-org. If enumerating any wallet's accounts fails, the repair is skipped for that login (fails soft) rather than risk inferring a role absent from incomplete data.

- ab68c2a: **`getOrCreateTurnkeySubOrg` now repairs a stale pre-#748 Ethereum-formatted Bitcoin auth-key account in place, and no longer swallows a transient wallet-check failure into a false "login succeeded" result** (#749, #805).

  The existing-sub-org account-role repair added for #784 matched a required role by `curve` + `path` alone, so a sub-org provisioned before #748's fix — which still carries a `CURVE_SECP256K1` account at the Bitcoin auth-key path with the old `ADDRESS_FORMAT_ETHEREUM` — was wrongly treated as already having the `bitcoin-auth` role and never repaired. The comparison now also requires `addressFormat` to match, consistent with `turnkey-roles.ts`'s `getKeyByRole`, so the corrected `ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR` account is added in place (Turnkey accounts are immutable, so the stale account is left alongside it, not replaced).

  Separately, the wallet-existence check (`getWallets`) in the same function caught **any** error — network blip, timeout, rate limit — and returned the existing sub-org ID as if a wallet had been found, without creating/repairing anything and without surfacing the failure. `getWallets` has no legitimate not-found case (a walletless sub-org is a successful empty `{ wallets: [] }` response), so any thrown error now propagates as a `StructuredError` instead.

- 5d84970: Fix `ensureWalletWithAccounts` duplicating canonical Turnkey accounts (`bitcoin-auth`, `did-assertion`, `did-update`) that already exist in a different wallet within the same sub-org (#765).

  The function only checked `wallets[0].accounts` when deciding which required roles were missing. If a sub-org had multiple wallets and a role already existed in a wallet other than the first, it was wrongly treated as missing, and a brand-new, differently-keyed duplicate account was created in `wallets[0]`. Since `getKeyByRole`/`getKeyByCurve` resolve roles across every wallet in the sub-org, this could cause downstream lookups to silently diverge from whichever key was actually enrolled elsewhere (e.g. bound into a DID document's verification methods).

  Missing roles are now computed against every wallet's accounts (`wallets.flatMap`), matching how `getKeyByRole` already scans the whole sub-org.

- 5cf9837: **`getKeyByRole` selects a Turnkey wallet account by curve + exact derivation path, distinguishing the DID assertion-key from the update-key** (#744).

  `getKeyByCurve(wallets, 'CURVE_ED25519')` always returned the first matching account, so it could never reach the second of the package's two `CURVE_ED25519` accounts (assertion-key at `m/44'/501'/0'/0'`, update-key at `m/44'/501'/1'/0'`). `ensureWalletWithAccounts` had the same blind spot at the completeness-check layer: it counted accounts per curve, so a wallet with two Ed25519 accounts at the _wrong_ paths was miscounted as already complete.

  Added `getKeyByRole(wallets, role)` and the exported `TURNKEY_ACCOUNT_ROLES` table (`'bitcoin-auth' | 'did-assertion' | 'did-update'`, each with its curve/path/address format) as the source of truth for both `createWalletWithAccounts` and `ensureWalletWithAccounts`, which now check each required role by exact path instead of by curve count. `getKeyByCurve` is unchanged and still supported.

- 8710817: **Fixed a TOCTOU race in `getOrCreateTurnkeySubOrg` that could mint two Turnkey sub-organizations for one email** (#728).

  Two concurrent calls for the same brand-new email (two tabs completing OTP verification close together, or a client retry overlapping an in-flight request) could both observe an empty sub-org lookup and both create a sub-organization, forking the user's identity. `getOrCreateTurnkeySubOrg` now serializes its lookup-then-create sequence per normalized email via a new `SubOrgLock`. The default is an in-process lock (`createInProcessSubOrgLock`), sufficient for a single server instance; multi-instance deployments should inject a distributed `SubOrgLock` (e.g. Redis-backed) via `verifyEmailAuth`'s new `subOrgLock` option or directly as `getOrCreateTurnkeySubOrg`'s third argument.

- e9b354a: **Added a compile-time guard against the positional-argument doc drift #716 found in the low-level Turnkey client helpers.**

  No published code changed — `@originals/auth/client`'s `fetchUser`, `fetchWallets`, `createWalletWithAccounts`, and `ensureWalletWithAccounts` already require an explicit `subOrgId` argument. The package had no test that compiled the documented usage against the installed export map, so a future signature change (or a doc correction that silently regresses) could recur unnoticed, exactly as it did for #716.

  `typecheck:public` now compiles `tests/types/public-client-api.ts` against `@originals/auth`'s built `dist` — exercising every low-level Turnkey client function's documented call shape, plus `@ts-expect-error` assertions that the previously-documented `(client, onExpired?)` shape must not type-check. Wired into CI's `esm-importable` job alongside the SDK's equivalent `typecheck:public` step.

- 09968d0: **`TurnkeyDIDSigner.getVerificationMethodId()` now returns the canonical `did:key:{multibase}#{multibase}` form instead of a bare `did:key:{multibase}` with no fragment** (#872).

  `CredentialManager.signCredentialWithExternalSigner` and `MultiSigManager` stamp `signer.getVerificationMethodId()` verbatim onto `proof.verificationMethod`, and `documentLoader.resolveDID`'s offline did:key fast path only resolves a `did:key:` DID when a `#fragment` is present. Without it, a credential or MultiSig contribution signed through the exported `TurnkeyDIDSigner` as an `ExternalSigner` signed successfully but could never be verified. `getVerificationMethodId()` now reuses the same `canonicalDidKeyVm()` helper every other did:key verification-method ID in the codebase already uses.

- 0c68847: **Turnkey session-expiry detection no longer false-positives on an error code numerically prefixed by `16`** (#800).

  `withTokenExpiration()` detected an expired session with `errorStr.includes('"code":16')` — an unanchored substring match against serialized error text, not a check that the `code` field equals `16`. Any error whose `code` merely started with the digits `16` (e.g. `160`, `1601`) was misclassified as session expiry: the real error was discarded, replaced with `TurnkeySessionExpiredError`, and `onExpired()` fired for an error unrelated to authentication. `withTokenExpiration()` now walks the error (and its `cause` chain) structurally and only treats an exact `code === 16` (or `"16"`) as the gRPC `UNAUTHENTICATED` marker; the two textual markers (`api_key_expired`, `expired api key`) are unchanged.

- 5042f63: **`turnkeySignBytes` now validates the r/s component boundary, not just the aggregate signature length** (#688).

  `turnkeySignBytes` stripped `0x` from Turnkey's returned `r` and `s` hex strings separately, then concatenated them and checked only `signature.length !== 64`. A short `r` paired with a correspondingly long `s` (or vice versa) still totals 64 bytes, so the boundary itself was never verified — the mis-split bytes were silently accepted as an apparently-valid 64-byte Ed25519 signature. `cleanR` and `cleanS` are now each individually required to be exactly 32 bytes (64 hex chars) before concatenation.

- 38fbaf4: **`TurnkeyDIDSigner`'s session-expiry detection no longer throws an unrelated `TypeError` and masks the real error for circular-shaped rejections** (#696).

  `asExpiryError()` called `JSON.stringify(error)` with no guard, so any rejected Turnkey/network error containing a circular reference (a common shape for wrapped fetch errors or `cause` chains) made `JSON.stringify` itself throw — that unrelated `TypeError` propagated to the caller instead of the original error, silently defeating expiry detection. `sign()`/`signBytes()` now rely solely on `withTokenExpiration()` (which already guards its own error-text extraction) as the single expiry boundary, and `collectErrorText()` now captures a plain object's `.message` before attempting `JSON.stringify`, so a circular rejection's diagnostic text is never discarded.

- 3479bb8: **`ensureWalletWithAccounts` no longer silently returns an incomplete wallet after repairing missing account roles** (#898). After calling `createWalletAccounts` to repair a missing role (e.g. the Bitcoin auth-key or a DID-signing key), the function re-read wallet accounts exactly once, with no delay and no retry, and returned whatever it got — even if the newly created role wasn't visible yet on that single read (a realistic eventual-consistency lag). No error was raised, so a caller had no signal that provisioning was actually incomplete, and could proceed into DID creation with a partial key set, or retry later and risk creating a duplicate account for a role whose earlier write simply hadn't propagated yet.

  The post-repair re-read is now polled with a bounded number of retries (5 attempts, 500ms apart), and the function throws an explicit error naming the still-missing role(s) if they remain invisible once that window elapses, instead of returning silently.

- ca4a221: Retry successful wallet reads with bounded backoff when a newly created wallet is not yet visible. Report the created wallet ID on exhaustion without implying creation failed, and propagate authentication and backend errors without retrying creation or failed reads.
- Updated dependencies [335abad]
- Updated dependencies [fdd5478]
- Updated dependencies [66a9944]
- Updated dependencies [d1a26af]
- Updated dependencies [42cad62]
- Updated dependencies [06d1c46]
- Updated dependencies [5ca171e]
- Updated dependencies [2cb1f4f]
- Updated dependencies [12f605e]
- Updated dependencies [041cb9b]
- Updated dependencies [335469a]
- Updated dependencies [b210e71]
- Updated dependencies [013a6fe]
- Updated dependencies [d813344]
- Updated dependencies [b545475]
- Updated dependencies [ff2d1b3]
- Updated dependencies [8f02af6]
- Updated dependencies [0e32a48]
- Updated dependencies [c7a203e]
- Updated dependencies [a7d202b]
- Updated dependencies [bc129c7]
- Updated dependencies [46337ab]
- Updated dependencies [3d28934]
- Updated dependencies [5dfc23c]
- Updated dependencies [b4f135d]
- Updated dependencies [11c28f3]
- Updated dependencies [038895a]
- Updated dependencies [dd84574]
- Updated dependencies [730f295]
- Updated dependencies [ac36070]
- Updated dependencies [da6b08e]
- Updated dependencies [75617cb]
- Updated dependencies [9755861]
- Updated dependencies [24bfe5d]
- Updated dependencies [a4a71f8]
- Updated dependencies [80ccadf]
- Updated dependencies [077de93]
- Updated dependencies [1e57416]
- Updated dependencies [6bf9f2d]
- Updated dependencies [1ad78a0]
- Updated dependencies [de27b01]
- Updated dependencies [5058a34]
- Updated dependencies [9b618c1]
- Updated dependencies [e6845d1]
- Updated dependencies [e5d05ea]
- Updated dependencies [0d30394]
- Updated dependencies [dca3854]
- Updated dependencies [0330f30]
- Updated dependencies [60443e3]
- Updated dependencies [bb60bde]
- Updated dependencies [29290f7]
- Updated dependencies [fa89b5b]
- Updated dependencies [32625b5]
- Updated dependencies [139d9be]
- Updated dependencies [568db50]
- Updated dependencies [3ed7af1]
- Updated dependencies [af7051f]
- Updated dependencies [244cae1]
- Updated dependencies [75f31c2]
- Updated dependencies [eb8869e]
- Updated dependencies [8705bfc]
- Updated dependencies [131e1ae]
- Updated dependencies [c70b789]
- Updated dependencies [902de9c]
- Updated dependencies [669e2b3]
- Updated dependencies [810ec9a]
- Updated dependencies [b9ed515]
- Updated dependencies [b16ca13]
- Updated dependencies [67891d3]
- Updated dependencies [320b8e2]
- Updated dependencies [594be92]
- Updated dependencies [f246be0]
- Updated dependencies [5153d0d]
  - @originals/sdk@4.0.0

## 3.0.0

### Major Changes

- **Remote custody can author assets.** Turnkey, KMS, HSM, MPC and passkey backends never export a private key, and the SDK's authorship path required one — `KeyStore.getPrivateKey(vmId)`. Any such backend was locked out of the recommended tier entirely.

  **One signer interface.** `OriginalsSigner` is three members — `verificationMethodId`, `publicKeyMultibase`, and `signBytes(bytes)` — the smallest capability a custody backend can offer. The SDK canonicalizes and hashes; the signer only ever signs opaque bytes. It is accepted on `OriginalsConfig` and per call on `createAsset`, `publishToWeb`, `inscribeOnBitcoin`, `rotateBtcoKeys`, `authorizeSigner` and `addResourceVersion`. Adapters convert in both directions: `signerFromKeyPair`, `signerFromKeyStore`, `signerFromExternalSigner`, `toCelSigner`, `toExternalSigner`.

  **The provenance leak this closes:** `publishToWeb` accepted an `ExternalSigner`, but that signer only authorized the did:webvh log. The asset's own CEL `migrate` event was appended by a keyStore-only path, so a remote-custody caller doing everything right got a published asset whose provenance log was **missing its migration event** — reported as success. Every authorship append now accepts the configured or per-call signer.

  **One signing-input namespace.** `signingInput` exposes the four (and only four) preimages this SDK signs: `celEvent`, `witness`, `didWebvh`, `credential`. Every internal signing path routes through it, so "which bytes do I sign?" has one answer and the four cannot drift apart. Note `didWebvh` delegates to didwebvh-ts's own `prepareDataForSigning` — it is `sha256(JCS(proof)) || sha256(JCS(document))`, not JCS over the pair, and reimplementing it by hand produces proofs that never verify.

  **A conformance harness.** `assertSignerConformance(signer)` lets any custody backend prove its implementation before shipping, and `MockRemoteSigner` (signBytes-only, no key export) exercises the full create → publish → inscribe → rotate flow in the SDK's own tests. No test previously exercised a non-exporting backend, which is why this went unnoticed.

  **`@originals/auth`:** both Turnkey signers now implement `signBytes` via a single shared `turnkeySignBytes` primitive, so a Turnkey key satisfies `OriginalsSigner` and can author CEL events and sign credentials — not only did:webvh logs. The byte-level code already existed, duplicated across the two signers and kept in sync by comment.

  Custody is explicit at every append: a signer passed to `createAsset` is **not** retained on the asset. An asset holding a signer handed to it once is hidden state that outlives the call — a session-backed signer (a Turnkey browser session) goes stale inside it, and a serialized/reloaded asset has no binding at all. Later appends take a signer per call, or fall back to `config.signer`.

  **Breaking:**

  - `@originals/auth`'s root entry no longer re-exports `./server`. Importing so much as a type from `@originals/auth` pulled `jsonwebtoken`, `@turnkey/sdk-server` and Express into browser bundles. Import server utilities from `@originals/auth/server` and client utilities from `@originals/auth/client`; the root now exports types plus `turnkeySignBytes`, which is browser-safe (hex via @noble/hashes, no `Buffer`).
  - `ExternalSigner`, `CelSigner`, and using a `KeyStore` as a signing authority are deprecated in favour of `OriginalsSigner`. They still work; removal is a later release. `KeyStore` remains supported for key _persistence_.
  - The Turnkey signers' "no signature returned" error message is now one shared string naming the expected `activity.result.signRawPayloadResult.{r,s}` shape.

  Also adds `base58AddressToEd25519Multikey`: custody backends hand back an address, not a Multikey, and Turnkey's Ed25519 accounts use `ADDRESS_FORMAT_SOLANA` — base58 of the raw key, with no multicodec header. Building `did:key:${address}` from it yields something that is not a valid did:key, a mistake consumers kept re-deriving.

### Patch Changes

- ca08a25: Update @turnkey/sdk-server to 8.3.0.
- acff3a3: **Turnkey signing was rejected outright on Ed25519 keys.**

  `turnkeySignBytes` sent `hashFunction: 'HASH_FUNCTION_NO_OP'`. Turnkey refuses that combination:

  ```
  cannot use hash function NoOp to produce ed25519 signature
  ```

  Ed25519 takes the message itself and hashes internally as part of the signature scheme, so there is no pre-hash slot to declare as a no-op — that enum belongs to the ECDSA curves, where a caller may hand over a digest. The correct value is `HASH_FUNCTION_NOT_APPLICABLE`, which expresses the same intent the code always had: the SDK owns canonicalization, and Turnkey signs the given bytes verbatim.

  This is the one place Turnkey actually signs, so it blocked **every** Turnkey-authored signature: creating an Original on the deployed landing page, and signing a user's `did:webvh` log.

  The existing test captured the call's parameters but never asserted `hashFunction`, so a local stub accepted a value the real API rejects. It now asserts it.

- Updated dependencies [d7da21e]
- Updated dependencies [d7da21e]
- Updated dependencies [a8fe507]
- Updated dependencies [d7da21e]
- Updated dependencies [d7da21e]
- Updated dependencies [d7da21e]
- Updated dependencies [09ce651]
- Updated dependencies [d7da21e]
- Updated dependencies [71c81f3]
- Updated dependencies [6e6bc3d]
- Updated dependencies [6e6bc3d]
- Updated dependencies [e718ad4]
- Updated dependencies [d7da21e]
- Updated dependencies [6e6bc3d]
- Updated dependencies [08b9f17]
- Updated dependencies [6e6bc3d]
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @originals/sdk@3.0.0

## 3.0.0-next.0

### Major Changes

- ed327d9: **Remote custody can author assets.** Turnkey, KMS, HSM, MPC and passkey backends never export a private key, and the SDK's authorship path required one — `KeyStore.getPrivateKey(vmId)`. Any such backend was locked out of the recommended tier entirely.

  **One signer interface.** `OriginalsSigner` is three members — `verificationMethodId`, `publicKeyMultibase`, and `signBytes(bytes)` — the smallest capability a custody backend can offer. The SDK canonicalizes and hashes; the signer only ever signs opaque bytes. It is accepted on `OriginalsConfig` and per call on `createAsset`, `publishToWeb`, `inscribeOnBitcoin`, `rotateBtcoKeys`, `authorizeSigner` and `addResourceVersion`. Adapters convert in both directions: `signerFromKeyPair`, `signerFromKeyStore`, `signerFromExternalSigner`, `toCelSigner`, `toExternalSigner`.

  **The provenance leak this closes:** `publishToWeb` accepted an `ExternalSigner`, but that signer only authorized the did:webvh log. The asset's own CEL `migrate` event was appended by a keyStore-only path, so a remote-custody caller doing everything right got a published asset whose provenance log was **missing its migration event** — reported as success. Every authorship append now accepts the configured or per-call signer.

  **One signing-input namespace.** `signingInput` exposes the four (and only four) preimages this SDK signs: `celEvent`, `witness`, `didWebvh`, `credential`. Every internal signing path routes through it, so "which bytes do I sign?" has one answer and the four cannot drift apart. Note `didWebvh` delegates to didwebvh-ts's own `prepareDataForSigning` — it is `sha256(JCS(proof)) || sha256(JCS(document))`, not JCS over the pair, and reimplementing it by hand produces proofs that never verify.

  **A conformance harness.** `assertSignerConformance(signer)` lets any custody backend prove its implementation before shipping, and `MockRemoteSigner` (signBytes-only, no key export) exercises the full create → publish → inscribe → rotate flow in the SDK's own tests. No test previously exercised a non-exporting backend, which is why this went unnoticed.

  **`@originals/auth`:** both Turnkey signers now implement `signBytes` via a single shared `turnkeySignBytes` primitive, so a Turnkey key satisfies `OriginalsSigner` and can author CEL events and sign credentials — not only did:webvh logs. The byte-level code already existed, duplicated across the two signers and kept in sync by comment.

  Custody is explicit at every append: a signer passed to `createAsset` is **not** retained on the asset. An asset holding a signer handed to it once is hidden state that outlives the call — a session-backed signer (a Turnkey browser session) goes stale inside it, and a serialized/reloaded asset has no binding at all. Later appends take a signer per call, or fall back to `config.signer`.

  **Breaking:**

  - `@originals/auth`'s root entry no longer re-exports `./server`. Importing so much as a type from `@originals/auth` pulled `jsonwebtoken`, `@turnkey/sdk-server` and Express into browser bundles. Import server utilities from `@originals/auth/server` and client utilities from `@originals/auth/client`; the root now exports types plus `turnkeySignBytes`, which is browser-safe (hex via @noble/hashes, no `Buffer`).
  - `ExternalSigner`, `CelSigner`, and using a `KeyStore` as a signing authority are deprecated in favour of `OriginalsSigner`. They still work; removal is a later release. `KeyStore` remains supported for key _persistence_.
  - The Turnkey signers' "no signature returned" error message is now one shared string naming the expected `activity.result.signRawPayloadResult.{r,s}` shape.

  Also adds `base58AddressToEd25519Multikey`: custody backends hand back an address, not a Multikey, and Turnkey's Ed25519 accounts use `ADDRESS_FORMAT_SOLANA` — base58 of the raw key, with no multicodec header. Building `did:key:${address}` from it yields something that is not a valid did:key, a mistake consumers kept re-deriving.

### Patch Changes

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

## 2.0.0

Initial published release. Version 2.0.0 was tagged internally but never published to npm, so all changes accumulated during the pre-release stabilization effort ship as part of this initial 2.0.0 release. The consumed changesets are consolidated below.

### Major Changes

- 366c399: Make the published packages importable under Node's ESM resolver.

  The built `dist` previously emitted extensionless relative imports and
  attribute-less JSON imports, which Node ESM rejects — so the packages could not
  be imported by npm consumers. All relative imports now carry explicit
  `.js`/`/index.js` extensions, JSON imports use `with { type: "json" }`, and both
  packages compile under `moduleResolution: "NodeNext"` so the compiler enforces
  correct ESM specifiers going forward.

  **Breaking:** `engines.node` is raised to `>=20.10.0` (required for JSON import
  attributes; `@originals/auth` also requires it transitively via `@originals/sdk`).
  Released as a major version to reflect the raised runtime floor.

  The SDK release also includes opt-in `did:webvh` pre-rotation key support
  (`createDIDWebVH`/`rotateDIDWebVHKeys` `prerotation` option, returned
  `nextKeyPair`), with guards that reject misuse on pre-rotation chains.

- 5981ec2: Migrate the OTP verification flow to the Turnkey v6 encrypted-bundle API (`@turnkey/sdk-server` 5.3.0 → 6.1.1, new dependency `@turnkey/crypto`).

  Turnkey v6 replaced plaintext OTP verification: `initOtp` (ACTIVITY_TYPE_INIT_OTP_V3) now returns an `otpEncryptionTargetBundle` (a signed bundle containing a target encryption key), and `verifyOtp` (ACTIVITY_TYPE_VERIFY_OTP_V2) requires an `encryptedOtpBundle` — the OTP code plus a client-generated P-256 public key, HPKE-encrypted to that target key — instead of the previous plaintext `otpCode` field. The previous release preserved the pre-v6 plaintext call shape behind a type cast, which type-checked but could not succeed against the real Turnkey v6 API.

  Changes:

  - New `encryptOtpCode()` helper (exported from both `@originals/auth/client` and `@originals/auth/server`) wraps `encryptOtpCodeToBundle` from `@turnkey/crypto`: it verifies the enclave signature on the target bundle, generates an ephemeral P-256 key pair when none is supplied, and produces the `encryptedOtpBundle` for `verifyOtp`.
  - `initiateEmailAuth()` (server) now captures `otpEncryptionTargetBundle` from the init-OTP result and stores it on the auth session (`EmailAuthSession.otpEncryptionTargetBundle`); it fails fast if Turnkey does not return one.
  - `verifyEmailAuth()` (server) encrypts the user's OTP code to the session's target bundle and submits it as `encryptedOtpBundle`. Its signature gains an optional trailing `options` parameter (`dangerouslyOverrideSignerPublicKey`, for tests/non-production Turnkey environments only) and its result now includes the Turnkey `verificationToken` (optional field, for use with OTP_LOGIN).

  BREAKING (client module):

  - `initOtp()` now returns `{ otpId, otpEncryptionTargetBundle }` instead of a bare `otpId` string.
  - `completeOtp()` now requires the `otpEncryptionTargetBundle` from `initOtp` as its fifth argument (plus optional `CompleteOtpOptions`), and returns `{ verificationToken, subOrgId, publicKey, privateKey? }` — the key pair the verification token is bound to, needed for a subsequent `otpLogin`.

  Sessions created before this release (without a stored `otpEncryptionTargetBundle`) cannot be verified and will be asked to request a new code.

### Patch Changes

- Updated dependencies [366c399]
  - @originals/sdk@2.0.0
- cf78590: Pass a plain `Uint8Array` (not a `Buffer`) to multibase encoding in the Turnkey signers. Under stricter Node/Bun typings `Buffer` is a `Buffer<ArrayBufferLike>` that TypeScript will not assign to a `Uint8Array<ArrayBufferLike>` parameter, breaking the build (`TS2345`). `Uint8Array.from(Buffer.from(hex, 'hex'))` is equivalent at runtime and type-clean.
- fca65b5: Repo-level infra hygiene from the batch of 11 localized bug/security/infra fixes (#294): remove a committed TLS private key and ignore `*.pem`/`*.key`; `test:ci` uses `pipefail` so failing tests aren't masked by coverage; prune dead dependencies. No `@originals/auth` source changes — republished so the package reflects the cleaned-up repo. (The SDK-side fixes from this batch are recorded in `packages/sdk/CHANGELOG.md` under 2.0.0.)
- 20df4be: Bump the noble-crypto dependency group (`@noble/curves` 1.6→2.2, `@noble/ed25519` 2→3.1, `@noble/secp256k1` 2→3.1, `@scure/base` 1.1→2.2, `@scure/btc-signer` 1.8→2.2) and fix the internal breakage from their v2/v3 export and API changes. For `@originals/auth`, the Turnkey signer is updated for `@noble/ed25519`/`@noble/secp256k1` v3's rename of `utils.randomPrivateKey()` to `utils.randomSecretKey()` and the move of synchronous hash configuration from the (now frozen) `utils`/`etc` objects to the new writable `hashes` object (`hashes.sha256`, `hashes.hmacSha256`, `hashes.sha512`). No public API changes. (The SDK-side adaptations are recorded in `packages/sdk/CHANGELOG.md` under 2.0.0.)
- 122139b: Ship `README.md` and `LICENSE` (MIT) in the published npm tarball; previously the package included neither, so the npm page rendered blank and `"license": "MIT"` shipped without license text. (The same fix for `@originals/sdk`, plus its `"default"` export condition, is recorded in `packages/sdk/CHANGELOG.md` under 2.0.0.)
- 06644c5: Batch of verification, event, and provider hardening fixes:

  - `Verifier.verifyCredentialMultiSig` now enforces the credential validity window and fails closed on (or resolver-checks) a declared `BitstringStatusListEntry`, so expired/revoked multi-sig credentials no longer verify (#340).
  - `CredentialManager.verifyCredentialWithStatus` returns `verified: false` for revoked/suspended credentials; `checkRevocationStatus`/`isRevoked` reject a status list whose `id` doesn't match the credential's reference and document that they trust the caller-supplied list (#345).
  - Status-list trust validation (id match, proof verification, issuer equality) is now a single shared implementation used by both Verifier and CredentialManager (#301).
  - Fail-closed signing refusals key on typed `StructuredError` codes (`ISSUER_BINDING_MISMATCH`, `VM_RETIRED`) instead of error-message wording (#309).
  - `asset:migrated`/`asset:transferred` are mirrored onto the LifecycleManager emitter so `sdk.lifecycle.on(...)` subscriptions and built-in EventLogger metrics fire; `verification:completed` and `batch:progress` are now actually emitted (#346, #352).
  - `Logger.sanitize` is cycle-safe and cannot crash the calling operation; `FileLogOutput` retains batches on failed writes and flushes on process exit (#349, #352).
  - `SignetProvider.estimateFee` fails loudly instead of fabricating an inverted fallback rate; regtest commit change outputs accept testnet-format addresses like the transfer path; cost quotes apply the `MAX_REASONABLE_FEE_RATE` cap (#351).
  - QuickNodeProvider: optional `expectedNetwork` chain check, explicit `contentEncoding` option, txid/inscriptionId/sat shape validation before provenance, content-unavailable distinguished from nonexistent, endpoint token redacted from errors (#350).
  - Prerelease versions no longer pass the pichu/cleffa release gates; Multikey decode validates key lengths; 33-byte "prefixed Ed25519" keys are rejected instead of guessed at; JWT verification pins HS256 and requires a ≥32-char secret (#352).
  - Cross-network `did:btco` guard runs before the DID cache read; LRU eviction no longer deletes entries from persistent cache storage; `addResourceVersion` types `newContent` as `string` (#312, #313, #311).

- 88d6eac: Turnkey auth hardening: stop identity forking in `getOrCreateTurnkeySubOrg` (normalize email before all filters, repair walletless sub-orgs in place instead of minting a new sub-organization, pick deterministically when multiple sub-orgs match, rethrow transient lookup errors instead of creating duplicates); defer sub-org/wallet provisioning until after OTP verification so unauthenticated send-OTP calls create no billable resources (callers must rate-limit the initiate endpoint; session `subOrgId` is now only set post-verification); accept a client-supplied `publicKey` in `verifyEmailAuth`/client `verifyOtp` so the verification-token private key never leaves the browser; destroy sessions after 5 failed OTP attempts; fix dead session-expiry detection in `withTokenExpiration` (match on `error.message` and walk the `cause` chain); run `initOtp`/`verifyOtp` under the same (parent) org context per Turnkey's documented flow; stop logging raw emails and sub-org IDs.
- cb16f02: Bump the `@turnkey/sdk-server` runtime dependency from 6.1.1 to 7.0.0.
- Updated dependencies [9d3c682]
- Updated dependencies [6ef2c47]
- Updated dependencies [c23eeef]
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
- Updated dependencies [7d02dc8]
- Updated dependencies [a07ff36]
- Updated dependencies [dbe3f10]
- Updated dependencies [0e6674a]
- Updated dependencies [dbe3f10]
- Updated dependencies [9e61052]
- Updated dependencies [a4e440f]
- Updated dependencies [9dddc24]
- Updated dependencies [e571787]
- Updated dependencies [ae15309]
- Updated dependencies [06644c5]
- Updated dependencies [a546db1]
- Updated dependencies [2443dc2]
- Updated dependencies [be4c5b6]
- Updated dependencies [f10e112]
- Updated dependencies [a546db1]
- Updated dependencies [7f4c42d]
  - @originals/sdk@2.0.0
