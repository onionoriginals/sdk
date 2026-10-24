# Hosted feature-enablement acceptance (issue #976, section B)

This runbook is the gate for turning on `hostedPublication`
(`apps/landing/src/sdk/features.ts`). Section A, the local release, is
[README.md](README.md) (`bun run acceptance:local`). Section B is separate and
needs real resources:

- a client-held Turnkey session;
- a deployed public host;
- a signed-out reader on the open network.

**Status.** The gaps in [Gaps](#gaps) are implemented in the PRs stacked on
this runbook. The harness is `hosted-release.mjs` (G9). Its `--target local`
dry run passes and runs in CI. The staging driver's signed-out action has run
in real Chromium against the real server; its signed-in actions run for the
first time on the staging host. Section B has **not** passed: no staging
receipt exists. Where each gap landed: G1 and G6 in #985, G7 and G10 in #986,
G2 in #987, G4 and G5 in #988, G3 in #989, and G9 in the harness PR.

**What this runbook doesn't authorize:** deploying, publishing to
production, changing credentials, or any Bitcoin activity. The owner
provisions the host and the account. A B run uses only those.

## Environment

The owner decided this on 2026-10-22.

### Host

A **staging environment** of the Railway service `builder`, separate from
production (`originals.build`). Production deploys `main`, does not have the
hosted stack, and stays untouched.

| Requirement | Why |
|---|---|
| Built from the exact candidate SHA, the head of the stack under test | The receipt compares the deployed revision with the source SHA (G6) |
| Its own mounted volume, with `ORIGINALS_DATA_DIR` pointing at it | The durable host store is the volume. A deployed instance with auth refuses to boot without a mounted volume (`server/config.ts`) |
| Its own domain, set as `VITE_WEBVH_HOST` (a bare hostname) and bound in Railway | The did:webvh domain of every identity and alias minted there, permanently (G1). Must not be `originals.build` |
| The acceptance-only publication build switch (G7) | `hostedPublication` is otherwise a constant `false` |
| `VITE_BTC_NETWORK` not `off`, and `BTC_NETWORK` matching it | The Turnkey session bootstrap only runs when the network flag is on (`src/auth/useAuth.tsx`). No Bitcoin action is taken, and no funds are involved |

Environment variables, **by name only**. The owner sets their values in the
Railway dashboard. They are never written to source, to a log or to the receipt.

| Name | Kind |
|---|---|
| `JWT_SECRET` | secret, at least 32 chars, distinct from production's |
| `TURNKEY_ORGANIZATION_ID` | secret, the **staging** Turnkey org |
| `TURNKEY_API_PUBLIC_KEY` | secret, the staging org's API key |
| `TURNKEY_API_PRIVATE_KEY` | secret, the staging org's API key |
| `NODE_ENV` | `production` |
| `ORIGINALS_DATA_DIR` | the staging volume's mount path |
| `TRUSTED_PROXY_HOPS` | `1` behind the Railway edge |
| `VITE_WEBVH_HOST` | the staging hostname |
| `VITE_BTC_NETWORK`, `BTC_NETWORK` | a non-mainnet network |
| `VITE_ACCEPTANCE_HOSTED_PUBLICATION` | `1`, the G7 switch. It is ignored when `VITE_WEBVH_HOST` is the production host |

### Account

- A **separate staging Turnkey org**, provisioned by the owner.
- A dedicated test email whose inbox the operator can read. Its first
  sign-in creates one sub-org, and the app creates its wallet accounts:

| Role | Turnkey account | Path | In the author DID | Used for |
|---|---|---|---|---|
| Identity / alias control | `IDENTITY_ACCOUNT` | `m/44'/501'/1'/0'` | `#key-0`, the did:webvh update key | Updating the author DID. Creating and updating each Original's did:webvh alias (P3.7) |
| Originals signing | `AUTHORSHIP_ACCOUNT` | `m/44'/501'/0'/0'` | `#key-1`, the only `assertionMethod` | Signing every asset-log entry (P5.2, P5.3). Never an update key of the author DID or of any alias (P5.11) |

The private keys stay in Turnkey. The browser holds only a non-extractable
P-256 session key in IndexedDB (12 hours) and the `auth_token` cookie (7 days).

### Operator

- A checkout at the candidate SHA, with Node, Bun and Chromium
  (`CHROMIUM_PATH`, or playwright-core's own browser).
- Railway CLI **read** access to the staging environment, to cross-check the
  deployed revision.
- The test inbox, to read each OTP as the harness asks for it.

### Never recorded

These must not appear in the receipt, an artifact, a log or a commit:

- OTP codes, the `auth_token` JWT, cookies;
- the Turnkey session key or its stamps;
- API keys, `JWT_SECRET`;
- the test email address. The receipt names the sub-org by the first 16
  chars of its id, the same value as the host slug.

## Running it

```sh
bun run build
node scripts/acceptance/hosted-release.mjs --base-url https://<staging-host> --email <test inbox> [--production-url https://originals.build] [--out <dir>] [--receipt <file>]
bun run acceptance:hosted:local    # dry run, see below
```

The staging run drives Chromium through `playwright-core`
(`hosted/browser-client.mjs`), one Node process per client action. Each
client calls the page's own engine (`window.__originalsDemo`), so every
signature comes from the real Turnkey session in that page. Sign-in goes
through the page's own modal.

- **Browser restarts are real.** Each author client has its own persistent
  user-data dir. A restart closes the browser process and launches a new one
  on the same dir, so IndexedDB, localStorage and cookies survive just as they
  do for a person.
- **"Another client"** is a second user-data dir that starts empty.
- **Sign-in.** When an OTP is needed, the harness pauses and reads the code
  from stdin. It types the code into the page and drops it.
- **Reader.** It runs as a separate Node process with only `PATH` in its
  environment, a fresh HOME and TMPDIR, no cookie jar, and no access to the
  author profile dirs. This matches the section A reader, except that it has
  the network.

`--target local` is a dry run, with no browser and no Turnkey:

- `hosted/local-server.ts` serves the landing's real hosting, submit and
  account-index routes and its durable store, on loopback with a temp data dir.
- The author is a did:webvh built by the landing's own builder, with the same
  two key roles. Its secrets come from a custody file that stands in for
  Turnkey.
- Each client is the landing engine in a fresh Bun process with its own
  FileStore (`@originals/sdk/originals/fs`), not the browser's
  `IndexedDbStore`. A restart is a new process on the same store directory.
  So the dry run doesn't exercise `IndexedDbStore` itself: its schema,
  upgrades and other-tab behaviour are covered by `src/sdk/idb-store.test.ts`
  (fake-indexeddb), and by the staging run's real browser profiles.
- The signed-out phase installs fake-indexeddb as the page's IndexedDB, so
  "a signed-out page keeps nothing" is checked against a store that would
  keep a signed-in account's work (Bun has none of its own).
- The reader is a fresh Node process. It gets no directory and no secret, and
  reads the public URLs under the alias's own `Host`.

It runs every gate's checks, so CI catches regressions. **A local run is never
a B receipt.** The receipt says `target: "local"` and `status:
"DRY-RUN-PASS"`, every gate is `NOT-RUN`, and the results are under
`dryRun`.

## Gates

Each gate lists its automated steps, any manual steps, and what counts as
PASS. A gate fails if any of its checks fails, or if a check can't run.

### B1. Create, revise and publish through the real Turnkey session

Automated:

1. Client A opens the staging site and signs in. **Manual:** the operator
   enters the OTP.
2. It creates the author identity, the did:webvh at
   `<VITE_WEBVH_HOST>:user-<sub16>`.
3. It creates a work with an `image/png`, an `application/octet-stream` and
   a `text/markdown` resource.
4. It revises the text and the image.
5. It publishes. The page must show publication complete only after G5's
   read-back.
6. It reads the author DID log and the alias log from the host.

PASS when all of these hold:

- The author DID document lists `#key-1` as its only `assertionMethod`. The
  log's `updateKeys` are the identity key's `did:key`, which is `#key-0`.
- Every asset-log entry proof names `<author>#key-1` at a versionId of the
  author DID that lists it (P5.3). No entry is signed by `#key-0`.
- The alias is `did:webvh:<SCID>:<VITE_WEBVH_HOST>:user-<sub16>:o-<16>`.
  Its `updateKeys` are the identity `did:key`, it has
  `alsoKnownAs: [<did:vh>]`, and it is `portable`.
- The authorship key is not an update key of either log (P5.11).
- The Original's state lists exactly that alias (P3.6).
- The receipt holds public keys, verification method IDs and Turnkey paths,
  never secrets.

### B2. A fresh, signed-out reader verifies the published work

Automated, two readers:

- **(a)** The Node reader process calls
  `OriginalsSDK.loadPublished(aliasDid, safeFetch)` against the public URLs.
- **(b)** A new incognito browser context, with no cookies, storage or
  profile, loads the same alias through the app's reader view.

PASS when each reader shows all of these:

- `verified: true`.
- `report.validAsOf.checkpoint` equals the checkpoint client A published
  (versionId and entry hash).
- The alias is `confirmed` in both directions. The Original lists it, and its
  latest document points back (P3.6).
- `report.resources` is `available`. Every resource SHA-256 matches the bytes
  client A uploaded. A missing byte doesn't fail `verified` (P7.3), so this
  is checked separately.
- These are recorded as **separate** fields:
  - `verified`;
  - `current`, which must be `false` with reason `not-anchored` (P7.10);
  - `identityEvidence` freshness and `validAsOf.signers[*].{obtainedAt,source}`;
  - `ordering`, which must be `claimed` (P7.6).

  FAIL if any of them is merged into a single "ok".
- The reader received no `Set-Cookie`, sent no cookie, and had no
  `auth_token`.

### B3. Restore and continue editing after a browser restart, and on another client

Automated:

1. **Same client.** Close client A's browser and relaunch it on the same
   profile. The Original is listed (G2, G3). It reopens at the published
   checkpoint, and a revision saves through the host's submit route.
2. **Another client.** Client B uses a fresh profile, and the operator signs
   in with the same account (**manual:** OTP). The published Original is
   listed from the account's index and restored from the host (G3). A
   revision then continues from the explicit parent, the host's head.
3. The B2 reader runs again and verifies the new checkpoint.
4. **Stale parent** (C12-125). Back on client A's profile, whose copy is now a
   revision behind B's, a save on its old parent is refused with a
   stale-parent conflict (`StaleSaveError`), and client A's head doesn't move.
   This runs on both targets (`b3-stale-parent`).
5. **Another key** (dry run only). A client restoring with a key that isn't
   the author's `#key-1` can't continue the work (`b3-restore-no-authority`).
   It doesn't run on staging: there the page's only signer is the account's
   own Turnkey session, and a second account has its own index and
   namespace, so it never reaches this work.

PASS when all of these hold:

- Both clients reach the same did:vh with the same history prefix.
- Each new entry's parent is the head the client loaded. Nothing is rebased
  and no fork is reported (P2.1, P4.5).
- The authority to sign comes only from the Turnkey session. A restored
  Original with no session refuses to sign (`SIGNER_REQUIRED`).
- Restoring needs more than the account key. FAIL if B's only route to the
  work is re-creating it.

Unpublished work isn't synchronised between clients. It survives a restart on
the same profile (G2), and moves to another client only as an evidence
package import, the section A path. The receipt lists this under
`unavailable`.

### B4. Interrupted publication resumes

Automated. There are two runs, each on a new Original in client A:

- **(i) After the publish entry.** The harness aborts every
  `PUT /api/originals/host/*` once the publish entry is committed locally
  (`page.route`).
- **(ii) During the uploads.** The alias log and the asset log upload, then
  the harness aborts every `originals/resources/*` upload.

After each abort:

1. Close the browser and relaunch the same profile.
2. The reader runs and must **not** report a verified complete snapshot.
3. The page shows the publication as incomplete, never complete.
4. Resume the publication (G4), then run the reader again.

PASS when all of these hold:

- The resumed run uses the **same** alias DID and the **same** checkpoint.
- The asset log has exactly one entry that adds the alias. A second alias
  entry, or a second alias for the Original, is a FAIL.
- The page never showed complete while the reader couldn't verify the whole
  snapshot.
- After resuming, the B2 checks pass.

### B5. Signed-out ephemeral demo stays explicit

Automated, in a fresh signed-out context:

1. Create a work.
2. Check the copy: the key is generated in the page and discarded with it.
   Nothing may claim a stored key or a backup.
3. Export the evidence package.
4. Reload.

PASS when all of these hold:

- After the reload the work is gone, and the page says so. It doesn't offer
  to restore it.
- Publishing isn't available signed out.
- The package's did:vh genesis holds only Multikey public keys. No file in
  the package holds private key material: no `secretKeyMultibase`, no
  `privateKey*` member, no Multikey Ed25519 secret prefix.
- No anonymous key is persisted to localStorage, IndexedDB or a cookie.

### B6. Hosted publication stays off until this receipt passes

Automated:

- The candidate source has `hostedPublication: false` in `features.ts`.
- Production (`https://originals.build`) still serves a bundle with publishing
  disabled. The harness checks the deployed `/api/version` and the step's
  disabled state.

PASS when publication is off everywhere except the staging acceptance build.
Turning it on is a separate owner PR, and that PR cites a PASS receipt from
this runbook.

## Receipt

The receipt is `<out>/receipt.json`, also printed to stdout. It has the same
shape as the section A receipt:

```jsonc
{
  "receipt": "originals-hosted-acceptance/1",
  "scope": "onionoriginals/sdk#976 section B (hosted feature enablement). Not Bitcoin.",
  "target": "staging",                 // or "local", which is never a B pass
  "createdAt": "…",
  "status": "PASS",                    // or "FAIL"
  "source": { "sha": "…", "branch": "…", "dirty": false, "dirtyFiles": [] },
  "deployed": {
    "baseUrl": "https://<staging-host>",
    "revision": "…",                   // /api/version server SHA
    "spaRevision": "…",                // SHA baked into the SPA (G6)
    "webvhHost": "<staging-host>",
    "hostedPublicationBuild": true,
    "production": { "baseUrl": "https://originals.build", "revision": "…", "hostedPublication": false }
  },
  "packages": { "@originals/sdk": "…", "@originals/vh": "…", "@originals/auth": "…", "@originals/landing": "…", "didwebvh-ts": "…" },
  "runtimes": { "node": "…", "bun": "…", "chromium": "…", "platform": "…" },
  "profile": { "protocol": "originals:1.0", "cryptosuite": "eddsa-jcs-2022", "witnesses": "none (Q14)", "ordering": "claimed (unanchored)", "freshness": "never current unanchored (P7.10)" },
  "signerMode": "Turnkey client-held session (non-extractable P-256 session key in IndexedDB; Ed25519 wallet accounts held by Turnkey)",
  "author": {
    "did": "did:webvh:…",
    "subOrg": "<first 16 chars>",
    "roles": {
      "identity":   { "verificationMethod": "#key-0", "turnkeyPath": "m/44'/501'/1'/0'", "publicKeyMultibase": "z…", "updateKey": true, "controlsAlias": true },
      "authorship": { "verificationMethod": "#key-1", "turnkeyPath": "m/44'/501'/0'/0'", "publicKeyMultibase": "z…", "updateKey": false, "assertionMethod": true }
    }
  },
  "originals": [
    { "case": "B1", "did": "did:vh:…", "alias": "did:webvh:…", "checkpoint": { "versionId": "…", "entryHash": "…" },
      "resources": [{ "id": "…", "mediaType": "…", "sha256": "…" }], "urls": { "aliasLog": "…", "assetLog": "…" } }
  ],
  "isolation": { "clients": [{ "name": "A", "userDataDir": "…", "launches": 3, "pids": [] }], "readers": [{ "pid": 0, "envNames": ["PATH", "…"], "cookies": 0 }] },
  "gates": { "B1-turnkey-create-revise-publish": "PASS", "B2-signed-out-reader": "PASS", "B3-restore-continue": "PASS",
             "B4-interrupted-publication": "PASS", "B5-signed-out-ephemeral": "PASS", "B6-flag-off": "PASS" },
  "phases": [ /* { phase, started, finished, isolation, facts, checks: [{ id, title, status, detail|error }], status } */ ],
  "manual": [{ "step": "otp", "phase": "b1-client-a", "at": "…" }],   // never the code itself
  "artifacts": [{ "path": "…", "bytes": 0, "sha256": "…" }],
  "unavailable": ["Unpublished work does not sync between clients; it moves by evidence package import (section A)."],
  "notIncluded": ["Bitcoin anchoring, signing and commit/reveal restart."]
}
```

Before the receipt is written, it is scanned for secret patterns: JWT shapes,
`auth_token`, `secretKeyMultibase`, `privateKey`, and the OTP the operator
typed. A hit fails the run.

## PASS and FAIL

**PASS** requires all of these:

- every gate B1–B6 is PASS;
- `source.dirty` is false;
- `deployed.revision` and `deployed.spaRevision` equal `source.sha`;
- `target` is `staging`.

**FAIL** in any of these cases:

- any check fails or can't run;
- the deployed revision is unknown or differs from the source;
- `current` is ever `true`;
- a second alias entry appears;
- the page reports publication complete before the reader can verify it;
- a secret is found in an artifact or the receipt;
- the run used production.

CI green, a merge, release notes or a `--target local` run are not public-host
proof.

## Gaps

These must land, each tested first, before B can pass. The recommended stack
order follows the dependencies. `hostedPublication` stays `false` in every
one of them.

| # | Gap | Blocks | Proposed fix |
|---|---|---|---|
| G1 | The SPA hard-codes the did:webvh domain `magby.originals.build` (`src/auth/webvh.ts`) and never reads `VITE_WEBVH_HOST`. The server 301s every non-`/api` read on a non-canonical host to `VITE_WEBVH_HOST`, so a reader can't fetch what was published | B1, B2 | New identities and aliases use the build's `VITE_WEBVH_HOST`, falling back to `location.host`. Reads of the hosted layout for a host the store holds skip the canonical redirect, so existing `magby` identity DIDs stay readable |
| G6 | No deployed revision. `/api/health` is `{status:"ok"}` | receipt | `GET /api/version` returns the server's `RAILWAY_GIT_COMMIT_SHA`, and the build bakes the SPA's SHA |
| G7 | `hostedPublication` is a constant, so no deployed build can publish | B1–B4 | A build-time switch `VITE_ACCEPTANCE_HOSTED_PUBLICATION`, honoured only when `VITE_WEBVH_HOST` isn't the production host. A test pins production off |
| G10 | The signed-out copy is stale. It describes a key in localStorage, a key backup file, and anonymous publishing to a "shared demo area" (`src/content.ts`, `src/components/demo-logic.ts`) | B5 | Rewrite the copy to say the key is page-scoped, discarded, and not recoverable. Add a content-claim test |
| G2 | `DemoEngine` keeps the work in `MemoryStore` and the alias in memory | B3, B4 | An IndexedDB `OriginalsStore`, one database per sub-org, holding the log, resources, author and alias evidence, retained versions, branches, and pending and refused candidates. Signed-in engines use it; signed out stays `MemoryStore` |
| G4 | After a restart, a publication interrupted after its entry can't resume | B4 | Persist a publication record (`{ alias, state: started \| uploaded \| complete }`) before each step. Reopening restores the alias, and publishing again passes it, so no second publish entry is signed. The files for a checkpoint are deterministic and the host accepts identical repeats, so a resume puts them all again; no per-file list is kept |
| G5 | `publish()` reports success when the PUTs resolve, with no read-back | B1, B4 | Report complete only after a cookie-less `loadPublished` sees the local checkpoint with every byte. Otherwise the state is `uploaded-unverified` with "Resume" |
| G3 | Nothing lists or reopens an account's Originals. `GET`/`POST /api/originals` exist but the client never calls them | B3 | Publishing records `{did, alias}` in the account index. The engine lists the durable store plus the index, opens local work, and restores a published Original from the host with `sdk.sync` |
| G9 | No hosted harness | all | `hosted-release.mjs`, reusing `lib/phase.mjs`, with the `--target local` dry run in CI |

Not gaps, but noted:

- Hosted reads have no CORS headers. The B2 readers are a Node process and a
  same-origin browser, which is the supported reader path. Cross-origin
  browser readers are out of scope.
- The Turnkey session lasts 12 hours. A restore after it expires needs a new
  OTP sign-in, which is expected and recorded as a manual step.
