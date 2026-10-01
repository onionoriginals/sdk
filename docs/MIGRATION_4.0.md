# Upgrading to Originals SDK 4 / CEL 2

SDK 3.0.0 is already published. This checkout prepares the next major versions:
`@originals/sdk` 4 and `@originals/cel` 2. This guide is not a publication notice.
The public identity string and SDK envelope fields change, so this update is
not patch-compatible. The `originals/cel/3` signed representation and `/v3`
subpath names remain unchanged.

An Original still records authenticated controller claims about files and their
versions. Verification still checks history, available file bytes and the
relevant publication evidence. The identity correction separates that asset's
genesis commitment from DID-method identity.

## Update public identifiers and saved-container consumers

| SDK 3 | SDK 4 |
| --- | --- |
| `asset.id` is `did:cel:<genesis-multihash>` | `asset.id` is `ni:///sha-256;<raw-genesis-hash>` |
| `state.didCel` is the primary genesis identifier | Use `state.assetId`; `state.didCel` is removed |
| Initial `state.alias` is the Originals `did:cel` spelling | Initial `state.alias` is canonical `ni`; hosted/Bitcoin aliases continue to change on migration |
| Envelope `version: 3`, `assetDid` | Envelope `version: 4`, `assetId` |
| `deriveDid(genesisEvent)` | `deriveAssetId(genesisEvent)`; `deriveDid` is removed |
| `expectedDid` verification option | `expectedAssetId`; `expectedDid` is removed |
| `parseAssetDid(alias)` returning `{ method: 'cel' \| 'webvh' \| 'btco' }` | `parseAssetAlias(alias)` returning `{ layer: 'cel' \| 'webvh' \| 'btco' }` |

The new URI is defined by [RFC 6920](https://www.rfc-editor.org/rfc/rfc6920).
For Originals it carries the complete SHA-256 of the JCS genesis event as
canonical unpadded base64url. The suffix omits the old multibase/multihash header.
No authority host, query or fragment is accepted. The event and resource
multihashes, chain links and signatures do not change.

Use the public helpers instead of slicing strings:

```ts
import {
  deriveAssetId, normalizeAssetId, sameAssetIdentity, assetDigest,
} from '@originals/sdk/cel';

const { asset, verification } = await sdk.lifecycle.loadAsset(savedSdk3Envelope);
const canonical = asset.id;
console.log(canonical === deriveAssetId(asset.celLog.log[0].event));
console.log(sameAssetIdentity(oldOriginals3AssetId, canonical));
const lookupKey = normalizeAssetId(oldOriginals3AssetId);
const unchangedGenesisMultihash = assetDigest(canonical);
const savedSdk4Envelope = asset.serialize(); // version: 4, assetId: canonical
```

`normalizeAssetId` accepts only canonical `ni` or the exact historical Originals
3 alias form. A successful conversion validates an identifier's encoding; it
must still be bound to authenticated genesis when loading an asset. It does
not convert arbitrary CCG method DIDs or establish a WebVH/Bitcoin binding.
`sameAssetIdentity` returns false for malformed or unrelated identities.
`assetIdFromDigest` is available when you already have the canonical event
multihash. Standalone integrations import these APIs from `@originals/cel/v3`.

## Read existing records without rewriting signed history

`loadAsset` and `parseAssetEnvelope` retain a strict SDK 3 envelope reader.
Version 3 requires historical `assetDid: 'did:cel:…'`; version 4 requires
canonical `assetId: 'ni:///sha-256;…'`. Both authenticate the same CEL 3 history
and reject a genesis mismatch. A container cannot mix these fields or add
unknown fields. Successful reads normalize the container to version 4.
Full loads also check resource attachments and publication evidence; partial
loads never bypass signatures or supplied-byte integrity.

Preserve original archives. Applications indexing by the old identifier should
add a canonical key or a verified alias lookup, then write new SDK 4 containers.
Do not update identity strings inside old signed migration entries, WebVH
method logs, proofs or inscriptions. Existing hosted paths, `alsoKnownAs`
bindings, prepared records and Bitcoin histories remain readable through
validated compatibility handling. Existing assets need no new genesis,
re-signing or reinscription. A new genesis would create a different asset.

`state.aliases` begins with canonical `ni` and can retain a historical Originals
3 alias encountered in authenticated signed migration history. Do not assume
the old spelling always occurs at a fixed array index. There is no dedicated
`state.didCel` field or `deriveDid` helper on this surface; when a fresh
genesis's historical spelling is genuinely needed (for example, to look up
storage recorded before this identity correction), reconstruct it explicitly
as `"did:cel:" + assetDigest(state.assetId)`.

## Update identity expectations and labels

Pass `expectedAssetId` to history/sat verification. The deprecated `expectedDid`
option is removed; a reader that authenticated old SDK 3 envelopes already
normalizes their identity to `expectedAssetId` before verifying, so no caller
needs to pass the historical spelling directly. Sat resolution still chooses
the accepted history from publication ordering before comparing the requested
identity.

`parseAssetDid` is renamed `parseAssetAlias`. It accepts `ni` under
`layer: 'cel'`, naming the Originals lifecycle stage rather than a DID method
(the previous `method` discriminator implied one). It still accepts the
historical `did:cel:` spelling when reading authenticated signed history; it
is not offered as new migration/authoring input. Prefer “asset identity” or
“Local CEL” in user interfaces.

Originals uses the generic CCG CEL application profile and standard JCS proof
suites. It does not implement the separate CCG `did:cel` DID method. This update
adds no heartbeat, witness, DID document or DID-method resolver. Independent
WebVH identity utilities and publication aliases retain their existing scope.

## What to verify in your integration

1. Load representative SDK 3 archives and confirm canonical identity, original
   signed events and proofs, and exact historical file bytes.
2. Update container consumers for `version: 4` / `assetId`, database lookup keys,
   labels and any string comparisons. Reject mismatched identities.
3. Exercise fresh WebVH and Bitcoin recovery for historical publications, and
   new publication with the same explicit custody and durable retry contract.
4. Update any caller of the removed `deriveDid`, `state.didCel`, `expectedDid`
   or `parseAssetDid` (now `parseAssetAlias`, with `layer` replacing `method`)
   before adopting this surface.

Controller rotation and deactivation, accepted Bitcoin ordering, complete
provider observations and sat possession rules are unchanged. Holding the sat
never grants authority to write creator claims. Pre-CEL-3 logs and earlier
custom proofs remain unsupported; see the historical
[SDK 3 migration guide](MIGRATION_3.0.md) for that earlier format boundary.
The exact contract is [Originals asset identity](../specs/originals-asset-identity.md).

## Sat resolution distinguishes pending from not-found, and gains independent cross-checks

`resolveSat()`/`resolveAssetFromSat()`/`did.resolveDIDWithMetadata()` now
return a `"pending"` status, distinct from `"not-found"`: an all-unconfirmed
sat (something broadcast, nothing yet at confirmation depth) resolves as
`"pending"` with the observed unconfirmed publication ids, instead of the
previous `"not-found"`. A caller that branches on every non-`"accepted"`
status as equivalent absence should add an explicit `"pending"` case if it
needs to distinguish "never published" from "published but not yet
confirmed." `did.resolveDID()` itself is unaffected in kind: it already threw
`ASSET_RESOLUTION_INCOMPLETE` for any non-`"accepted"`/non-`"not-found"`
status, and continues to for `"pending"`.

The accepted shape also gains three optional, independently-sourced
corroboration dimensions, all off by default: `OriginalsSDKOptions.independentEnumeration`
(a second `SatProvider` cross-checking Ordinals enumeration completeness and
current sat ownership) and `OriginalsSDKOptions.contentValidator` (for
example `createBitcoinCoreContentValidator`, cross-checking confirmed
inscription content/media type against a validating Bitcoin node). The
accepted result's `enumerationAssurance`, `ownershipAssurance`, and
`contentAssurance` read `"cross-checked"` only when the corresponding source
was configured and agreed; otherwise `"provider-asserted"`, unchanged from
today. For enumeration, "agreed" means the independent index's reported ids
fully cover the primary snapshot's known publications for that sat, not
merely that it reported nothing extra (#909): an index that is honestly
behind the primary leaves assurance at `"provider-asserted"` for that round
without failing resolution. `trajectoryAssurance` is always `"not-independently-derived"` —
`ownership` remains a point-in-time snapshot, never a derivation of the
sat's historical transfer path. See
[docs/release/4.0.0-public-api.md](release/4.0.0-public-api.md) for the full
export list.

## Validation failures are typed errors with stable codes

Caller-input validation at the public DID, credential and hosted-publication
seams used to throw a bare `Error`. It now throws `StructuredError` (from
`@originals/sdk`) with a stable `.code` on the identity/credential utilities
(`createDIDWebVH`, `updateDIDWebVH`, `rotateDIDWebVHKeys`, `createDIDOriginal`,
`updateDIDOriginal`, `signCredential`, `signCredentialMultiSig`), and the
existing `CelError` `invalid` contract on `publishToWeb`. Message text is
unchanged, so `toThrow(/Invalid path segment/)`-style assertions keep passing;
prefer branching on `.code`. `updateDIDOriginal` also now throws
`WEBVH_UPDATE_DID_UNRESOLVED` where it used to return `did: ""`.

The full table is in
[docs/release/4.0.0-public-api.md](release/4.0.0-public-api.md#changed-validation-failures-throw-structurederror-with-stable-codes-786-828-914-756).
Codes follow `NAMESPACE_NOUN_STATE` (`WEBVH_UPDATE_KEY_INVALID`,
`WEBVH_PATH_SEGMENT_INVALID`, `WEBVH_RESULT_DOCUMENT_INVALID`,
`ED25519_KEY_LENGTH_INVALID`); no pre-release spelling of these codes
(`WEBVH_INVALID_PATH_SEGMENT`, `WEBVH_UPDATE_KEY_INVALID_MULTIKEY`) shipped.

## did:webvh domains are canonicalized; `paths` are decoded segments

Every authoring seam (`createDIDWebVH`, `migrateToDIDWebVH`,
`createDIDOriginal`/`updateDIDOriginal`, `publishToWeb`) now passes the
supplied domain through CEL's `canonicalizeWebVHDomain` (exported from
`@originals/sdk/cel`) before minting a DID or comparing it against an existing
hosted binding. It trims, lower-cases and returns the `URL#host` spelling: the
default `:443` is dropped and port leading zeros are removed, so
`example.com:443` mints the same portless DID as `example.com` and republishing
with `example.com:443` or `example.com:08080` matches the first publication.
`Example.COM` and `example.com` are one host on republish. Rejections happen at
the seam, before signing:

- Asset publication (`publishToWeb`) needs a fully qualified DNS host[:port].
  `localhost`, IP addresses, single-label hosts and malformed ports fail
  `INVALID_DOMAIN`; punycode/Unicode hosts fail `CEL_WEBVH_IDNA` (status
  `unsupported`), all as `CelError`.
- Identity seams also admit `localhost[:port]` for development. **Single-label
  hosts (`intranet`, `web:3000`) and IP addresses are now rejected by
  `createDIDWebVH`, `createDIDOriginal` and `updateDIDOriginal`** with
  `INVALID_DOMAIN` (IPs always failed there, uncoded, inside didwebvh-ts);
  punycode hosts fail `CEL_WEBVH_IDNA`. These are `CelError`s, which extend
  `StructuredError`; a blank domain still throws `StructuredError`
  `WEBVH_DOMAIN_REQUIRED`.

If you stored the raw string you passed, compare against the canonical form
(`URL#host`) or re-read the DID.

`paths` values are the decoded, human-readable segments, checked by one CEL
rule at every authoring seam (`createDIDWebVH`, `migrateToDIDWebVH`,
`createDIDOriginal` and so `@originals/auth`'s `createDIDWithTurnkey` slug,
`publishToWeb`): `paths` must be an array; each segment is a non-empty string,
not `.` or `..`, with no `/`, `\`, NUL, or leading/trailing whitespace, and is
well-formed UTF-16. A failure is `ASSET_WEBVH_PATH` (hosted) or
`WEBVH_PATH_SEGMENT_INVALID` (identity), raised before signing. Each segment is
then percent-encoded into the DID the way `parseAssetAlias` reads it back —
`hello world` → `hello%20world`, `~` → `%7E`, and `a:b` stays one segment
(`a%3Ab`). `createDIDOriginal` now encodes too; it previously passed segments
through verbatim. Do not pre-encode: a segment supplied as `hello%21world` is
encoded again (`hello%2521world`). The rule is exported from
`@originals/sdk/cel` as `isWebVHPathSegment` and `canonicalWebVHPaths`, the
encoder as `encodeWebVHPathSegment`. A first segment of `.well-known` (any
case) is reserved at authoring seams (`WEBVH_PATH_RESERVED` /
`ASSET_WEBVH_PATH_RESERVED`) because it would share `/.well-known/did.jsonl`
with the no-path default; readers still accept existing `.well-known` DIDs. A
republish that names the same decoded `paths` as the original publication is
accepted (previously any explicit `paths` on republish failed
`ASSET_WEBVH_BINDING`).

## `keyStore` is removed from the default SDK options

`OriginalsSDK.create({ keyStore })` now throws `SDK_OPTION_REMOVED`. The
option was accepted and validated but nothing the default SDK wires read it,
so custody configured this way minted assets that could not be signed.
Configure a `CelSigner` via `signer` (`createLocalSigner(...)` or your own
custody) instead; `KeyStore` and `signerFromKeyStore` remain exported for the
retained legacy lifecycle only.

## `@originals/auth` 4.0.0

- **`SessionStorage` is async-capable.** `get`/`set`/`delete`/`cleanup` may
  return a `Promise`, and the package awaits them. `isSessionVerified`,
  `getSession` and `cleanupSession` are now `async`: add `await` at every call
  site or you will receive a `Promise` where you had a value.
  `createInMemorySessionStorage` is unaffected.
- **`verifyEmailAuth` claims the session first.** A replay on a verified
  session fails `AUTH_SESSION_ALREADY_VERIFIED`; a concurrent call on the same
  unverified session fails `AUTH_OTP_VERIFY_IN_PROGRESS`. A shared,
  multi-instance store must implement the new, required
  `SessionStorage.claimForVerification(sessionId)` with a conditional write so
  the claim is atomic across processes. A custom store without it is rejected
  with `AUTH_SESSION_STORAGE_CLAIM_REQUIRED`; `createInMemorySessionStorage`
  already implements it.
- **JWT failures are classified.** `verifyToken` throws `StructuredError` with
  `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_MISSING_SUBJECT`
  (bad token) or `AUTH_JWT_CONFIG_SECRET_MISSING` /
  `AUTH_JWT_CONFIG_SECRET_WEAK` (misconfigured server). `createAuthMiddleware`
  and `createOptionalAuthMiddleware` forward config failures and
  `getUserByTurnkeyId`/`createUser` rejections to `next(error)`; a bad token
  still answers 401 (or continues anonymously). Register an Express error
  handler if you did not have one. `isAuthTokenCredentialError` distinguishes
  the two classes.
- `TurnkeyDIDSigner.getVerificationMethodId()` now returns
  `did:key:{mb}#{mb}`; credentials signed through it verify.
- `createDIDWithTurnkey` no longer writes `controller: ''` into verification
  methods; new DID documents carry the DID itself.

## Coming from 3.0.0-next.x or 2.x

The 3.0.0-next pre-releases and 2.x used the previous-format lifecycle. If
you are upgrading from one of those rather than from 3.0.0, the CEL 3 asset
API differs in these ways; a consumer moving from 3.0.0-next.1 hit each one:

1. **Custody is an explicit `CelSigner`.** Creation without a configured or
   per-call `signer` fails `NO_CUSTODY`. `keyStore` never selected an asset
   controller on the CEL 3 SDK and is now rejected outright (above); there is
   no `controller: 'ephemeral'` option — every asset has a real controller
   from genesis.
2. **Resources are `{ id, mediaType, content, url? }`.** `content` is
   `Uint8Array` or a UTF-8 string; the SDK computes digests. Later versions
   come from `asset.addResourceVersion(id, bytes, mediaType)`, never from a
   caller-supplied version number.
3. **The envelope is version 4** — `{ format: 'originals/asset', version: 4,
   assetId, eventLog: { log: [...] }, resources, unverified? }`. Read the log
   through `asset.celLog.log` / `envelope.eventLog.log`, not a top-level
   array.
4. **Mutations return a `MutationResult`** — `{ status: 'signed', head }`, or
   `{ status: 'skipped', reason: 'NO_SIGNING_KEY', localResourceId? }` under an
   explicit `onAppendFailure: 'skip'`. Nothing returns the mutated asset;
   read `asset.state` afterwards.
5. **Pre-CEL-3 logs are not readable by the default SDK.** `loadAsset`
   accepts version-3 and version-4 envelopes carrying `originals/cel/3`
   history only; a 2.x / 3.0.0-next log has no supported upgrade path. Mint a
   new genesis with the CEL 3 SDK (a new asset identity) and keep the old
   archive for provenance; `@originals/cel/legacy` exists to read or verify
   the old format, not to convert it.
6. **Identity is `ni:///sha-256;…`**, not `did:cel:` — see the top of this
   guide.

## Previous-format CEL writers move to `@originals/cel/legacy`

`@originals/cel`'s root no longer exports the previous-format (pre-CEL-3)
writer surface: `OriginalsCel`, the three per-layer managers
(`PeerCelManager`/`WebVHCelManager`/`BtcoCelManager`), the event-log
algorithms they call (`createEventLog`, `appendEvent`, `updateEventLog`,
`deactivateEventLog`, `verifyEventLog`, `witnessEvent`, the custody-fold
helpers), the previous-format canonicalizer (`canonicalizeEvent` and
derivatives — not RFC 8785; this also closes the root-export half of the
canonicalizer's own JCS finding), and the previous-format signer helpers
(`celSignerFromKeyPair`, `createKeyStoreCelSigner`, `currentControllerVm`,
`hexSha256ToDigestMultibase`). None of this is used by CEL 3 or the SDK's
`/v3` lifecycle. If your integration still genuinely needs previous-format
writing or verification, import it explicitly from `@originals/cel/legacy`
instead of the package root; do not construct the same surface out of
lower-level root exports.

## Credential verification is safe-by-default for declared status

`CredentialManager.verifyCredential` used to verify a credential on
signature alone, even when it declared `credentialStatus`. It now checks
that declared status by default: configure `credentialManager.statusListResolver`
to have it actually evaluated (every entry, singleton or array), or expect a
credential that declares a status you cannot evaluate to **fail closed**
rather than silently pass. Callers that intentionally want the old
signature-only behavior — for example, checking a status list credential's
own signature before reading it — call the newly, explicitly named
`verifyCredentialSignature` instead; `verifyCredentialWithStatus` (evaluating
a caller-supplied status list directly) is unaffected.

`OriginalsAsset.verify()` (the retained previous-format lifecycle asset)
calls this same `verifyCredential` for its credential checks when a
`credentialManager` dependency is supplied, so it inherits the new
fail-closed default too. Its other tiered-verification behavior — treating
signatures and hash-only resources as unchecked rather than failed when a
dependency isn't supplied at all — is unchanged; that is deliberate, existing
behavior distinct from this credential-status default and is not part of
this release.
