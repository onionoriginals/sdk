# 048 — Map: the VH-Log Originals protocol and author-held signing (issue #953)

Status: **map, written 2026-10-30 against `main` at `cfa29326`**. Issue
[#953](https://github.com/onionoriginals/sdk/issues/953) was opened before the
Originals Protocol was pinned and asked what "Originals 5.0.0 on a VH log"
would be. Since then the protocol was specified
([`specs/README.md`](../specs/README.md)), delivered by
[plan 011](011-originals-vh-replacement.md) and released as `@originals/sdk`
5.0.0 and 5.1.0 with `@originals/vh` 0.3.0. This map answers the issue's eight
open questions against the pinned stack, says what is decided and
implemented, and isolates what is still open for the consumer that drove the
issue (boop, [aviarytech/boop#286](https://github.com/aviarytech/boop/issues/286)).
Rule IDs refer to the pinned Originals Protocol. Nothing here changes code.

## 0. Summary

| Issue question | State | Where |
|---|---|---|
| Q1 what the protocol is | **decided and shipped** | §1 |
| Q2 how an asset names its authority | **decided and shipped**; agents map to editors | §2 |
| Q3 trusted time for key validity | **decided**: no time source; newest known DID version, else historical only; anchoring proves order | §3 |
| Q4 key types | **decided for the protocol** (Ed25519, secp256k1); **open** for P-256 device keys | §4 |
| Q5 Turnkey's role, `@originals/auth` 5.0.0 | out of the protocol; SDK signer is pluggable; **auth hardening open** | §5 |
| Q6 action records and seals | **not a protocol primitive**; the SDK primitives exist | §6 |
| Q7 reading 4.x assets | **decided**: no | §7 |
| Q8 revoked-key submissions | **decided and shipped**: refused at receipt, kept as refused candidate | §8 |

The remaining work is in `@originals/auth` and in the consumer, not in the
asset protocol. One protocol question needs an owner and spec decision: P-256
device keys (§4). The follow-ups are in §10.

## 1. What the VH-Log Originals protocol is (Q1)

Decided by the pinned spec and implemented in plan 011 PRs 2–10c.

- **An Original is its own did:vh log.** Its identifier is `did:vh:<SCID>` and
  its only history is a did:vh log under the `originals:1.0` extension. It is
  not a set of entries under the author's DID. Every entry carries the full
  asset state (name, metadata, status, resource descriptors, aliases) and one
  proof (P3.8, P5.7, plan 011 §2.1).
- **CEL is gone.** `packages/cel`, did:cel and the 4.0.0 `did:key` controller
  model were deleted in PR 5. There is no separate content history: resource
  versions are derived from the asset log's digests (P4.4).
- **Bitcoin.** Anchoring is a single, terminal update entry that adds the
  sat's `did:btco` alias. From then on each inscription on that sat carries
  one complete entry, Bitcoin is the authoritative source, chain order decides,
  and the sat's holder is the owner with no signing authority (P9.10–P9.16;
  [plan 012](012-bitcoin-representation.md); `ORIGINALS.md` phase 4).
- **Publication to the web** is an update entry listing a did:webvh alias that
  points back to the did:vh (P3.6). There is no publish or migrate operation.

So the 4.0.0 limitation that motivated the issue ("a seal is a CEL update
signed by the asset's single controller key") no longer exists. An asset has
no key of its own at all.

## 2. How an asset names its authority (Q2)

Decided (owner decision Q6, S8; P5.3, P5.11, P5.15–P5.18) and implemented.

- **The author is a DID, fixed at genesis** (P5.8). Each entry names the
  author DID, the verification method and the author DID version it relies on
  (`state.author.{did, verificationMethod, versionId}`).
- **Any assertionMethod key of the author DID may sign**, at the version the
  entry names: embedded Multikey, `controller` equal to the author DID, listed
  under `assertionMethod`, and not an update key of the author DID's own log
  (P5.3, P5.11). There are no thresholds and no roles in the asset log. The
  asset log has no update keys; rotation happens only in the author DID and
  needs no asset entry (P5.10).
- **Editors** are the delegation primitive (P5.15–P5.18, implemented in PR
  8c and VH-Log PR 11's hook). The author grants up to 32 editor DIDs the
  right to change the name, the metadata or named resources. An editor entry
  is signed by the editor's own DID and carries `state.editor`; it is checked
  against the grant in its parent's state. Only the author adds or removes
  resources, changes grants or aliases, anchors or deactivates.

Mapping boop's key roles onto this:

| boop role | Originals construct | How a record reads |
|---|---|---|
| Author key (Turnkey, DID updates only) | the author did:webvh's **update key** (`#key-0` in the landing's layout). Must not be an assertionMethod key used for Originals (P5.11) | never appears in an asset entry |
| Device key (per device, non-extractable) | an **assertionMethod key of the author DID**, added by an author DID update | "author Y, key `#device-N`, as of DID version V" |
| Agent key (agent-generated, author-approved) | preferred: the agent has **its own DID** and the author grants it an **editor grant**. Alternative: an assertionMethod key of the author DID, which then reads as the author | editor: "agent X (editor), under author Y's grant"; alternative: indistinguishable from the author |
| Revocation | remove the key from the author DID (device) or remove the grant (agent) | later entries by it are refused at a host; earlier ones stay valid, later unanchored ones are historically authorized only (P7.9) |

The editor route is what gives "agent X, delegated by author Y" in the
record itself, with the agent's authority bounded to named content. It also
keeps the agent's key out of the author's DID, so agent churn does not grow
the author's history (§9). The landing already keeps the author's identity
update key (`#key-0`, `authentication`) separate from its authorship key
(`#key-1`, `assertionMethod`) (`apps/landing/src/auth/webvh.ts`), which is
exactly the split P5.11 requires.

## 3. Time and revocation (Q3)

Decided by originals-spec #46, #47 and #51 (owner decisions of 23 October
2026), and implemented in phase 2.

- **No time source decides key validity.** A verifier checks the signing key
  against the **newest version of the author DID it knows of**, never against
  the entry's claimed `versionTime` (P7.8, #47). An unanchored entry whose key
  that newest version no longer lists is reported **historically authorized
  only**, whatever time it claims (P7.9). So backdating a self-asserted
  timestamp with a revoked key gains nothing: the entry is historical either
  way, and a host refuses it (§8).
- **Unanchored ordering is claimed only.** An unanchored Original is never
  current; a valid one is valid as of its checkpoint (P7.10, #46). Proven
  ordering, and a settled history, come only from Bitcoin anchoring (P9.16).
  Asset logs have no witnesses (owner decision Q14, P9.8, P9.9).
- **Freshness of the author DID** is established only by that DID's own
  witnesses or watchers and is reported separately (`established`,
  `not-established`, `stale`; P7.8, #51). A truncated author log that hides a
  revocation is therefore reported as not established, and repeat readers are
  protected by retained versionIds in the store (P7.8). This is the accepted
  residual the issue's §6 asked about; it is the author DID method's business
  (did:webvh witnesses), not the asset protocol's.
- **Host receipt time** is not a protocol input. The host's role is to refuse
  at receipt (§8). "Host-attested time" as an evidence class was not adopted.

For boop this replaces "authorized at the record's time" with "authorized
under the newest DID version the verifier has; otherwise historical only". The
verifier UI question in boop#286 ("signed by device D of author A") is
answered by the report's `authorBinding`, `identityEvidence.obtained` and
`historicallyAuthorizedOnly` fields and by `describeFreshness`.

## 4. Key types (Q4) — one open protocol question

Decided for the protocol: P5.12 permits exactly `eddsa-jcs-2022` (Ed25519)
and `bip340-jcs-2025` (secp256k1). `@originals/vh/crypto` decodes only those
two Multikey types and rejects anything else as `unsupported-profile`
(`MULTIKEY_UNSUPPORTED`). The SDK's `ES256Signer` and `P256` Multikey type
exist for credentials, not for asset entries.

**Open:** boop's device keys on iOS are Secure Enclave **P-256**, and
non-extractable WebCrypto P-256 is the portable choice in browsers and
WebViews. Today such a key cannot sign an asset entry. Three routes, for the
owner and the spec:

1. **Add a P-256 cryptosuite to P5.12** (`ecdsa-jcs-2019` with P-256,
   Multikey `0x1200`, `zDn…`). A spec change with new §12 rows; the engine
   gains one suite in `@originals/vh/crypto`. Widest device support; grows the
   pinned suite set the spec deliberately kept at two.
2. **Device keys are Ed25519**, generated non-extractable where WebCrypto
   supports it (recent Chrome, Safari, Firefox) and otherwise software-held.
   No protocol change; not hardware-backed on iOS.
3. **Device keys never sign asset entries.** They sign only app action
   records (§6), while asset entries are signed by a session-held Ed25519
   key from Turnkey. No protocol change; gives up offline sealing from a
   device, which boop listed as a requirement.

Recommendation: ask the spec (route 1) and keep route 2 as the fallback.
Route 3 contradicts boop's stated requirement. Nothing in the engine assumes
two suites beyond the permitted-suite hook, so route 1 is a bounded change.
This is the one item in the issue that needs a `wayfinder:grilling` issue.

## 5. Turnkey's role and `@originals/auth` (Q5)

The protocol says nothing about custody (originals-spec #46: key custody is
out of scope). In the SDK, signing is the `OriginalsSigner` contract
(`packages/sdk/src/originals/signer.ts`): `{ verificationMethod, cryptosuite,
sign(request) }`, where the request carries the parsed entry, its parent and
a human-readable summary the signer must re-derive (P5.11). Turnkey is one
adapter. Of the issue's §2–§4 findings:

| Finding | State on `main` |
|---|---|
| Ed25519 signing must use `HASH_FUNCTION_NOT_APPLICABLE` | **fixed** (`packages/auth/src/turnkey-sign-bytes.ts`) |
| Parent-org server signer cannot sign for a sub-org user | **true and intended**. The landing signs in the browser with a client-held Turnkey session (`apps/landing/src/auth/turnkey-session.ts`, 12-hour sessions). The server signer remains exported for server-owned DIDs; its docs should say it is not for user sub-orgs |
| Client-encrypted OTP | **supported, not required**: `verifyEmailAuth` takes a client `publicKey`; without one it still generates the session key server-side and returns the private key (`packages/auth/src/server/email-auth.ts`, `VerifyEmailAuthOptions.publicKey`) |
| Sub-org hardening flags (`disableEmailAuth`, `disableEmailRecovery`, `disableSmsAuth`), parent-org policy template, client-side root-quorum audit | **not implemented** |
| 7-day sessions with silent refresh, no `invalidateExisting` | **not implemented** (the landing uses 12 hours, no refresh) |
| Capacitor keystore bridge | out of this repository |

What `@originals/auth` 5.0.0 should ship, as a breaking change to the auth
package only:

1. The client-encrypted OTP flow is the only flow: `verifyEmailAuth` requires
   `publicKey` and never returns a private key; the server-generated fallback
   is removed. The issue's note that this needs `@turnkey/core` ≥ 2.0 is
   moot here: the package uses `@turnkey/sdk-server` 8 and `@turnkey/crypto`
   2.10, whose `encryptOtpCodeToBundle` already runs client-side.
2. Sub-org creation with email auth, email recovery and SMS disabled, and a
   documented path for existing sub-orgs to remove them from the user's own
   session. Validate against the live API before claiming it; the issue
   marks both as unvalidated.
3. A parent-org policy template (allow `INIT_OTP_V3`, `VERIFY_OTP_V2`,
   `CREATE_SUB_ORGANIZATION`; deny `EMAIL_AUTH`, recovery, legacy OTP login,
   credential and private-key export) shipped as documentation plus a check,
   with the stated residual that the root quorum bypasses policy and whoever
   serves the client code is trusted.
4. A client-side login audit of the sub-org's users and root quorum.
5. Session length and refresh as options, with the 10-key cap per user
   documented.
6. The server signer marked as server-owned-DID only.

The landing's current split (`#key-0` update key, `#key-1` assertionMethod
key, both in the user's Turnkey wallet) is the reference layout for an
author DID under this protocol. Device and agent keys are further
assertionMethod keys or editor DIDs (§2); adding them is a did:webvh update
signed by the update key, which is `@originals/auth`'s `updateDIDOriginal`
path, not the asset protocol.

## 6. Action records and seals (Q6)

Not a protocol primitive, and the recommendation is to keep it that way.

- A **seal**, in boop's sense of "publish this version", is an ordinary
  author or editor entry: an update that changes resources, or that lists the
  did:webvh alias (P3.6). It is signed by whichever assertionMethod key or
  editor key is at hand, from any device, online or offline, and submitted
  later (P6.7, `sign`/`submit`/`refused`/`reconcile`).
- **App action records** that are not asset changes are app-defined. The
  issue's §8 carry-overs already exist as SDK or `@originals/vh` primitives
  and need no new protocol surface:
  - RFC 8785 canonical payload: `canonicalize` in `@originals/vh/json`.
  - Domain-separated signing input: Data Integrity's
    `sha256(proofConfig) ‖ sha256(document)` in `proofHashData`
    (`@originals/vh/crypto`), which is what the two cryptosuites sign. An
    app's own domain string belongs in the proof options, not a new scheme.
  - The pending / signed / failed / unsigned lifecycle: drafts (P6.3),
    signed candidates, `refused` submissions and `reconcile` in the shared-host
    flow (P6.7, P6.8).
  - An independent verifier that never trusts a key carried by the record:
    P5.3 binding resolves the key from the author DID at the named version;
    the SDK's `load` and `verifyOriginal` take no key from the caller.
- If boop wants action records verified by the same engine with the same
  "authorized under the DID's newest version" rule, the shape is a second
  did:vh extension with its own method value and state rules, registered
  through did:vh PR 3's extension registry. That is a boop design, outside
  the Originals spec, and it would not be reported as Originals verification
  (P3.5).

## 7. Compatibility with 4.x assets (Q7)

Decided: no. No Originals were issued under CEL 3 or earlier formats, so
there is no conversion, migration or legacy verifier, and none will be added
(`CLAUDE.md`, `specs/README.md`). boop re-genesises, as its issue already
says.

## 8. Revoked-key submissions (Q8)

Decided and shipped, matching boop's proposal.

- **At a host**, a submission whose entry is historically authorized only is
  refused at receipt with `entry_historically_authorized_only`
  (`packages/host/src/shared-saves.ts`; P7.9, P6.5, P5.18). The host answers
  `accepted`, `already-accepted` or `stale-parent` and never alters a
  submission (P6.7, P6.8).
- **In the SDK**, a refused candidate is kept as `refused`, and `reconcile`
  has the caller sign a new candidate, with a current key, against the new
  head. That is the "recoverable local draft" boop asked for: the content is
  not lost, the old signature is.
- **Locally**, an entry already committed to a local log by a key that was
  later removed stays part of a valid checkpoint, reported historically
  authorized only, never current (P7.9, P7.10). The verifier does not delete
  history.
- **Offline work** signed by a device after its revocation and sent later is
  therefore refused by any host and reported historical by any verifier. The
  queue semantics boop#238 and #260 discuss are app-side: keep the draft,
  re-sign with a valid key, resubmit.

## 9. Churn and performance (issue §7)

- **Batching.** Several device or agent additions in one author DID update
  is a did:webvh matter (`@originals/auth`'s update path), and nothing in the
  asset protocol constrains it. Preferring editor grants for agents (§2)
  keeps agent churn out of the author DID entirely; a grant change is one
  author entry on the asset.
- **Long histories.** The verifier is bounded at 1,000 signer-DID versions
  (P14.13), and the store retains the newest verified versionId per author
  DID so repeat reads compare rather than re-verify from scratch (P7.8). A
  resolver-level cache keyed by `(did, versionId)` is not in the SDK; add it
  if a consumer measures a need, behind the existing author-evidence seam
  (the `authors` source, `identityFetch` and the store's retained evidence in
  `packages/sdk/src/originals/sdk.ts`).

## 10. Follow-ups

Opened on 2026-11-01 (the fourth is done in this plan's PR):

1. #1022 `wayfinder:grilling` **P-256 device keys** (§4): ask the spec whether
   P5.12 gains `ecdsa-jcs-2019`/P-256; decide the fallback. This is the only
   protocol question left open by #953.
2. #1023 `wayfinder:task` **`@originals/auth` 5.0.0** (§5): client-encrypted OTP
   only, sub-org hardening, policy template and audit, session options,
   server signer scoped to server-owned DIDs. Breaking for auth only.
3. #1024 `wayfinder:prototype` **second-device seal** (§2, §6): an author DID with
   two assertionMethod keys, an entry signed by the second key, and an agent
   DID with an editor grant signing an editor entry, verified end to end
   with `load` from an evidence package in a fresh process. The engine rows
   exist (C12 editor and rotation rows); the prototype is a consumer-shaped
   walkthrough, to be published as a doc under `docs/`.
4. **Docs**: the "Custody roles" section in `packages/sdk/ORIGINALS.md`
   restates the table in §2, so a consumer finds it without this plan.

The `wayfinder:research` issue on witnesses and watchers versus anchoring
that #953 proposed is closed by the owner's decisions: asset logs have no
witnesses (Q14), the author DID's own witnesses or watchers establish its
freshness (P7.8, #51), and anchoring alone proves order (P9.16). No further
research is needed there.
