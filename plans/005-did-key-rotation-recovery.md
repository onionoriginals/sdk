# Plan 005: Implement `rotateDIDWebVHKeys` and `recoverDIDWebVH`

> **Executor instructions**: Follow step by step; run every verification command
> and confirm the expected result. Honor STOP conditions. When done, update this
> plan's row in `plans/README.md`. This is an L-effort plan — read the entire
> plan and the referenced test file before writing any code.
>
> **Drift check (run first)**: `git diff --stat 879ab0c..HEAD -- packages/sdk/src/did/DIDManager.ts packages/sdk/src/did/WebVHManager.ts packages/sdk/tests/unit/did/DIDManager.rotation.test.ts`
> If any changed, compare excerpts to live code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none (but 003 makes the suite compile, easing verification)
- **Category**: bug / tests
- **Planned at**: commit `879ab0c`, 2026-06-11

## Why this matters

`tests/unit/did/DIDManager.rotation.test.ts` (and a sibling WebVHManager rotation
suite) call `didManager.rotateDIDWebVHKeys(...)` and `didManager.recoverDIDWebVH(...)`,
but neither method exists — every one of these ~15 tests fails with
`is not a function`. These are security-critical key-lifecycle operations:
rotating a `did:webvh` signing key, and recovering control after a key
compromise. The tests are already written and detailed (they assert log growth,
identity preservation, fresh keys, per-entry proofs, and a W3C
`KeyRecoveryCredential`), so this is a characterization suite waiting for an
implementation. After this plan, both methods exist and the suite passes.

## Current state

- `packages/sdk/src/did/DIDManager.ts` — has `createDIDWebVH(options)` (`:261`)
  and `updateDIDWebVH(options)` (`:385`) but no rotate/recover. `updateDIDWebVH`
  is the building block: it produces a new signed log entry for a `did:webvh`.
- `packages/sdk/src/did/WebVHManager.ts` — has `createDIDWebVH` (`:152`) and
  `updateDIDWebVH` (`:409`, signature:
  `{ did, currentLog, updates, signer, verifier?, outputDir? }`). Uses
  `didwebvh-ts` under the hood; signing via an internal `Ed25519Signer` adapter
  or an `ExternalSigner`.
- `packages/sdk/tests/unit/did/DIDManager.rotation.test.ts` — the contract.

The exact API the tests require:

`rotateDIDWebVHKeys`:
```ts
const rotateResult = await didManager.rotateDIDWebVHKeys({
  did: createResult.did,
  currentLog: createResult.log,
  currentKeyPair: createResult.keyPair,   // { publicKey, privateKey } multibase
  newKeyPair?: customKeyPair,             // optional; generated if absent
  outputDir?: tempDir,                    // optional; if set, save log, return logPath
});
// returns: { log, didDocument, newKeyPair, logPath? }
// asserts: log.length === currentLog.length + 1
//          didDocument.id === did (identity preserved)
//          newKeyPair.publicKey !== currentKeyPair.publicKey, matches /^z/
//          every log entry has proof[] with proofValue + verificationMethod
```

`recoverDIDWebVH`:
```ts
const recoveryResult = await didManager.recoverDIDWebVH({
  did, currentLog, signingKeyPair,        // current (compromised) key signs the recovery
  recoveryKeyPair?,                        // optional new key; generated if absent
  outputDir?,
});
// returns: { log, didDocument, newKeyPair, recoveryCredential, logPath? }
// asserts: log.length === currentLog.length + 1
//          recoveryCredential.type includes 'VerifiableCredential' and 'KeyRecoveryCredential'
//          recoveryCredential.credentialSubject.recoveryReason === 'key_compromise'
//          recoveryCredential['@context'] includes 'https://www.w3.org/2018/credentials/v1'
//          recoveryCredential.credentialSubject.previousVerificationMethods is an array
//          recoveryCredential.credentialSubject.newVerificationMethod is defined
//          last log entry proof has proofValue + created
//          after recovery, rotateDIDWebVHKeys works with the recovered key
```

**Convention to follow:** build both methods as thin orchestration over the
existing `updateDIDWebVH`. Read `DIDManager.updateDIDWebVH` (`:385`) and
`WebVHManager.updateDIDWebVH` (`:409`) fully first — they already create a signed
log entry that changes the DID document's verification methods. Rotation is
"update with new key as the verification method"; recovery is "rotation plus
emit a KeyRecoveryCredential."

## Commands you will need

| Purpose | Command (from repo root) | Expected |
|---------|--------------------------|----------|
| Rotation tests | `cd packages/sdk && bun test tests/unit/did/DIDManager.rotation.test.ts` | all pass |
| WebVH rotation tests | `cd packages/sdk && bun test tests/unit/did/WebVHManager.rotation.test.ts` (if present) | all pass |
| DID tests | `cd packages/sdk && bun test tests/unit/did` | all pass |
| Typecheck | `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 \| grep "DIDManager\|WebVHManager"` | empty |

## Scope

**In scope:**
- `packages/sdk/src/did/WebVHManager.ts` (add rotation/recovery primitives if the
  did:webvh log work belongs here)
- `packages/sdk/src/did/DIDManager.ts` (add the public `rotateDIDWebVHKeys` /
  `recoverDIDWebVH` methods, delegating to WebVHManager)
- Types for the new options/results (co-locate with the existing WebVH option
  types in `WebVHManager.ts` or `src/types/did.ts`)

**Out of scope:**
- `did:peer` and `did:btco` flows.
- Changing `createDIDWebVH` / `updateDIDWebVH` behavior — build ON them.
- The `didwebvh-ts` dependency internals.

## Git workflow

- Branch: `advisor/005-did-key-rotation-recovery`
- Conventional Commits, e.g. `feat(sdk): implement did:webvh key rotation and recovery`.
- No push/PR unless instructed.

## Steps

### Step 1: Read the building block and confirm it supports changing keys

Read `WebVHManager.updateDIDWebVH` (`:409`) and `DIDManager.updateDIDWebVH`
(`:385`) end to end. Confirm `updates` can change the verification method /
update key to a new key pair, and that it returns the new `log` and
`didDocument`. **STOP and report** if `updateDIDWebVH` cannot rotate the signing
key (i.e. didwebvh-ts doesn't expose key rotation) — then this needs a different
approach and the maintainer should weigh in.

### Step 2: Implement `rotateDIDWebVHKeys` on WebVHManager, expose on DIDManager

In WebVHManager, add a method that:
1. generates `newKeyPair` (via `KeyManager.generateKeyPair('Ed25519')`) unless
   one is supplied,
2. calls `updateDIDWebVH` with the CURRENT key pair as the signer and an
   `updates` payload that sets the DID document's verification method to the new
   key,
3. returns `{ log, didDocument, newKeyPair, logPath? }` (save the log when
   `outputDir` is set, mirroring how `createDIDWebVH` saves via `saveDIDLog`).

Add `DIDManager.rotateDIDWebVHKeys(options)` delegating to it.

**Verify**: `cd packages/sdk && bun test tests/unit/did/DIDManager.rotation.test.ts -t "rotateDIDWebVHKeys"` → the 4 rotation tests pass.

### Step 3: Implement `recoverDIDWebVH`

Add a method that:
1. performs the same key change as rotation (current/compromised key signs the
   recovery entry, new `recoveryKeyPair` becomes the verification method),
2. builds a `KeyRecoveryCredential` — a W3C VC with:
   - `@context` including `https://www.w3.org/2018/credentials/v1`,
   - `type: ['VerifiableCredential', 'KeyRecoveryCredential']`,
   - `issuer` = the DID,
   - `issuanceDate` ISO string,
   - `credentialSubject` with `recoveryReason: 'key_compromise'`,
     `previousVerificationMethods` (array of the old VM ids/keys), and
     `newVerificationMethod` (the new VM),
3. returns `{ log, didDocument, newKeyPair, recoveryCredential, logPath? }`.

Add `DIDManager.recoverDIDWebVH(options)` delegating to it.

**Verify**: `cd packages/sdk && bun test tests/unit/did/DIDManager.rotation.test.ts -t "recoverDIDWebVH"` → the 5 recovery tests pass.

### Step 4: Full DID suite + typecheck

**Verify**:
- `cd packages/sdk && bun test tests/unit/did` → all pass.
- `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep "DIDManager\|WebVHManager"` → empty.

## Test plan

- The two rotation/recovery suites are the spec — make them pass without
  weakening assertions.
- If a `WebVHManager.rotation.test.ts` exists, it must pass too (find with
  `ls packages/sdk/tests/unit/did | grep -i rotation`).
- Add no new tests unless you find an uncovered branch; the existing suites are
  thorough.
- Verification: `cd packages/sdk && bun test tests/unit/did` → all pass.

## Done criteria

ALL must hold:

- [ ] `cd packages/sdk && bun test tests/unit/did/DIDManager.rotation.test.ts` → all pass
- [ ] Any `WebVHManager.rotation.test.ts` → all pass
- [ ] `grep -n "rotateDIDWebVHKeys\|recoverDIDWebVH" packages/sdk/src/did/DIDManager.ts` → both found
- [ ] `cd packages/sdk && bun test tests/unit/did` → all pass
- [ ] `tsc` error count not increased vs baseline
- [ ] No out-of-scope files modified (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- `updateDIDWebVH` cannot rotate the signing key (Step 1) — report.
- The recovery credential shape the tests assert cannot be produced from
  available data (e.g. previous VMs not derivable from `currentLog`) — report
  with specifics.
- A step's verification fails twice after a reasonable fix attempt.
- Implementing rotation requires touching `createDIDWebVH`/`updateDIDWebVH`
  behavior (out of scope) — report.

## Maintenance notes

- Key rotation/recovery is security-critical: a reviewer must confirm the OLD key
  authorizes the rotation (the new key must not be able to self-authorize an
  unsanctioned takeover) and that prior log entries remain verifiable.
- This pairs naturally with plan 004 (audit logging) — consider emitting a signed
  audit record on rotation/recovery in a follow-up.
- If `did:webvh` pre-rotation keys (didwebvh-ts `nextKeyHashes`) are supported,
  document whether rotation honors them.
