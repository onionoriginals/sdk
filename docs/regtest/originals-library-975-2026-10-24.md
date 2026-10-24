# #975 — landing library recovery, 2026-10-24

Implemented on PR #991's `0ed896ff` baseline, then rebased onto its updated
`f17156dd` head (including its dependency-only CI follow-up). This closes the missing consumer library/reopen path; it does
not expand the public-host or Bitcoin release gates.

## What changed

- `/me` is discoverable from navigation, the mobile menu and the demo. It
  distinguishes browser copies, account evidence, pending submissions and
  incomplete records. `/me/<encoded-did>` verifies and opens saved work.
- IndexedDB persists unsigned form inputs (including binary uploads), guest
  author keys and the SDK store: exact committed history, every resource
  version, author evidence, retained checkpoints, branches, pending/refused
  saves. Account namespaces and guest storage are separate. Signing out keeps
  data for that account's return without displaying it to another account.
- Authenticated listing/export discovers actual durable anchoring directories
  and hosted evidence, including Originals without separate summaries. Private
  recovery works with all publication gates off; responses are `no-store` and
  never expose recovery transaction bytes.
- Import verifies evidence with the SDK. Opening requires no signature and
  confers no authority (P7.5). Saved history/resources, author binding, identity
  limits and Bitcoin's accepted head are reported separately. A fresh sat read
  is verified by a fresh consumer path, rather than trusting a library summary.
- Account-scoped outboxes resume identical signed pairs. A reproduced bug
  deleted an uncertain pair on a later 401; it now survives auth, gate and
  validation refusals until acknowledgement of the exact transaction IDs.
  Legacy unscoped pairs are adopted only after verified author and deposit
  address both match; unclaimed records remain intact (P9.6).
- The `b4e56bb1` signer continues to resolve the current browser signing client
  per signature while retaining the author's DID/key.

## Evidence

[Browser receipt](receipts/originals-library-browser-975-2026-10-24.json) uses
B3's collaborative Chromium browser at loopback ports 3101/3102, local author
keys and fixture authentication. It proves:

1. Create/revise, reload, then open exact history and resource bytes; a restored
   guest author can append a third entry under the same identity.
2. Unsigned title and exact UTF-8 written content survive a document reload.
3. An uncertain IndexedDB pair survives reload; a fresh engine with a signer
   that would fail if called resends it, gets `recorded`, makes zero signatures
   and causes zero additional broadcasts.
4. Two independent browser-store handles editing the same parent produce one
   winner and one stale-parent refusal; reopening retains exactly two entries.
5. Bob and guest storage cannot list/open Alice's evidence or transaction pair;
   Bob's authenticated server export returns 404.
6. The committed Stage A ZIP for
   `did:vh:QmRBdNNBMkjWTtXDhGTMY3E5eWKY7nGaAfMHDYXKxehtTB` imports through
   the recovery file input with valid history/binding, complete identity
   evidence and available resources. Saved head is exactly
   `4-QmTfH5NP9qQs2YUTUafCodBefqHdeW4udiKwpgsWbG1MYS`. The separate fixture
   chain cannot establish that historical anchor; the UI reports no accepted
   head and `current: false`.

[Core/ord receipt](receipts/originals-library-core-ord-975-2026-10-24.json)
comes from `scripts/regtest/landing-anchor.ts`, Bitcoin Core 31.1 and ord
0.29.0, disposable regtest with local keys and no public peers. It adds:

- authenticated library discovery and evidence export after server SIGKILL;
- reopening in a new consumer engine with no author/wallet signer;
- retry of the identical held pair, answered from its durable record;
- fresh consumer verification of accepted head, resource bytes and author
  binding using live Core/ord reads;
- the existing anchor, same-sat reinscription, durable restart and reorg checks.

Regression tests failed before their fixes for missing reopen/discovery, hosted
evidence without summaries and uncertain-pair deletion after reauth. Negative
checks reject a forged signed history and corrupt ZIP, retain existing work,
and reject attempts to revise as another author. The real Stage A export is
also a repeatable offline SDK regression.

Validation: 1,159 landing tests, landing/server/regtest typechecks, production
build, Node ESM export verification and browser-safety verification passed.
Existing bundle chunking warnings and SDK Buffer advisories remain unchanged.
The 390 px browser layout had no horizontal overflow; the interior uses the
existing eclipse typography, spacing, colours and navigation.

## Limits and gates

This is **not a new live Turnkey OTP/signing run**. Fixture authentication and
local keys are labelled as such. No parent-thread credentials were inspected or
used; no signet, testnet, mainnet, real spending, public deployment or publishing
occurred. The browser and real Core/ord checks are separate evidence sources.

A fresh browser profile using the original Stage A account/chain and live
Turnkey still requires owner authorization. Local IndexedDB is device-local,
not account backup; clearing it loses local-only drafts/keys. Server storage
requires its durable volume. Bitcoin holds the signed history, not resource or
signer DID files. Reads rely on this server's provider and a single ord index;
no independent index was compared and ownership remains provisional. Identity
checks use the newest verified DID history known to the reader, not proof that
no newer DID version exists. The public-host and mainnet acceptance gates remain
**pending**; hostedPublication/explore stay off and bitcoinAnchoring retains its
existing explicit build/server gates.

## PR #992 CI follow-up

The first PR coverage job failed in `@originals/sdk` because the optional-file
retrieval deadline test unexpectedly resolved, not because coverage fell below
its threshold: the job reported 88.8% functions and 91.15% lines against 80%
for each. A deterministic regression now delivers the request timer before the
whole-operation timer while the sampled wall clock still precedes the deadline.
It failed before the fix. When that request consumed the operation's remaining
time allowance, its timeout is now terminal rather than an optional missing
file; a separate test preserves recoverable per-request timeouts. Thresholds
are unchanged. A dedicated changeset covers library recovery and this fix.
