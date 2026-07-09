# Plan 020: CEL verification must cryptographically check EVERY proof (resolve did:webvh/did:btco keys; fail closed)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Touch
> only the files listed as in scope. If a STOP condition occurs, stop and
> report. Commit on the worktree branch (conventional commits; if the husky
> `commit-msg` hook fails for missing deps, use `git commit --no-verify` and
> note it). Before reporting, audit every claim against an actual tool result.
> SKIP updating `plans/README.md` — the reviewer maintains the index.

## Worktree setup (REQUIRED FIRST)

Your worktree branches from `main`. The target is the PR branch on the remote.
At the worktree root:
1. `git fetch origin && git merge --no-verify --no-edit origin/improve/audit-2026-06-11-run2` — clean fast-forward onto the PR branch (which already contains plans 014–019 + the fail-closed fix `54170ab`).
2. `git log --oneline -1` should show `fix(sdk): fail closed on non-Ed25519 did:key CEL proofs...` (`54170ab`) or later; `ls packages/sdk/src/cel/canonicalize.ts` must exist.
3. `bun install`.
4. Baseline (run with a clean env if you hit a NODE_OPTIONS preload error: prefix commands with `NODE_OPTIONS=`): `cd packages/sdk && NODE_OPTIONS= bunx tsc --noEmit -p .` → exit 0; `NODE_OPTIONS= bun test tests/unit/cel` → all pass.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: 014 (canonicalize), 015 (did:key crypto) — both already on the PR branch.
- **Category**: security
- **Planned at**: PR branch `improve/audit-2026-06-11-run2` @ `54170ab`, 2026-06-19

## Why this matters

CEL verification currently only cryptographically checks `did:key` proofs (the
public key is embedded in the identifier). For `did:webvh` and `did:btco`
proofs — whose keys live in an HTTPS-hosted log or on Bitcoin — it does **no
signature check** and still returns `verified: true` (only flagging
`cryptographicallyVerified: false`). A forged log using those methods, or even
a `did:key` with `cryptosuite: 'eddsa-rdfc-2022'`, passes `result.verified`.

The maintainer's decision: **every signature must be cryptographically
verified; if a key cannot be obtained, the proof must fail closed.** Structural
well-formedness must never by itself yield `verified: true`. This makes CEL
verification actually trustworthy for all three DID methods.

The enabler already exists: `DIDManager.resolveDID(did)` resolves all three
methods to a DID document (did:peer/did:key offline; did:webvh over HTTPS;
did:btco via the configured Ordinals provider). We inject a key resolver built
on it into `verifyEventLog`.

## Current state

All paths under `packages/sdk/`:

- `src/cel/algorithms/verifyEventLog.ts`
  - `structuralCheck(proof)` (~line 30) — field/prefix/cryptosuite checks;
    accepts `['eddsa-jcs-2022', 'eddsa-rdfc-2022']` (line ~45).
  - `verifyDidKeyEd25519Proof(proof, data)` (~line 70) — extracts the embedded
    key from a `did:key` VM, decodes the multibase signature, verifies
    `verifyAsync(sig, canonicalizeEvent(data), pubkey)`. Returns
    `{ verified, cryptographicallyVerified }`. Already fails closed for
    non-Ed25519 keys (`54170ab`).
  - `dispatchVerify(proof, data)` (~line 132) — routes `did:key` +
    `eddsa-jcs-2022` to crypto; **everything else returns
    `{ verified: structuralCheck(proof), cryptographicallyVerified: false }`**
    — this is the fail-open path to remove.
  - `verifyEvent(event, index, customVerifier, previousEvent)` — uses
    `customVerifier` if supplied, else `dispatchVerify`. Builds the signed
    payload `eventData = { type, data, ...(previousEvent ? { previousEvent } : {}) }`.
  - `verifyEventLog(log, options?)` (~line 280) — top level; `options.verifier`
    overrides.
- `src/cel/types.ts` — `VerifyOptions { verifier? }` (~line 127); add `resolveKey?` here.
- `src/cel/OriginalsCel.ts:289` — `verify(log, options)` → `return verifyEventLog(log, options)` (pass-through; leave as-is, it forwards new options).
- `src/cel/cli/verify.ts:232` — `result = await verifyEventLog(eventLog)` (no resolver today).
- `src/verify/UnifiedVerifier.ts` — `constructor(private didManager: DIDManager)` (line 47); `verifyEventLog(document as EventLog)` at line ~64 (no resolver today). This class already has a DIDManager.
- `src/did/DIDManager.ts` — `resolveDID(did, options?)` returns `Promise<DIDDocument | null>`, resolving all three methods.
- `src/crypto/Multikey.ts` — `multikey.decodePublicKey(mb)` → `{ key: Uint8Array; type: MultikeyType }`; `multikey.decodeMultibase(mb)` → `Uint8Array` (z-base58btc).
- DID document verification methods: inspect `src/types/did.ts` for the
  `VerificationMethod` shape (expect `id`, `type`, `controller`,
  `publicKeyMultibase`). Match a VM by `id === verificationMethod`, falling
  back to fragment match.

Repo conventions: relative imports within a package; `@noble/ed25519`
`verifyAsync`; tests in `bun:test`.

## The design

Inject an Ed25519-key resolver into verification. `did:key` stays verified
locally (offline). Every other method is verified via the resolver. With no
resolver, non-`did:key` proofs **fail closed**. Structural validity is only a
precondition — it never alone produces `verified: true`.

New `VerifyOptions` field (in `src/cel/types.ts`):

```typescript
/**
 * Resolves the Ed25519 public key bytes for a proof's verificationMethod.
 * Required to verify proofs whose key is NOT embedded in the identifier
 * (did:webvh, did:btco, did:peer). Return null when the method cannot be
 * resolved or its key is not Ed25519 — the proof then fails closed.
 */
resolveKey?: (verificationMethod: string) => Promise<Uint8Array | null>;
```

## Commands you will need

| Purpose | Command (worktree root; prefix `NODE_OPTIONS=` if you see a preload error) | Expected |
|---|---|---|
| Typecheck | `cd packages/sdk && NODE_OPTIONS= bunx tsc --noEmit -p .` | exit 0 |
| Proof tests | `cd packages/sdk && NODE_OPTIONS= bun test tests/unit/cel/proof-verification.test.ts` | all pass |
| CEL suite | `cd packages/sdk && NODE_OPTIONS= bun test cel` | all pass |
| Full suite | `cd packages/sdk && NODE_OPTIONS= bun test tests/integration tests/unit tests/security` | 0 fail (the `MetricsIntegration` "createDIDPeer totalTime>0" test is a known sub-ms flake — rerun once; if it's the only failure and passes alone, that's the known flake) |

## Scope

**In scope:**
- `packages/sdk/src/cel/types.ts` (add `resolveKey?` to `VerifyOptions`)
- `packages/sdk/src/cel/algorithms/verifyEventLog.ts` (dispatch rewrite, thread `resolveKey`)
- `packages/sdk/src/cel/keyResolver.ts` (CREATE — DIDManager-backed resolver helper)
- `packages/sdk/src/cel/index.ts` (export the helper)
- `packages/sdk/src/verify/UnifiedVerifier.ts` (pass a resolver)
- `packages/sdk/src/cel/cli/verify.ts` (build + pass a resolver; warning-line update)
- `packages/sdk/tests/unit/cel/proof-verification.test.ts` (update test 5; add resolver tests)
- `packages/sdk/tests/unit/cel/cli-verify.test.ts` (if it asserts old structural-pass behavior)
- Any integration test that builds did:webvh/did:btco logs and calls verify
  (e.g. `tests/integration/cel-lifecycle.test.ts`, `tests/unit/cel/OriginalsCel.test.ts`) — update to pass a resolver OR use did:key signers, so they still pass. **List every test file you change and why.**

**Out of scope:**
- `src/cel/canonicalize.ts`, `src/cel/hash.ts`, the VC subsystem (`src/vc/**`),
  `DIDManager.resolveDID` internals (consume it).
- `OriginalsCel`'s constructor — leave it without a DIDManager; its `verify`
  stays a pass-through that forwards `options` (callers/SDK supply `resolveKey`).
- Adding new CLI network flags beyond what's needed to construct a DIDManager
  with sensible defaults (see Step 5).

## Git workflow

- Branch: the worktree branch (after the setup merge). Commit message:
  `feat(sdk): cryptographically verify all CEL proofs via DID resolution; fail closed when unresolvable`.
- Do NOT push or open a PR — the reviewer integrates.

## Steps

### Step 1: Add `resolveKey` to `VerifyOptions`
Edit `src/cel/types.ts` as shown in "The design".
**Verify:** `NODE_OPTIONS= bunx tsc --noEmit -p .` → exit 0.

### Step 2: Rewrite `dispatchVerify` to verify all methods, fail closed
In `verifyEventLog.ts`, change `verifyEvent` to accept and thread the resolver,
and rewrite `dispatchVerify(proof, data, resolveKey?)`:

1. `if (!structuralCheck(proof)) return { verified: false, cryptographicallyVerified: false };`
2. `if (proof.cryptosuite !== 'eddsa-jcs-2022') return { verified: false, cryptographicallyVerified: false };`
   (CEL signatures are Ed25519-over-JCS; any other suite — incl. `eddsa-rdfc-2022` — cannot be verified here and must fail closed. This also closes the `did:key` + `eddsa-rdfc-2022` hole.)
3. Obtain the public key:
   - `did:key:` VM → extract embedded key locally (reuse the existing
     `verifyDidKeyEd25519Proof` extraction; refactor its key-extraction into a
     small helper `extractEd25519FromDidKey(vm): Uint8Array | null` returning
     null for non-Ed25519). No resolver needed → works offline.
   - otherwise → `if (!resolveKey) return { verified:false, cryptographicallyVerified:false };`
     then `const publicKey = await resolveKey(proof.verificationMethod);`
4. `if (!publicKey) return { verified:false, cryptographicallyVerified:false };`
5. `try { const ok = await verifyAsync(multikey.decodeMultibase(proof.proofValue), canonicalizeEvent(data), publicKey); return { verified: ok, cryptographicallyVerified: ok }; } catch { return { verified:false, cryptographicallyVerified:false }; }`

Update `verifyEventLog` to read `options?.resolveKey` and pass it down through
`verifyEvent` → `dispatchVerify`. Keep the `options.verifier` custom path
exactly as-is (overrides everything; sets `cryptographicallyVerified:false`).
`verifyDidKeyEd25519Proof` remains exported and behaves as today (it can stay,
or be reduced to call the shared helper — your choice, but keep its export and
semantics).

**Net effect:** structural validity alone NEVER yields `verified:true`; a real
signature check happens for every proof or it fails closed.

**Verify:** `NODE_OPTIONS= bunx tsc --noEmit -p .` → exit 0.

### Step 3: Create the DIDManager-backed resolver helper
Create `src/cel/keyResolver.ts`:

```typescript
import type { DIDManager } from '../did/DIDManager';
import { multikey } from '../crypto/Multikey';

/**
 * Builds a CEL key resolver from a DIDManager. Resolves the proof's
 * verificationMethod DID to a DID document, finds the matching verification
 * method, and returns its Ed25519 public key bytes (or null if unresolvable
 * or not Ed25519 — caller then fails closed).
 */
export function createDidManagerKeyResolver(didManager: DIDManager) {
  return async (verificationMethod: string): Promise<Uint8Array | null> => {
    try {
      const did = verificationMethod.split('#')[0];
      const doc = await didManager.resolveDID(did);
      const vms = doc?.verificationMethod;
      if (!Array.isArray(vms)) return null;
      const vm =
        vms.find(v => v.id === verificationMethod) ??
        vms.find(v => v.id.split('#')[1] === verificationMethod.split('#')[1]);
      if (!vm?.publicKeyMultibase) return null;
      const decoded = multikey.decodePublicKey(vm.publicKeyMultibase);
      return decoded.type === 'Ed25519' ? decoded.key : null;
    } catch {
      return null;
    }
  };
}
```

Confirm the `VerificationMethod` field names against `src/types/did.ts` and
adjust (`publicKeyMultibase`, `id`). Export from `src/cel/index.ts`.

**Verify:** `NODE_OPTIONS= bunx tsc --noEmit -p .` → exit 0.

### Step 4: Wire `UnifiedVerifier`
In `src/verify/UnifiedVerifier.ts`, where it calls `verifyEventLog(document as EventLog)`,
pass `{ resolveKey: createDidManagerKeyResolver(this.didManager) }`.
**Verify:** `NODE_OPTIONS= bunx tsc --noEmit -p .` → exit 0.

### Step 5: Wire the CLI verify command
In `src/cel/cli/verify.ts`, construct a `DIDManager` (import from
`../../did/DIDManager`) with a sensible default config (network from an existing
flag/env if present, else `mainnet`; mirror how other CLI commands build SDK
config — check a sibling like `cli/resolve.ts` for the pattern) and pass
`{ resolveKey: createDidManagerKeyResolver(didManager) }` to `verifyEventLog`.
Update the output: a proof that could not be verified now makes the log
`verified:false` (it is an error, not a "structure only" pass) — adjust/remove
the old `cryptographicallyVerified === false` warning line accordingly, and
ensure failed verification prints a clear reason. did:key logs must still verify
offline without network. **If constructing a DIDManager in the CLI requires
config the command doesn't have and can't reasonably default, STOP and report**
(don't invent network flags beyond a simple optional `--network`).

**Verify:** `NODE_OPTIONS= bun test tests/unit/cel/cli-verify.test.ts` → pass.

### Step 6: Update and add tests
In `tests/unit/cel/proof-verification.test.ts`:
- **Update test 5** (currently asserts a `did:webvh` proof → `verified:true`
  structurally). New spec: with **no** `resolveKey`, a `did:webvh` proof now
  **fails closed** → `result.verified === false`. Keep the
  `cryptographicallyVerified === false` assertion for that event.
- **Add**: a `did:webvh` (or generic non-did:key) proof signed by a real
  Ed25519 key, verified WITH a mock `resolveKey` that returns that key's bytes
  → `verified: true`. Tamper the data → `verified:false`. Mock `resolveKey`
  returns `null` → `verified:false` (fail closed).
- **Keep** the existing did:key round-trip / tamper / wrong-key / non-Ed25519
  cases passing (they need no resolver).
- The forged `eddsa-rdfc-2022` case is now covered by Step 2.2 — add a quick
  case: a structurally-valid proof with `cryptosuite: 'eddsa-rdfc-2022'` +
  did:key → `verified:false`.

For integration/other CEL tests that build did:webvh/did:btco logs and call
`verify`/`verifyEventLog` and previously relied on structural pass: pass a
resolver (a `createDidManagerKeyResolver(new DIDManager(config))`, or a mock
returning the signer's public key). Prefer the smallest change that keeps the
test's intent. **List each changed test file and the reason.**

**Verify:** `NODE_OPTIONS= bun test tests/unit/cel/proof-verification.test.ts` → all pass.

### Step 7: Full suite
**Verify:** `NODE_OPTIONS= bun test tests/integration tests/unit tests/security`
→ 0 fail (known MetricsIntegration sub-ms flake excepted — rerun once).

## Test plan
- Updated test 5 (fail-closed without resolver) + new resolver-based
  pass/tamper/null cases + the `eddsa-rdfc-2022` rejection — all in
  `proof-verification.test.ts`. Model the real-Ed25519 signer on the existing
  cases in that file. Plus whatever integration tests needed a resolver.

## Done criteria (ALL must hold)
- [ ] `NODE_OPTIONS= bunx tsc --noEmit -p .` exits 0
- [ ] A non-`did:key` proof with **no** `resolveKey` → `verified:false` (proven by updated test 5)
- [ ] A non-`did:key` proof with a correct `resolveKey` → `verified:true`; tampered → `verified:false`
- [ ] `eddsa-rdfc-2022` (any VM) → `verified:false`
- [ ] did:key logs still verify offline (no resolver) — existing cases pass
- [ ] `grep -n "verified: structuralCheck" packages/sdk/src/cel/algorithms/verifyEventLog.ts` → no matches (the fail-open line is gone)
- [ ] Full suite 0 fail (known flake excepted)
- [ ] No out-of-scope files modified

## STOP conditions
- The setup merge conflicts (pre-verified clean — a conflict means drift).
- Constructing a `DIDManager` in the CLI needs config the command can't
  reasonably provide/default (Step 5) — report what's missing.
- An integration test's intent genuinely can't be preserved with a resolver
  (e.g. it depends on verifying a log whose signer key isn't recoverable) —
  report it rather than weakening the verifier or deleting the assertion.
- `DIDManager.resolveDID` does not return `publicKeyMultibase` on resolved VMs
  for did:webvh (so keys can't be extracted) — report; the resolver contract
  would need rethinking.
- Any verification fails twice after a reasonable fix attempt.

## Maintenance notes
- After this, `cryptographicallyVerified` is `true` whenever `verified` is
  `true` on the default path (every pass is a real crypto check). The flag is
  retained for API stability and for the custom-verifier path; consider
  documenting that `verified` now always implies a signature check.
- did:btco verification requires the Ordinals provider/network that
  `DIDManager.resolveDID` uses; in offline/test contexts pass a mock
  `resolveKey`. Reviewer should confirm the CLI's did:btco path degrades to a
  clear fail-closed error when no provider is configured.
- This is the capability the unified-`verify()` work (plan 013) anticipated;
  `sdk.verify` / `UnifiedVerifier` now inherits real CEL verification for all
  DID methods.
