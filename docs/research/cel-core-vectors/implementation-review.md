# CEL 3 core implementation and validation

The shared CEL 3 core is implemented locally and ready for the next SDK integration
stage. It is not yet the format emitted by the existing SDK or real regtest writer.
No new-format Bitcoin transaction was built or broadcast in this stage, and no
package, deployment, commit or PR was published.

Reviewed baseline: `071b898420dd1052f4e4d34a27e59bea167784d0` on
`codex/regtest-flow`, worktree `.worktrees/codex/regtest-flow`. There are no commits
since that baseline. The final working-tree diff for `packages/cel` and `bun.lock`
has SHA-256 `14c1a10ee4f60436e783ff2216c40cba80f5397104574d3333145ee274c4556d`.
The [machine-readable receipt](validation.json) records individual artifact hashes
and validation output locations. Tracker stage: [Implement the new CEL representation
with one canonical verifier and fold](https://github.com/onionoriginals/sdk/issues/561).

## Implementation and trust boundary

The [public API](../../../packages/cel/V3.md) is exported at `@originals/cel/v3`
and as `celV3` from the root. It is browser-safe, with no Bitcoin stack, JSON-LD,
Node builtins or remote key resolution. Existing package-root algorithms remain
for old SDK consumers while their migration is open; the new path never accepts
or translates old wrappers/proofs/holder fields.

Strict JSON/CBOR parsing retains signed values, rejects duplicate keys and unsafe
runtime coercion, enforces the profile limits and produces canonical output.
The event alone selects its digest and genesis DID. Public-key decoding validates
canonical Multikey encodings and curve points. The implementation generates and
verifies P-256, P-384 and standard Ed25519 Data Integrity proofs. All supplied
proofs must pass; proofs never select event identity.

The same history fold enforces creation, immediate previous links, controller
succession, full metadata replacement, resource predecessor digests/version
counts, migration progression and terminal deactivation. Prefixes are immutable
verifier results, not caller assertions. Historical keys remain historical;
rotation to B retires A until explicitly reauthorized by a later current-key
rotation. Sat possession grants no controller authority.

`resolveSat` consumes explicit adapter observations, sorts confirmed publications
by creation block/transaction/envelope position and accepts each publication
atomically. It selects the earliest valid boundary before considering a requested
genesis identity. Missing observations, unstable tips and conflicting provider
records cannot become a current head. Inspected invalid candidates do not poison
otherwise valid history. Ownership and inline-byte verification remain separate
from controller state.

This core trusts the adapter's active-chain membership and complete enumeration
assertions. It does not prove Bitcoin consensus or global uniqueness across sats.
Offline btco signatures do not prove on-chain acceptance. An accepted sat result
is qualified to that snapshot; WebVH method-log binding remains unverified.

## Standards review

Independent Standards reviewer reported two documented issues, both fixed:

- **P2:** malformed WebVH hosts such as `example.123` could escape as raw URL
  `TypeError`, aborting the sat walk. `parseAssetDid` now converts the failure to
  `CelError('invalid', 'CEL_DID', ...)`. Public tests verify both the error category
  and that a signed malformed migration preceding a valid boundary is skipped.
- **P3:** internal assertion helpers leaked through the public entry point without
  a supported API contract. The entry point now exports only `CelError` and its
  status type from the errors module.

The reviewer reran the affected DID/publication suites: **56 passed**, with both
findings verified resolved. The optional duplicated-freeze observation was also
addressed using one internal helper and readonly public results.

## Spec review

Independent Spec reviewer reported two conformance issues, both fixed:

- **P2:** rejecting an otherwise valid metadata-carried publication when its inline
  media digest mismatched added an unauthorized history-acceptance rule. The
  [reading contract](../../../specs/btco-inscription-shape.md) authenticates the
  log independently; the [profile](../../../specs/originals-cel-v3-profile.md)
  qualifies file verification separately. The core now preserves the accepted
  history and reports `inlineContentStatus: 'unmatched'`, no verified resource
  IDs, and a diagnostic. Tests cover both the boundary and a rotation followed
  by a B-signed continuation.
- **P3:** CCG external references reused the Originals resource URL-count limit,
  mislabeling valid 17-URL references invalid. External-reference recognition now
  uses its own nonempty URL list. Both `dataReference` and `previousLog` return
  `unsupported` for that valid outside-profile shape. Resource limits remain.

The reviewer reran the targeted profile/publication suites: **103 passed**, with
both findings verified resolved. No remaining issue was reported within that
recheck scope. These are two independent review axes, not a certification or an
exhaustive protocol audit.

## Validation

| Check | Result |
| --- | --- |
| Focused production CEL 3 suite | 161 passed, 0 failed, 8 files |
| Entire CEL package, including existing APIs | 1,075 passed, 0 failed, 53 files |
| SDK regression suite | 3,163 passed, 245 skipped, 0 failed, 236 files |
| CEL typecheck | Passed |
| Lint of all new core source | 0 errors, 0 warnings |
| Monorepo package build | CEL, SDK and auth passed |
| Export-map ESM imports | All 23 exported entry points passed under Node |
| Browser-safety scan | Passed; CEL graph has no eager Node builtins or Buffer globals |
| Browser-target bundle | Passed; known creation verified under Node with Buffer/process removed (not a real-browser E2E test) |
| Frozen reference manifest checks | All 29 file hashes unchanged |
| Independent reference representation checker | 14 accepted, 40 rejected, 16 CBOR inputs and 5 preferred encodings passed |
| Independent authority companion checker | 24 signed entries, 42 histories and 42 reversed-order cases passed |
| Diff whitespace check | Passed |

The production tests additionally consume literal JCS known answers and published
W3C cryptographic vectors, including a high-S P-384 signature, and independently
verify generated proofs with Node/OpenSSL. Cases cover identity tampering,
prototype/numeric metadata names, malformed input, limits, forged prefixes,
retired controllers, wrong resource predecessors, batch rollback, forks,
reorganizations as fresh declared snapshots, pending/conflicting observations,
missing metadata, wrong creation positions and inline-byte qualification.

The original authority corpus used symbolic WebVH aliases. The [companion](README.md)
changes only those alias inputs to valid multihash syntax and independently
recomputes dependent signed bytes/digests, preserving the same hand-worked
outcomes. The original remains frozen and is explicitly rejected at the real
DID-parser boundary. Neither corpus supplies a valid WebVH method log or real
Bitcoin observations.

Earlier bytes/regtest implementation was preserved exactly: its diff SHA-256 is
still `a78b7d8f5fa017432560fe4af4be7ef13f76c7ac0dda5864f4c3f256a50789ab` after excluding
this new core and review/reference artifacts. Its historical real regtest receipts
were not overwritten or relabeled as CEL 3 evidence.

## Coverage limits and next work

[Route SDK asset mutations and verification through the new CEL state](https://github.com/onionoriginals/sdk/issues/562)
is the next stage: use this verifier for create/mutate/serialize/load, serialize
concurrent updates, preserve exact resource bytes and make proof failures explicit.
The resolver, WebVH publisher and on-sat writer must then consume the same result.
They must collect real complete snapshot evidence, derive the on-sat head before
writing an exact delta, and rerun the creator/recovery flow on real regtest.

Other explicit limits:

- WebVH method binding, DNS/TLS and actual provider completeness were not verified.
  IDNA2008 Unicode/punycode domains yield `unsupported-capability` when required;
  this core currently validates canonical ASCII DNS aliases. See the [WebVH method
  specification](https://identity.foundation/didwebvh/v1.0/#method-specific-identifier).
- Reorg/fork cases are declared input scenarios. No new-format actual transfer,
  inscription, reorg, cold provider/index restart or full browser journey ran here.
- No real HSM/Turnkey signing, remote media retrieval, live ownership address
  validation, public-chain finality or cross-sat canonicality was established.
- Profile limits are enforced, but this does not exhaust every value exactly at
  every maximum or establish a production CPU budget for maximum-length valid logs.
  The existing regtest provider's 5 MiB transport cap still needs reconciliation
  with the 10 MB profile before writing.
- Old SDK/layer APIs still implement the prior representation. Release readiness,
  legacy API removal, stable API/versioning, PR landing and CI remain open work.
