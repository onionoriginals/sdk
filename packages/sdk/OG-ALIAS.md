# `originals-og alias`: a did:webvh alias for an existing did:og Original

Give an existing did:og Original a web address (a did:webvh alias, P3.6) without changing its ID or author, and without the SDK ever holding a key. Both logs are signed outside the SDK:

- the **next did:og entry**, signed by the Original's existing author key. It adds the alias and changes nothing else.
- the **alias's did:webvh log**, signed by the alias's own update key. Its DID document lists the did:og in `alsoKnownAs`.

The command takes no key, signs nothing, writes nothing and reads no network. **A verified check is not a hosted alias.** Nothing is served at the alias's URL until a host publishes its `did.jsonl` and the package (P14.11), and until then no one else can resolve it.

## Steps

```sh
# 1. The bundle verifies, and its checkpoint is the single head of an unanchored history.
originals-og alias inspect  --bundle <bundle.zip>

# 2. Where the alias's update key lives: create the alias's did.jsonl with
#    alsoKnownAs: ["<did:og>"], then take its DID.

# 3. The exact entry to sign. stderr names the checkpoint it extends and the verification method.
originals-og alias unsigned --bundle <bundle.zip> --alias <did:webvh:…> > unsigned.json

# 4. Where the author key lives: signEntry(unsigned, verificationMethod, signer)
#    from @originals/vh/og, then write the result as one line to next-entry.jsonl.

# 5. Check both. Exit 0 only when every check passes.
originals-og alias verify   --bundle <bundle.zip> --entry next-entry.jsonl --alias-log did.jsonl [--json]
```

## Checks (`checkAliasUpdate`, @originals/vh/og)

| id | rule |
| --- | --- |
| `imported` | The bundle verifies. Every entry is accepted, the checkpoint is the single head (P2.1, P4.5), and nothing is anchored (P9.10). |
| `entry` | Exactly one entry line (P14.2, P14.13). |
| `extends-checkpoint` | It extends that checkpoint exactly: no stale parent, no new genesis (P14.29, P14.27). |
| `alias-only` | *Policy:* same ID, author, media, name and metadata; no transition; exactly one added did:webvh alias; none removed. |
| `signed-by-author` | The did:og verifier accepts it as signed by the author's current key (P5.3, P5.8). |
| `media-unchanged` | No supplied bytes mismatch their digest, and the current version's bytes are present (P4.3, P7.4, P7.17). |
| `alias-log` | The alias's did:webvh log verifies. |
| `backlink` | Its DID document lists the did:og in `alsoKnownAs` (P3.6). |
| `links-agree` | The entry lists exactly that alias, and the alias names exactly this Original (P3.6). |
| `separate-signer` | *Policy:* the alias log's update keys are not the author identity's. Pass `requireSeparateSigner: false` to waive. |

An anchored Original cannot gain a new did:webvh alias (P9.10). The alias has to come before anchoring.

## Tests

`packages/vh/tests/og-alias-update.test.ts` and `packages/sdk/tests/unit/og/og-alias.test.ts`.
