---
"@originals/code": minor
---

Mirror raw git commit objects verbatim (plan 049 O3, K12): the verifier recomputes each commit id, its tree and first parent and reports `commitBinding` separately. Public by default; a workspace marked private mirrors them only with `--include-commits` / `commits: true`. Bundles without commit objects verify as before, with commit ids claimed. The viewer shows commit messages from verified commit objects.
