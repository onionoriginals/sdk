# Whole-PR REV gate

The complete-PR evaluator is pinned to `3f580df7d3b6e367f21b6e11923980853aae1380` (0.3). Its approval requires coverage of the original request and every changed file, verified criteria, and successful named CI dependencies. Overall merge readiness still requires independent review and appropriate runtime/release evidence.

For each PR:

1. Record the full original request and its source in `.rev/pr-contract.json`; write observable criteria in `.rev/pr-task.json` before implementing. Map **every** changed path to relevant criteria. Renames require both old and new paths. Include CI, documentation and acceptance changes; do not hide them.
2. Update `.rev/pr-sources.json` with current implementation and relevant evidence, including criterion-specific behavioral observations. Replace/extend probes in the unprivileged evidence job for the actual requested behavior; the rollout's collector tests cannot verify unrelated application changes. Keep existing application checks.
3. The pinned collector reads the complete Git diff, with no truncation. Binary, submodule, oversized and unmapped changes fail. Inspect the `candidate-contract.sha256` in the `rev-acceptance-evidence` artifact together with the actual request, criteria and required jobs. Collection of a digest is not approval.
4. After independent review, an authorized maintainer sets repository variable `REV_CONTRACT_PR_<number>` to the approved digest. This trusted value is deliberately outside PR content. Never set it automatically from the PR's generated artifact or approve weakened requirements just to make a check green. The variable is specific to this PR, so another PR cannot reuse its approval. Changes to task/request/required jobs require renewed review and approval. Mappings and changed behavior still undergo model coverage evaluation on every head.
5. Rerun fresh PR checks after configuration. Missing credentials, missing digest, stale revisions, failed dependencies or uncertain coverage deny. Never switch the complete-PR gate to acceptance scope to route around failure.

The preparation job has no TypeSafe key. The evaluator downloads JSON and executes only the pinned external action; it does not checkout or run PR application scripts. Keep workflow and variable administration under review and enforce required branch checks separately. A PR-editable workflow is not an adversarial security boundary.

The existing acceptance manifests/collectors remain for legacy regression fixtures; `.rev/pr-*` defines the actual PR contract. A green regression matrix alone is insufficient. Local migration checks:

```sh
REV_TOOL_PATH=/absolute/path/to/pinned/rev node --test .rev/pr-coverage.test.mjs
```

SDK credential compatibility: the evaluator prefers `TYPESAFE_API_KEY`; SDK also accepts its existing `TUPESAFE_API_KEY` spelling. No secret is downloaded or printed. TV uses the correctly named secret.

## Advisory denial diagnostics

The complete-PR evaluator sets `diagnose-denials: 'true'`. After model denial it
can report a requirement span, cited supplied-evidence line range, gap category
and next check. The ranges refer to supplied source content, not repository line
numbers. Reference existence is checked locally; the interpretation remains
advisory. Unsupported findings explicitly report evaluator uncertainty.

This pass never changes approval, denial reasons, thresholds or exit status.
It makes at most two extra requests with a shared deadline; errors retain the
original denial. Diagnostic regression tests run without the API key. The
recorded evaluator-validation.json describes an earlier gate evaluation and is
not proof that this diagnostic rollout is approved.
