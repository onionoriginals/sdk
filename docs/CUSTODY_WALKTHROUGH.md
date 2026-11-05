# Custody walkthrough: two devices and an agent under one author

This walkthrough shows a consumer that keeps several keys for one author. It
uses constructs that already exist, so it adds no protocol surface. It follows
[plan 048](../plans/048-originals-5-vh-log-map.md) §2 (how an asset names its
authority), §6 (seals are ordinary entries) and §8 (revoked-key submissions),
and the "Custody roles" section of
[`packages/sdk/ORIGINALS.md`](../packages/sdk/ORIGINALS.md). Issue #1024.

| Role | Construct | Rule |
|---|---|---|
| The identity key | the author did:webvh's update key (`#key-0`, authentication only). It administers the DID and never signs an asset entry | P5.11 |
| Device 1, device 2 | one `assertionMethod` key each in the author DID (`#device-1`, `#device-2`), added by author DID updates | P5.3, P5.10 |
| The agent | its own did:vh, with an editor grant on the Original's resource | P5.15–P5.18 |
| Revocation | remove the device key from the author DID, or remove the agent's grant | P7.9, P5.17 |

## Run it

```sh
bun install
(cd packages/vh && bun run build) && (cd packages/sdk && bun run build)
cd packages/host
bun examples/custody-walkthrough.ts          # the transcript below
bun examples/custody-walkthrough.ts --raw    # the same run with real DIDs, versionIds and times
bun test tests/custody-walkthrough.test.ts   # checks this page against a fresh run
```

The script is [`packages/host/examples/custody-walkthrough.ts`](../packages/host/examples/custody-walkthrough.ts).
The devices and the agent use only the public SDK (`@originals/sdk`,
`@originals/sdk/originals`) and `@originals/vh`. Each one has its own
`MemoryStore` and its own copy of the signer DID logs. The shared host is
`@originals/host`'s real server (`buildFetch` with the durable Originals
routes), on a temporary data directory and answering in process. Every caller
is signed in as the namespace owner. The landing's caller rule (owner or a
named account, P5.15) is not part of this walkthrough.

The output below is pasted from a run. Each DID, versionId, temporary path
and time is replaced by a stable label (`<author>`, `<entry 3>`, `<time>`),
so the transcript is the same on every run. Keys come from fixed seeds, so
key multibases and resource digests are real values.
[`packages/host/tests/custody-walkthrough.test.ts`](../packages/host/tests/custody-walkthrough.test.ts)
runs the script and fails if any block here differs from its output. After an
intended change, run `UPDATE_CUSTODY_DOC=1 bun test tests/custody-walkthrough.test.ts`
and review the diff.

## 1. The author DID

The identity key creates the author did:webvh with `createDIDOriginal`. At
v1 the DID has `#key-0` (the update key, authentication only) and
`#device-1`. A later author DID update, signed by the identity key, adds
`#device-2` at v2. Neither device key is an update key (P5.11).

```ts
const v1 = await createDIDOriginal({ type: "did", domain, paths: [slug], signer: identity, verifier: identity,
  updateKeys: [identity.getVerificationMethodId()],
  verificationMethods: [keyZero, device(1)], authentication: ["#key-0"], assertionMethod: ["#device-1"] });
await updateDIDOriginal({ type: "did", log, signer: identity, verifier: identity,
  verificationMethods: [keyZero, device(1), device(2)], authentication: ["#key-0"], assertionMethod: ["#device-1", "#device-2"] });
```

<!-- custody-walkthrough output: step 1 -->
```text
author DID: {
  "did": "<author>",
  "updateKeys": [
    "<identity key> (#key-0)"
  ],
  "<author v1>": {
    "authentication": [
      "#key-0"
    ],
    "assertionMethod": [
      "#device-1"
    ]
  },
  "<author v2>": {
    "authentication": [
      "#key-0"
    ],
    "assertionMethod": [
      "#device-1",
      "#device-2"
    ]
  }
}
```

## 2. Genesis by device 1, seal by device 2

Device 1 creates the Original, naming `#device-1` at author v1. The identity
key cannot sign an entry: `#key-0` is not under `assertionMethod`, so the
signed entry fails verification and nothing is committed (C12-54; P5.3,
P5.11, P6.1).

Device 2 imports device 1's evidence package and seals the version. Plan 048
§6 treats a seal as an ordinary author entry. Here it is the publish entry
that lists the Original's did:webvh alias (P3.6). Device 2 signs it with
`#device-2` and names author v2. The asset log never rotates a key. The new
key is in effect because the author DID added it, with no asset entry for the
change (**C12-51**; P5.10). The hosted snapshot is uploaded to the owner's
namespace, and from then on saves go through the host (P6.7).

```ts
await device1.create({ name, resource, author: { did, verificationMethod: `${did}#device-1`, versionId: v1 }, signer: device1Signer });
await device2.import((await device1.package(original)).bytes);
await device2.publish(original, { parent, author: { did, verificationMethod: `${did}#device-2`, versionId: v2 }, signer: device2Signer, alias });
```

<!-- custody-walkthrough output: step 2 -->
```text
an entry signed by the identity key (#key-0) is refused: {
  "category": "invalid-evidence",
  "code": "COMMIT_VERIFICATION_FAILED",
  "message": "the signed entry does not verify: the verification method is not listed under assertionMethod"
}
device 2 imports device 1's package: imported
device 1 syncs from the host: imported
entries (versionId, role, proof verificationMethod @ the signer DID version it names):
  <entry 1>  author  <author>#device-1 @ <author v1>
  <entry 2>  author  <author>#device-2 @ <author v2>
device 1's report: {
  "history": "valid",
  "entries": 2,
  "authorBinding": "valid",
  "identityEvidence": {
    "status": "complete",
    "author": "<author>",
    "latestVersionId": "<author v2>",
    "freshness": "not-established",
    "editors": []
  },
  "resources": "available",
  "ordering": "claimed",
  "fork": null,
  "historicallyAuthorizedOnly": [],
  "validAsOf": {
    "checkpoint": "<entry 2>",
    "signers": [
      {
        "did": "<author>",
        "role": "author",
        "versionId": "<author v2>"
      }
    ]
  },
  "current": false
}
```

## 3. The agent: an editor grant, then its removal

The agent has its own did:vh, made with `createLog` from `@originals/vh/log`,
with its own update key and one `assertionMethod` key. Device 1 grants it new
versions of the resource only:
`{ did: agent, name: false, metadata: false, resource: true }` (P5.15). The
grant is an author entry, saved through the host.

The agent reads the Original from the host and signs a new resource version
as an editor. The entry carries `state.editor` and its parent's author
reference, and the agent's signer is shown that it signs as an editor
(**C12-113**; P5.16). Device 1 then removes every grant (`editors: null`).
The agent's next change is refused before anything is signed, with
`unauthorized-key` `EDITOR_NOT_GRANTED`, because the parent's state has no
grant for it (**C12-117**; P5.17). The agent's earlier entry remains valid
(**C12-119**).

```ts
await device1.submit(await device1.sign(await device1.prepareEdit(original, { parent, editors: [grant], author }), device1Signer), host);
await agent.submit(await agent.sign(await agent.prepareEdit(original, { parent, resource: { bytes }, editor: agentRef }), agentSigner), host);
await device1.submit(await device1.sign(await device1.prepareEdit(original, { parent, editors: null, author }), device1Signer), host);
await agent.prepareEdit(original, { parent, resource: { bytes }, editor: agentRef }); // throws EDITOR_NOT_GRANTED
```

<!-- custody-walkthrough output: step 3 -->
```text
device 1 grants the agent (author entry): {
  "status": "accepted",
  "grant": {
    "did": "<agent>",
    "name": false,
    "metadata": false,
    "resource": true
  }
}
agent syncs from the host: imported
what the agent's signer is shown: Signing as editor <agent> with <agent>#agent (DID version <agent v1>)
Original: <original> "Harbor at dawn"
Operation: update
Author: <author> (unchanged; an editor entry carries its parent's author)
Resource: new version zQmbtCni3aaGoAtD8vgoCbUnztiPLiacAjkJCEFJzWkskAj -> zQmbYLaaRYTpd54FekPEK6NFA8VVWYHa8GrpVRWpjxxudDV
agent's editor entry: accepted
device 1 removes the grant (author entry): accepted
agent's further entry is refused before anything is signed: {
  "category": "unauthorized-key",
  "code": "EDITOR_NOT_GRANTED",
  "message": "<agent> has no grant in the parent's state (P5.16, P5.17)"
}
entries:
  <entry 1>  author  <author>#device-1 @ <author v1>
  <entry 2>  author  <author>#device-2 @ <author v2>
  <entry 3>  author  <author>#device-1 @ <author v2>
  <entry 4>  editor  <agent>#agent @ <agent v1>
  <entry 5>  author  <author>#device-1 @ <author v2>
the agent's report after the revocation: {
  "authorBinding": "valid",
  "editors": [
    {
      "did": "<agent>",
      "latestVersionId": "<agent v1>",
      "freshness": "not-established"
    }
  ],
  "historicallyAuthorizedOnly": [],
  "validAsOf": "<entry 5>"
}
```

## 4. Device 2 revoked; its offline entry refused, then re-signed by device 1

Device 2 syncs, then goes offline. The identity key removes `#device-2` from
the author DID (v3), and the owner uploads the v3 log to the host. A verifier
checks the key against the newest author DID version it knows of, never
against the entry's claimed time (P7.8). Under v3, device 1's report keeps the
seal (`<entry 2>`) in a valid checkpoint but lists it as historically
authorized only, `key-not-in-latest-signer-document` (**C12-41**; P7.9).

Device 2 knows only v2. It signs a new resource version offline, naming
`#device-2` at v2, and submits it once back online. The host verifies with
the newest author DID log it holds, v3, and refuses the entry:
`422 { error: "entry_historically_authorized_only", reason: "key-not-in-latest-signer-document" }`
(`packages/host/src/shared-saves.ts` step 5; P7.9, P6.7). Nothing is appended.

Device 2 passes its change, the new bytes, to device 1. Device 1 calls
`reconcile`, which fetches and verifies the host's head and has device 1 sign
the same change against it with `#device-1` at v3. The host accepts it
(**C12-126**; P6.8). The SDK merges nothing and signs nothing for anyone.

```ts
const offline = await device2.sign(await device2.prepareEdit(original, { parent, resource: { bytes }, author: device2AtV2 }), device2Signer);
await device2.submit(offline, host2); // the host answers 422 entry_historically_authorized_only
await device1.reconcile(original, { host: host1, author: device1AtV3, signer: device1Signer, change: { resource: { bytes } } });
```

The `device 2 afterwards` result in the output is a finding. See
[Findings](#findings), F1.

<!-- custody-walkthrough output: step 4 -->
```text
author DID: {
  "<author v3>": {
    "assertionMethod": [
      "#device-1"
    ]
  }
}
the owner uploads the author DID log through v3 to the host
device 1 syncs from the host: already-current
device 1's report: {
  "history": "valid",
  "entries": 5,
  "authorBinding": "valid",
  "identityEvidence": {
    "status": "complete",
    "author": "<author>",
    "latestVersionId": "<author v3>",
    "freshness": "not-established",
    "editors": [
      {
        "did": "<agent>",
        "latestVersionId": "<agent v1>",
        "freshness": "not-established"
      }
    ]
  },
  "resources": "available",
  "ordering": "claimed",
  "fork": null,
  "historicallyAuthorizedOnly": [
    {
      "versionId": "<entry 2>",
      "did": "<author>",
      "role": "author",
      "reason": "key-not-in-latest-signer-document"
    }
  ],
  "validAsOf": {
    "checkpoint": "<entry 5>",
    "signers": [
      {
        "did": "<author>",
        "role": "author",
        "versionId": "<author v3>"
      },
      {
        "did": "<agent>",
        "role": "editor",
        "versionId": "<agent v1>"
      }
    ]
  },
  "current": false
}
device 2 signs offline against <entry 5>: <device 2's offline entry>
the host refuses device 2's entry: {
  "http": 422,
  "body": {
    "error": "entry_historically_authorized_only",
    "reason": "key-not-in-latest-signer-document"
  }
}
device 2 afterwards: {
  "refused": [],
  "pending": "<device 2's offline entry>",
  "localHead": "<entry 5>"
}
device 1 reconciles: {
  "status": "accepted",
  "checkpoint": "<entry 6>"
}
entries:
  <entry 1>  author  <author>#device-1 @ <author v1>
  <entry 2>  author  <author>#device-2 @ <author v2>
  <entry 3>  author  <author>#device-1 @ <author v2>
  <entry 4>  editor  <agent>#agent @ <agent v1>
  <entry 5>  author  <author>#device-1 @ <author v2>
  <entry 6>  author  <author>#device-1 @ <author v3>
```

## 5. Package, then load in a fresh process with no key and no network

Device 1 packages the Original (P7.1). The script checks that no secret is in
the package, in raw, hex, base64 or multibase form. It then runs the SDK's
`originals verify` CLI, which calls `OriginalsSDK.load` with an empty store
and no `authors`, in a new `node` process. That process is started with
[`no-network.mjs`](../packages/host/examples/no-network.mjs), which makes
`fetch`, `net`, `tls` and DNS lookups throw. In the transcript, `originals` is
the SDK's bin. From `packages/host` the command is:

```sh
node --import ./examples/no-network.mjs ../sdk/dist/originals/cli.js verify custody.zip [--json]
```

The package verifies from what it carries (**C12-01**; P7.3). The report
keeps its parts separate (section 7). The Original is valid as of
`<entry 6>` and never current, because it is not anchored (**C12-22**;
P7.10). The seal is still listed as historically authorized only (P7.9).
Each signer DID's freshness is `not-established`: these DIDs have no
witnesses, and asset logs never use them (P7.8, P9.8).

<!-- custody-walkthrough output: step 5 -->
```text
device 1 writes <tmp>/custody.zip (complete, checkpoint <entry 6>)
secret keys in the package: none

$ node --import ./no-network.mjs originals verify custody.zip
verified: <original> at <entry 6>
  resource v1 zQmbtCni3aaGoAtD8vgoCbUnztiPLiacAjkJCEFJzWkskAj verified
  resource v2 zQmbYLaaRYTpd54FekPEK6NFA8VVWYHa8GrpVRWpjxxudDV verified
  resource v3 zQmXY8NHsYynNafiHAX5QCLibucDQjkzhqgP1HaDiFwFWFg verified
  valid as of <entry 6>, not current: not anchored (P7.10)
  author <author> at <author v3>, obtained <time> from package
  editor <agent> at <agent v1>, obtained <time> from package
  The history of <author> was obtained from the evidence package at <time>; its latest version there is <author v3>. Its freshness is not established. The DID may have a newer version, for example one that removes a key, that this verifier has not seen.
  The history of <agent> was obtained from the evidence package at <time>; its latest version there is <agent v1>. Its freshness is not established. The DID may have a newer version, for example one that removes a key, that this verifier has not seen.
  <entry 2>: historically authorized only (key-not-in-latest-signer-document, P7.9)
  not current: not-anchored, historically-authorized-only
exit 0

$ node --import ./no-network.mjs originals verify custody.zip --json
{
  "verified": true,
  "history": "valid",
  "entries": 6,
  "authorBinding": "valid",
  "identityEvidence": {
    "status": "complete",
    "author": "<author>",
    "latestVersionId": "<author v3>",
    "freshness": "not-established",
    "editors": [
      {
        "did": "<agent>",
        "latestVersionId": "<agent v1>",
        "freshness": "not-established"
      }
    ]
  },
  "resources": "available",
  "ordering": "claimed",
  "fork": null,
  "historicallyAuthorizedOnly": [
    {
      "versionId": "<entry 2>",
      "did": "<author>",
      "role": "author",
      "reason": "key-not-in-latest-signer-document"
    }
  ],
  "validAsOf": {
    "checkpoint": "<entry 6>",
    "signers": [
      {
        "did": "<author>",
        "role": "author",
        "versionId": "<author v3>"
      },
      {
        "did": "<agent>",
        "role": "editor",
        "versionId": "<agent v1>"
      }
    ]
  },
  "current": false,
  "reasons": [
    "not-anchored",
    "historically-authorized-only"
  ]
}
exit 0
```

## Findings

Steps 1–3 and 5 behave as the issue expects. Step 4 behaves as expected at
the host and at the reader, with the error code the issue names. The SDK's
handling of the refused candidate does not match what plan 048 §8 says.

**F1. The SDK keeps no `refused` record for a candidate the host refuses as
historically authorized only, and leaves it pending (P6.7, P6.8, P7.9).**
Plan 048 §8 says that "a refused candidate is kept as `refused`, and
`reconcile` has the caller sign a new candidate, with a current key". In the
run, `device2.refused(original)` is empty and `device2.pending(original)`
still returns the refused entry. Two causes:

- `HostAnswer` (`packages/sdk/src/originals/shared.ts`) has only `accepted`,
  `already-accepted` and `stale-parent`. Any other host answer is an error the
  transport throws, so `submit` cannot tell a 422 refusal from an outage. It
  leaves the candidate pending, which is the right handling for a lost answer
  (P6.4).
- P6.8 defines refused candidates only after a stale-parent conflict. P6.7
  does not require the host's historical-only check, which the host makes as
  its step 5 (plan 048 §8). The spec does not say what the SDK keeps after
  this refusal.

The effect: `sdk.pending()` offers a candidate that the host will refuse again
on every retry, and `reconcile({ refused })` cannot name it. The change is not
lost, because the caller still has the bytes and `reconcile` without
`refused` works, as step 4 shows. A `refused` record would not have helped
here anyway, since device 1 re-signs from its own store. Proposed fix: add a
P6.8 sentence saying that a candidate a host refuses because its entry is
historically authorized only (P7.9) is kept with its draft, labelled refused
with the reason, and is no longer pending. In the SDK, add a refused outcome
with a reason to `HostAnswer`, and map the landing's 422 to it in
`landingSharedHost`.

**F2. No section 12 row covers a host refusing a historically-authorized-only
submission.** C12-41 covers the verifier's report. The landing test
`apps/landing/src/sdk/shared-host.test.ts` cites C12-127 for the host
refusal, but C12-127 is "Host changes or re-signs a submitted entry". Step 4
cites C12-41 for both. A spec row for the host behaviour would go with the F1
spec change.

**Side note (not part of the issue).** Step 2's refusal of the identity key
has category `invalid-evidence`, code `COMMIT_VERIFICATION_FAILED`, while the
report attached to the error has `authorBinding: "failed"`. Spec section 6
suggests an author binding failure category, so a caller that branches on
`category` sees an evidence error, not an author-binding error.

## Not covered here

- Bitcoin anchoring, which gives proven ordering and settles forks (P9.16).
  Every result here is claimed ordering, valid as of a checkpoint.
- Established freshness, which needs witnesses on the author DID (P7.8).
- P-256 device keys. Only `eddsa-jcs-2022` and `bip340-jcs-2025` keys sign
  entries (P5.12).
