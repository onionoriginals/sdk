---
---

Repo infrastructure only, no package changes: `scripts/publish-plan.mjs` now fails
loudly on a registry error instead of reporting "never published", and implements
changesets' real prerelease dist-tag rule (`only-pre` → `latest`, never-published →
the pre tag). Release docs updated for the removed `npm-publish` approval gate.
