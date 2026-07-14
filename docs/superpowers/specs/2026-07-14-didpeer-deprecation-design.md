# Design: did:peer deprecation (full purge)

> did:cel epic — Phase 4, sub-project 5 (the LAST). did:cel replaced did:peer as
> the genesis layer (#398/#401/#406). Now remove did:peer entirely. Safe: no
> external consumers, nothing released, so "legacy support" only protects
> in-repo fixtures. Branches off main (has #406's `did:cel` LayerType entry).

## 0. Decision record

- **Depth:** full purge — remove the did:peer *creation path*, the did:peer
  *genesis layer*, its migration branch, and the `'did:peer'` `LayerType` entry.
  did:cel becomes the only genesis. Update examples.
- **Out of scope (belongs elsewhere):**
  - `CredentialManager.verifyCredentialChain` — part of the shelved VC-derivation
    sub-project (#405), *not* this. Leave it.
  - `MigrationManager` / `migration/*` did:peer refs — experimental, unexported
    (#279). Leave it.
- **Migration safety (verified):** `DIDManager.migrateToDIDWebVH` already branches
  `method === 'did:peer' ? parts.slice(2)… : parts[parts.length-1]`. did:cel uses
  the else branch, so removing the did:peer branch does NOT break did:cel→webvh.

## 1. What gets removed

- **`DIDManager.createDIDPeer`** — the three overloads + implementation
  (`src/did/DIDManager.ts:113-171`) and the `@aviarytech/did-peer` create import
  if now unused. The did:peer numalgo-4 helper comments/logic tied only to
  creation.
- **`LayerType`** (`src/types/common.ts:10`) → `'did:cel' | 'did:webvh' | 'did:btco'`
  (drop `'did:peer'`).
- **`OriginalsAsset`**
  - `determineCurrentLayer` — remove the `did:peer:` → `'did:peer'` branch; a
    did:cel genesis already returns `'did:cel'` (#406). No did:peer id can occur
    post-purge; if one is passed, fail loudly (StructuredError) rather than
    silently mislabel.
  - `validTransitions` — remove the `'did:peer'` key (kept-for-legacy in #406);
    keep `'did:cel'`.
- **`DIDManager.migrateToDIDWebVH`** — remove the `method === 'did:peer'` slug
  branch and its "longest did:peer suffix" comment; keep the `else`
  (`parts[parts.length-1]`) path that did:cel uses.
- **`replayProvenance` / `LifecycleManager`** — remove any residual did:peer
  layer branches (the fold default is already `'did:cel'` after #406). Sweep for
  dead `'did:peer'` comparisons.
- **Examples** (`src/examples/*.ts`) — `basic-usage`, `create-module-original`,
  `create-document-original`, `full-lifecycle-flow`: replace `createDIDPeer`
  usage with the did:cel genesis path (`sdk.lifecycle.createAsset`).
- **Other did:peer references** (`WebVHManager`, `kinds/validators/base`,
  `documentLoader`, `EventEmitter`, `repl`): remove each did:peer-specific,
  now-dead reference, keeping build + suite green. If a reference is pure
  method-parsing that is genuinely dead post-purge, remove it; if removing it
  is non-trivial or risks scope creep, leave a `// did:peer purged (#<this>)`
  note and flag it — do NOT chase into #405/#279 territory.

## 2. Out of scope / unchanged

- `verifyCredentialChain` (#405), `MigrationManager` (#279) — untouched.
- did:webvh / did:btco / did:cel behavior — unchanged.
- The `ResourceMigrated` credential `fromLayer` TODO (flagged in #406) — that's a
  credentials concern for #405, not this.

## 3. Back-compat

Hard purge. Any in-repo test/fixture that CONSTRUCTS a did:peer asset (via
`createDIDPeer` or a hand-built `did:peer:` DID) is removed or converted to the
did:cel genesis path. Tests asserting did:peer behavior are deleted (the behavior
is gone), not "expected to still work".

## 4. Testing spine

- `createDIDPeer` no longer exists (removed from the public API / DIDManager).
- `createAsset` (did:cel genesis) + `publishToWeb` (did:cel→webvh) + inscribe
  still work end-to-end (the migration else-branch handles did:cel).
- `LayerType` has no `'did:peer'`; a did:cel asset reports `'did:cel'`, migrates
  fine (validTransitions has `'did:cel'`).
- Examples compile and run against the did:cel path.
- Full `bun test` green; `tsc` clean; no dangling `'did:peer'` references outside
  the explicitly-out-of-scope files (#405 verifyCredentialChain, #279 migration).

## 5. Changeset

`@originals/sdk` **major** (breaking) — `DIDManager.createDIDPeer` removed;
`'did:peer'` removed from `LayerType`; the did:peer genesis layer and its
migration branch are gone. did:cel is the sole genesis layer. (Rolls into the
already-pending 3.0.0.)
