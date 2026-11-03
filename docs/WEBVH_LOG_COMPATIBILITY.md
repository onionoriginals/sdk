# did:webvh log compatibility

## didwebvh-ts 2.8.0 → 3.0.0

Logs written under 2.8.0 resolve unchanged under 3.0.0, and `@originals/vh`
verifies both (`packages/vh/tests/fixtures/didwebvh-ts-*.json`). Nothing needs
re-creating. New writes differ from 2.8.0 in three ways:

- an update that does not change witnesses omits `witness`, so the active
  witnesses stay in force (2.8.0 wrote `witness: {}`, which turned them off);
- moving a portable DID rewrites each verification method `controller` that
  names the old DID to the new DID (2.8.0 left the old DID);
- a single-label host such as `localhost` is not a did:webvh domain. The SDK
  rejects it with `INVALID_DOMAIN`; `@originals/vh` never parsed one.

A genesis entry written through the SDK is byte-identical to what 2.8.0 wrote
for the same inputs (`packages/sdk/tests/unit/did/webvh-document.test.ts`).

## didwebvh-ts ≤2.7.5 → 2.8.0

### Who is affected

Any persisted or published `did.jsonl` produced by SDK versions that pinned
`didwebvh-ts` **2.7.5 or earlier**. Those versions wrote `updateKeys` entries
in the prefixed `did:key:z6Mk...` form **inside signed log entries**.

### What breaks

`didwebvh-ts` 2.8.0's `isKeyAuthorized` requires `updateKeys` entries to be
bare multikeys (`z6Mk...`, per the did:webvh spec) and compares them to the
multikey parsed from each proof's `did:key:` verification method. Resolution
of old logs therefore fails with:

```
Key did:key:z6Mk... is not authorized to update
```

The affected entries are signed — they **cannot be rewritten** without
breaking the log's hash/proof chain.

### How to check a log

Inspect the first line of `did.jsonl`: if
`parameters.updateKeys` contains values starting with `did:key:`, the log is
in the legacy format and will not resolve under didwebvh-ts ≥2.8.0.

New logs created by the SDK (didwebvh-ts 2.8.0+) write the spec-compliant
bare-multikey form and are unaffected.

### Options

1. **Re-create affected DIDs** (recommended when feasible): create a new
   did:webvh with the current SDK and republish; update references to the old
   DID. Asset provenance held in CEL event logs is independent of the DID log
   and carries over.
2. **Pin didwebvh-ts ≤2.7.5 for resolution only**: a resolver that must keep
   serving legacy logs can resolve them with the old library version while
   new writes use ≥2.8.0. Do not mix versions for writes.
3. **Upstream backward compatibility**: didwebvh-ts could accept the legacy
   prefixed form during verification (`did:key:`-prefix stripping in
   `isKeyAuthorized`). Track/raise this with the didwebvh-ts project if you
   operate a large corpus of legacy logs.
