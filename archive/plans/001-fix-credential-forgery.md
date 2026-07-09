# Plan 001: Bind credential verification to the issuer DID (close the forgery bypass)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 879ab0c..HEAD -- packages/sdk/src/vc/CredentialManager.ts packages/sdk/src/vc/Verifier.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (but coordinate with 003 — both touch the VC layer; land 001 first)
- **Category**: security
- **Planned at**: commit `879ab0c`, 2026-06-11

## Why this matters

The SDK's entire value proposition is "cryptographically verifiable provenance,"
yet `CredentialManager.verifyCredential` can be fooled into accepting a forged
credential. The legacy (non-DataIntegrity) verification path takes the public
key used to check the signature **from the proof itself** — either
`proof.publicKeyMultibase` or a bare `z…` string in `proof.verificationMethod` —
with no check that this key is controlled by the credential's `issuer`. An
attacker signs a credential with their own key, sets `issuer` to a victim DID,
embeds their own public key, and verification returns `true`. This was confirmed
with a working proof-of-concept: a credential claiming
`issuer: "did:webvh:victim.example.com:trusted-authority"` verified as valid
while signed entirely with an attacker key. After this plan, a credential only
verifies if the signing key is resolvable from, and authorized by, the issuer's
DID document.

## Current state

- `packages/sdk/src/vc/CredentialManager.ts` — `verifyCredential` (the public
  verify entry) and `resolveVerificationMethodMultibase` (key resolver).
- `packages/sdk/src/vc/Verifier.ts` — the strong Data Integrity verifier
  (`eddsa-rdfc-2022`); already resolves keys via the document loader / DID.

Two distinct defects combine into the bypass.

**Defect A — downgrade gate.** `verifyCredential` only routes to the strong
`Verifier` when a `cryptosuite` field is present; stripping it forces the weak
legacy path (`CredentialManager.ts:288-305`):

```ts
async verifyCredential(credential: VerifiableCredential): Promise<boolean> {
    return this.tracked('credential.verify', async () => {
    if (this.didManager) {
      // ...
      const hasCryptosuite = Array.isArray(proofWithSuite)
        ? proofWithSuite[0]?.cryptosuite
        : proofWithSuite.cryptosuite;
      if (hasCryptosuite) {
        const verifier = new Verifier(this.didManager);
        const res = await verifier.verifyCredential(credential);
        return res.verified;
      }
    }
    // ... falls through to legacy path below
```

**Defect B — key taken from the proof, not the issuer.** The legacy path
(`CredentialManager.ts:328-336`):

```ts
    const signer = this.getSigner();
    try {
      const proofWithKey = proof as Proof & { publicKeyMultibase?: string };
      const resolvedKey = proofWithKey.publicKeyMultibase
        || await this.resolveVerificationMethodMultibase(verificationMethod);
      if (!resolvedKey) {
        return false;
      }
      return await signer.verify(Buffer.from(digest), Buffer.from(signature), resolvedKey);
```

and the resolver shortcut that returns a caller-supplied string verbatim as the
key (`CredentialManager.ts:454-459`):

```ts
  private async resolveVerificationMethodMultibase(
    verificationMethod: string
  ): Promise<string | null> {
    if (typeof verificationMethod === 'string' && verificationMethod.startsWith('z')) {
      return verificationMethod;
    }
```

The DID-resolution branch lower in `resolveVerificationMethodMultibase`
(`:461-507`) is correct — it resolves the key from the issuer's DID document.
The bug is the two trust shortcuts above it.

**Why a raw key in `verificationMethod` must not be trusted:** there is no link
between that key and `credential.issuer`. The only trustworthy key sources are
(a) the issuer's resolved DID document, or (b) a `did:key:` verificationMethod
whose key IS the identifier (self-certifying) **and** whose DID equals the
issuer / is listed in the issuer's DID document.

**Convention to follow:** `Verifier.ts` already does this right — it loads the
verification method via the document loader and reads `publicKeyMultibase` off
the resolved VM document. Match that trust model. Tests in
`tests/unit/vc/Verifier.test.ts` register VMs via `registerVerificationMethod`
from `src/vc/documentLoader.ts` so the loader can resolve them — use the same
mechanism in new tests.

## Commands you will need

| Purpose   | Command (run from repo root)                                   | Expected on success |
|-----------|----------------------------------------------------------------|---------------------|
| Typecheck | `cd packages/sdk && bunx tsc --noEmit -p .`                    | no NEW errors vs baseline (see note) |
| Targeted tests | `cd packages/sdk && bun test tests/unit/vc tests/security` | all pass            |
| Forgery test | `cd packages/sdk && bun test tests/security/credential-forgery.test.ts` | passes |

> **Typecheck note:** the build has ~12 pre-existing `tsc` errors (fixed by plan
> 003). Do not be alarmed by those. Confirm your change adds **no new** errors:
> `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep -c "error TS"` should be
> `12` before and after, unless plan 003 already landed (then `0`).

## Scope

**In scope** (the only files you should modify):
- `packages/sdk/src/vc/CredentialManager.ts`
- `packages/sdk/tests/security/credential-forgery.test.ts` (create)
- Existing tests in `tests/unit/vc/CredentialManager.test.ts` that sign with a
  raw-key `verificationMethod` and expect `verify === true` — see Step 4.

**Out of scope** (do NOT touch):
- `packages/sdk/src/vc/Verifier.ts` — already correct; don't change its logic.
- `packages/sdk/src/vc/MultiSigManager.ts` — its `extractPublicKeyFromVM`
  (`MultiSigManager.ts:589-596`) derives the key from a `did:key:` identifier,
  which IS a binding, and it checks `policy.signerVerificationMethods`
  membership first. It is weaker than ideal but not the same trivial bypass;
  treat it as a separate finding.
- The Issuer / signing path — signing is fine; only verification trusts the
  wrong key.

## Git workflow

- Branch: `advisor/001-fix-credential-forgery`
- Conventional Commits (repo style, e.g. `fix(sdk): ...`). Example from
  `git log`: `fix(sdk): guard empty resources in publication credential issuance`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing forgery regression test first

Create `packages/sdk/tests/security/credential-forgery.test.ts`. It must encode
the exact bypass and assert it is now closed. Use this content:

```ts
import { test, expect } from 'bun:test';
import { CredentialManager } from '../../src/vc/CredentialManager';
import { multikey } from '../../src/crypto/Multikey';
import * as secp from '@noble/secp256k1';

test('forged credential signed with an unrelated key does NOT verify', async () => {
  const cm = new CredentialManager({ network: 'mainnet', defaultKeyType: 'ES256K' } as any);

  // Attacker's own key — unrelated to the victim issuer DID
  const attackerSk = secp.utils.randomPrivateKey();
  const attackerPk = secp.getPublicKey(attackerSk, true);
  const attackerSkMb = multikey.encodePrivateKey(attackerSk, 'Secp256k1');
  const attackerPkMb = multikey.encodePublicKey(attackerPk, 'Secp256k1');

  const forged: any = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
    type: ['VerifiableCredential'],
    issuer: 'did:webvh:victim.example.com:trusted-authority',
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:attacker', role: 'admin' }
  };

  // Attacker signs with their own key and embeds their own public key in the proof
  const signed = await cm.signCredential(forged, attackerSkMb, attackerPkMb);
  delete (signed.proof as any).cryptosuite; // force the legacy path

  // Before this plan, this returned true (forgery). It must now be false.
  expect(await cm.verifyCredential(signed)).toBe(false);
});

test('embedded publicKeyMultibase in the proof is never trusted', async () => {
  const cm = new CredentialManager({ network: 'mainnet', defaultKeyType: 'ES256K' } as any);
  const sk = secp.utils.randomPrivateKey();
  const pk = secp.getPublicKey(sk, true);
  const skMb = multikey.encodePrivateKey(sk, 'Secp256k1');
  const pkMb = multikey.encodePublicKey(pk, 'Secp256k1');

  const cred: any = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
    type: ['VerifiableCredential'],
    issuer: 'did:peer:victim',
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:subject' }
  };
  const signed: any = await cm.signCredential(cred, skMb, pkMb);
  (signed.proof as any).publicKeyMultibase = pkMb; // attacker pins their own key
  delete (signed.proof as any).cryptosuite;
  expect(await cm.verifyCredential(signed)).toBe(false);
});
```

**Verify**: `cd packages/sdk && bun test tests/security/credential-forgery.test.ts`
→ both tests **FAIL** (verify returns `true`). This confirms the tests exercise
the bug. If they pass already, STOP — the code has drifted.

### Step 2: Stop trusting a proof-embedded public key

In `CredentialManager.ts` `verifyCredential`, remove the
`proofWithKey.publicKeyMultibase ||` trust source so the key always comes from
DID resolution:

```ts
      const resolvedKey = await this.resolveVerificationMethodMultibase(verificationMethod);
      if (!resolvedKey) {
        return false;
      }
```

(Delete the `const proofWithKey = ...` line and the `publicKeyMultibase ||`
fallback.)

**Verify**: the second forgery test ("embedded publicKeyMultibase ... never
trusted") now passes: `cd packages/sdk && bun test tests/security/credential-forgery.test.ts -t "embedded"` → pass.

### Step 3: Resolve keys only through the issuer's DID, and bind to the issuer

Rewrite `resolveVerificationMethodMultibase` so it (a) never returns a bare
`z…` string as a key, and (b) confirms the resolved verification method belongs
to the credential issuer. Because the method currently only receives the
`verificationMethod` string, add the issuer as a second argument and pass
`credential.issuer` at the call site.

Target shape:

```ts
  private async resolveVerificationMethodMultibase(
    verificationMethod: string,
    issuer?: string | { id?: string }
  ): Promise<string | null> {
    // A bare multibase string is NOT a trusted key — it has no binding to the
    // issuer. Only did:key (self-certifying) and DID-document resolution are
    // trusted, and both must match the issuer.
    const issuerDid = typeof issuer === 'string' ? issuer : issuer?.id;

    // did:key is self-certifying: the key is the identifier. Trust it only when
    // the issuer is that same did:key.
    if (verificationMethod.startsWith('did:key:')) {
      const vmDid = verificationMethod.split('#')[0];
      if (issuerDid && vmDid !== issuerDid) return null;
      return vmDid.replace('did:key:', '');
    }

    if (!this.didManager || !verificationMethod.startsWith('did:')) {
      // No way to resolve/authenticate the key against an issuer DID.
      return null;
    }

    // Resolve via the issuer's DID document and confirm the VM is listed there.
    const did = verificationMethod.split('#')[0];
    if (issuerDid && did !== issuerDid) return null;       // VM must be the issuer's DID
    // ... keep the existing document-loader + resolveDID resolution below, which
    // reads publicKeyMultibase off the resolved verification method ...
  }
```

Preserve the existing DID-document resolution body (the
`createDocumentLoader` + `resolveDID` logic at the old `:461-507`) — only the
two trust shortcuts at the top change, plus the `issuerDid` guards.

Update the call site in `verifyCredential` to pass the issuer:

```ts
      const resolvedKey = await this.resolveVerificationMethodMultibase(
        verificationMethod,
        credential.issuer
      );
```

**Verify**: `cd packages/sdk && bun test tests/security/credential-forgery.test.ts`
→ both tests pass.

### Step 4: Close the downgrade and migrate affected existing tests

**4a — close the downgrade.** In `verifyCredential`, when `this.didManager` is
present, always route to the strong `Verifier` for any proof that carries a
`cryptosuite` OR a `type` of `DataIntegrityProof`. Keep the legacy path only as
the no-`didManager` fallback. Concretely, broaden the `hasCryptosuite` gate to
also treat a `DataIntegrityProof` type as "must use Verifier", so a stripped
`cryptosuite` on a DataIntegrity proof fails rather than silently downgrading.

**4b — migrate existing tests.** Some tests in
`tests/unit/vc/CredentialManager.test.ts` sign with a raw multibase key as the
`verificationMethod` and a `CredentialManager` that has **no** `didManager`, then
expect `verify === true` (e.g. "signCredential/verifyCredential works for
ES256K/Ed25519/ES256"). With Step 3, a no-`didManager` manager can no longer
resolve a raw-key VM, so these would now fail.

Decide per test:
- If the test's intent is "a locally-signed credential round-trips," give it a
  `did:key:` issuer whose key matches the signing key, and use the `did:key:`
  verificationMethod. That keeps a real binding and passes.
- Run `cd packages/sdk && bun test tests/unit/vc/CredentialManager.test.ts` and
  fix each newly-failing round-trip test this way.

**STOP if** more than ~12 existing tests require this migration, or any test's
intent is genuinely "verify with an issuer-unrelated key" — that would mean the
SDK has a real use case for unauthenticated local signing, which is a product
decision for the maintainer, not something to invent here. Report back with the
list of affected tests.

**Verify**: `cd packages/sdk && bun test tests/unit/vc tests/security` → all
pass.

## Test plan

- New: `tests/security/credential-forgery.test.ts` — (1) forged credential with
  unrelated key fails; (2) embedded `publicKeyMultibase` is not trusted. Model
  after the structure of `tests/security/credential-tampering.test.ts`.
- Add one positive test: a credential whose issuer is a `did:key:` matching the
  signing key still verifies `true` (proves we didn't break legitimate
  self-certifying issuers).
- Existing: migrate raw-key round-trip tests per Step 4b.
- Verification: `cd packages/sdk && bun test tests/unit/vc tests/security` →
  all pass.

## Done criteria

ALL must hold:

- [ ] `cd packages/sdk && bun test tests/security/credential-forgery.test.ts` → all pass
- [ ] `cd packages/sdk && bun test tests/unit/vc tests/security` → all pass
- [ ] `grep -n "publicKeyMultibase ||" packages/sdk/src/vc/CredentialManager.ts` → no matches
- [ ] `grep -n "verificationMethod.startsWith('z')" packages/sdk/src/vc/CredentialManager.ts` → no matches (the bare-key shortcut is gone)
- [ ] `tsc` error count unchanged vs baseline (12, or 0 if plan 003 landed): `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep -c "error TS"`
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts don't match the live code (drift).
- Step 4b touches more than ~12 existing tests, or any test asserts that a
  credential should verify with a key unrelated to its issuer.
- Closing the downgrade (4a) breaks Data Integrity verification for legitimately
  signed credentials in `tests/unit/vc/Verifier.test.ts`.
- You find another verification entry point that still trusts a proof-embedded
  key (search `grep -rn "publicKeyMultibase" packages/sdk/src` and check each).

## Maintenance notes

- Future reviewers: any new verification path MUST resolve the key from the
  issuer's DID document (or a self-certifying `did:key:` equal to the issuer),
  never from a field inside the proof. This is the core invariant.
- `MultiSigManager.extractPublicKeyFromVM` is a related, weaker pattern left out
  of scope deliberately; consider a follow-up to route it through the same
  issuer-binding resolver.
- If a real "unauthenticated local signing" use case emerges, expose it as an
  explicitly-named API (e.g. `verifyIntegrityOnly`) rather than as the silent
  default — do not reintroduce key-from-proof trust in `verifyCredential`.
