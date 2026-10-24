# REV acceptance evaluation

SDK pull requests run [REV](https://github.com/aviarytech/rev) after all jobs
in `ci.yml`. Start with this check **nonrequired** in branch protection. A
missing task, evidence, credential, failed CI job, or uncertain evaluation
fails visibly; it is never converted into an approval. REV does not merge PRs.
The separate path-filtered regtest workflow remains an independent check:
REV's supplied CI results cover `ci.yml`, not all repository workflow history.

## Repository setup

Add `TYPESAFE_API_KEY` in repository Settings → Secrets and variables → Actions
(or run `gh secret set TYPESAFE_API_KEY --repo onionoriginals/sdk` interactively).
No key is stored in this repository. Fork PRs do not receive this secret and
cannot obtain an approving evaluation. Leave REV nonrequired while measuring
false approvals and false denials. Existing PR branches need this workflow
merged/rebased into them before they can run it.

## For each PR

1. Update `.rev/task.json` with the task and 1–20 observable acceptance criteria.
   Have a reviewer approve these requirements independently of implementation.
   The collector rejects a task unchanged from the PR base to prevent accidental
   reuse. This change check does not establish reviewer approval or task quality.
2. Update `.rev/collect.sh` to run criterion-specific probes, recording actual
   observations under `.rev/`. It runs after dependency installation on the exact
   PR head in a job without the TypeSafe secret. Build packages there if needed.
   Keep `set -euo pipefail` so a failing command piped to `tee` still fails CI.
3. Update `.rev/sources.json` with `{ "id", "kind", "path" } entries for relevant
   code, tests, and fresh behavior output. The collector also includes the PR
   diff (excluding `.rev` and `bun.lock`) and its base/head revisions. A generic
   passing test count is insufficient: capture inputs, expected behavior, and
   observed results for each criterion. Review expectations for the same bug
   as the implementation. Do not commit generated evidence or logs.
4. Review the `REV` job summary and `rev-report` artifact. Fix missing evidence
   or investigate violations; do not weaken criteria just to obtain approval.

The checked-in task/probes describe the initial collector integration. Replace
them for subsequent PRs, including release PRs; there is no automatic release
exemption or generic green fallback. Upstream REV validates the task and final
corpus, including its limit of `criteria × (items + 1) ≤ 100` assessments.

## Data and trust

The evaluator downloads only the task and evidence from the same run and calls
a commit-pinned external action. It never checks out or executes PR code.
The TypeSafe key is passed only to that action. Do not switch to
`pull_request_target` to make fork evaluations work.

Evidence is sent to TypeSafe. Include only source and observations intended for
that service; never include credentials or private runtime data. The evidence
artifact is retained for seven days and verdict reports for fourteen days.
Review task, probe, source-list and workflow changes as carefully as code:
a PR author can forge observations or weaken criteria, and a matching SHA
is metadata consistency, not proof of trustworthy evidence. Human review and
all other required checks remain necessary.
