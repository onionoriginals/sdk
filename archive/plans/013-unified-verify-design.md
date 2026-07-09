# Plan 013 (SPIKE) — Unified `verify()` entry point: design & recommendation

Status: spike complete. PoC at `packages/sdk/src/verify/UnifiedVerifier.ts`,
test at `packages/sdk/tests/unit/verify/unified-verify.spike.test.ts` (5 pass).
Not exported from the package index (per scope — internal until approved).

## 1. Inventory of verification surfaces

| Subsystem | Entry point | Input | Proof / cryptosuite | Returns | Async | How a caller selects it today |
|-----------|-------------|-------|---------------------|---------|-------|-------------------------------|
| W3C Verifiable Credentials | `vc/Verifier.ts` → `Verifier#verifyCredential(vc, opts?)` / `verifyPresentation` | `VerifiableCredential` / `VerifiablePresentation` object | `DataIntegrityProof`, `eddsa-rdfc-2022` (RDF canonicalization); keys resolved via document loader / issuer DID | `{ verified: boolean; errors: string[] }` | yes | constructs `new Verifier(didManager)` |
| CEL event logs | `cel/algorithms/verifyEventLog.ts` → `verifyEventLog(log, opts?)` | `EventLog` (`{ events: [...] }`) | `DataIntegrityProof`, `eddsa-jcs-2022` (JCS canonicalization), plus hash-chain checks across entries | `{ verified: boolean; errors: string[]; events: EventVerification[] }` | yes | calls the free function directly |
| did:btco resolution | `did/BtcoDidResolver.ts` → `BtcoDidResolver#resolve(did, opts?)` | a `did:btco:...` string | n/a — resolves/validates an inscription on a sat, not a detached proof | `{ didDocument: DIDDocument \| null; inscriptions?; resolutionMetadata: { error?, ... } }` | yes | constructs `new BtcoDidResolver(opts)` |

Key observations:
- The VC and CEL verifiers already share a near-identical core result shape
  (`{ verified, errors }`); CEL adds a per-event `events` array.
- `did:btco` is **not** a "verify a document" operation — it is *resolution*
  (string → DID document). It returns a document + metadata, not a verified
  boolean. It does not fit a `verify(document) → {verified}` contract cleanly.
- The two real proof verifiers use **different cryptosuites** (`eddsa-rdfc-2022`
  vs `eddsa-jcs-2022`) and different canonicalization. They are *not*
  interchangeable; dispatch must pick the right one by document kind.
- After plan 001, the credential path is issuer-bound: `Verifier` resolves the
  key from the issuer's DID document via the document loader and never trusts a
  proof-embedded key. The unified verifier MUST route credentials through
  `Verifier` (or the post-001 `CredentialManager.verifyCredential`) — which the
  PoC does.

## 2. Dispatch contract

```ts
type VerifiableKind = 'credential' | 'eventLog' | 'unknown';

interface UnifiedVerificationResult {
  kind: VerifiableKind;
  verified: boolean;
  errors: string[];
  details?: unknown; // the underlying verifier's raw result
}

class UnifiedVerifier {
  constructor(didManager: DIDManager);
  verify(document: unknown): Promise<UnifiedVerificationResult>;
}
```

**Discriminator** (`classifyDocument`), in priority order:
1. `Array.isArray(doc.events)` → `eventLog` (CEL envelope marker).
2. `doc.type` includes `'VerifiableCredential'` → `credential`.
3. otherwise → `unknown` (verified: false, with an explanatory error).

This is shape-based and unambiguous for the two proof types: a CEL log has no
top-level `type: ['VerifiableCredential']`, and a VC has no `events` array.

**Issuer-binding inheritance:** the `credential` branch calls
`new Verifier(didManager).verifyCredential(doc)` — the exact post-001 path. The
PoC's tampered-credential test asserts `verified === false`, proving it is the
real verifier and not a stub.

## 3. Open questions / risks

1. **did:btco doesn't fit the verb.** Resolution ≠ verification. Options:
   (a) keep `UnifiedVerifier` to *proof verification* (VC + CEL) and leave
   did:btco under `DIDManager.resolveDID`; (b) widen the result to a union that
   can carry a resolved document. Recommendation: **(a)** — don't force
   resolution into a verify contract.
2. **Where does `DIDManager` come from?** The VC branch needs one. A unified
   verifier should be constructed by `OriginalsSDK` and handed the shared
   `DIDManager`, mirroring how other managers are wired.
3. **Ambiguous documents.** A document that is neither shape returns `unknown`
   rather than throwing — callers get a typed, non-fatal result. A document that
   somehow matches both (it cannot, given the markers) would prefer `eventLog`
   by priority; acceptable.
4. **CEL custom verifier option.** `verifyEventLog` accepts a `verifier`
   callback; the unified entry would need to forward an options bag if callers
   rely on that. The PoC uses the default verifier.
5. **Result detail asymmetry.** CEL returns per-event detail; VC does not. The
   `details` passthrough preserves this without forcing a lowest-common-denominator
   shape.

## 4. Recommendation

**Build it, scoped to proof verification (VC + CEL); exclude did:btco
resolution.** The dispatch is architecturally cheap, the two proof verifiers
already share a result core, and a single `sdk.verify(document)` front door is a
real ergonomic win for the LLM-agent audience the SDK targets. The PoC proves
the dispatch and the issuer-binding inheritance with no changes to the existing
verifiers.

**A full build would need to:**
- Construct `UnifiedVerifier` in `OriginalsSDK` and expose `sdk.verify(...)`,
  wiring the shared `DIDManager`.
- Forward an options bag (CEL custom verifier, VC `checkStatus`/`documentLoader`).
- Add full test coverage (valid/tampered/missing-proof for each kind, ambiguous
  and unknown documents).
- Export the type surface from `index.ts` and document it in `README.md` and
  `docs/LLM_AGENT_GUIDE.md`.
- Decide the did:btco story explicitly (recommend: document that resolution
  lives on `DIDManager`, not the verifier).

**Estimated cost:** ~1 new exported class + SDK wiring + ~1 doc section +
~15 tests. Low risk because it delegates; the only security-sensitive line is
"credentials go through `Verifier`", which the PoC and its tampered-VC test pin.

**Risks if built carelessly:** re-implementing verification inside the unified
layer (must delegate), or letting the credential branch accept a proof-embedded
key (would regress plan 001). Both are avoided by delegation.
