# Whole-PR REV gate

REV is pinned to `f165259e3dbc87ee34e236a79a1da346170d1e83` (0.3). Its approval requires coverage of the original request and every changed file, verified criteria, and successful named CI dependencies. Overall merge readiness still requires independent review and appropriate runtime/release evidence.

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

## Generated release PRs

For `changeset-release/main`, preparation selects `.rev/release-task.json` and
`.rev/release-contract.json` instead of the ordinary PR contract. The unprivileged
probe creates a temporary detached worktree at the PR merge base, runs
`bun install --frozen-lockfile` and `bun run version`, and compares the entire
tracked diff with the PR. It rejects any difference, including unrelated files,
wrong package versions or missing generated files. Temporary worktrees are removed
on success and failure. The probe never merges, tags or publishes.

Each changed path receives the `release-output` criterion only after this exact
comparison succeeds. The complete diff and revision-bound reproduction observations
still undergo the pinned collector's size/format checks and model coverage review.
This branch name selects a profile; it does not grant approval or skip checks.

Review the release request, criterion and actual artifact before setting
`REV_CONTRACT_PR_<number>` to its candidate digest, as above. Release PRs do not
inherit the rollout PR's approval. A maintainer must approve the release contract
independently; generation must never set that trusted variable. All existing CI
jobs remain required. Merging the release PR still triggers the separate publish
workflow and is a maintainer decision.

Reusable integration tests check the evidence plumbing. They do not enforce the
old rollout's file allowlist or require a changeset that versioning consumes.
Ordinary PRs must still supply their own complete mappings and behavioral evidence.

### Ordinary and action-update PRs

For ordinary PRs, set `pullRequest` in `pr-contract.json` to the PR number and
replace the task, request, file mappings and sources with that PR's actual
requirements and relevant evidence. Inheriting the last rollout's contract is
an input error, not a model denial. The trusted `REV_CONTRACT_PR_<number>` is
still configured only after independent review; never copy a candidate digest
automatically into trusted configuration.

Branches matching `dependabot/github_actions/actions/checkout-N` or
`dependabot/github_actions/actions/setup-node-N` select the action-update
profile. Its probe compares immutable merge-base/head files, permits only the
requested action's major-version upgrade in workflow `uses:` lines, and rejects
all other changed bytes and file types. The complete diffs still go to REV;
all required checks and the independently reviewed PR-specific digest remain
mandatory. Unsupported dependency updates need an ordinary PR contract.
Dependabot also needs `TYPESAFE_API_KEY` in **Dependabot secrets**; an Actions
secret of the same name is not available to Dependabot-triggered workflows.
Never switch to executing PR code in a privileged pull_request_target workflow.

If evidence collection fails, the REV job points to the original collection
job and fails without claiming that the model identified an implementation
bug. The updated immutable evaluator pin accepts hundredth-rounded probability
totals from 0.99 through 1.01 without normalizing scores or lowering thresholds.
The old evaluator-validation.json is historical evidence for its recorded pin,
not a live validation of the updated evaluator.

Model denials also request advisory diagnostics from the pinned evaluator. These
may cite a requirement span and supplied-evidence lines, or explicitly report
evaluator uncertainty. Supplied-evidence lines are not repository line numbers.
Diagnostic failures and findings cannot change the original approval decision,
thresholds or exit status; they help investigate a denial, not override it.
