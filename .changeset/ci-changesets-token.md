---
---

ci: use a PAT (with GITHUB_TOKEN fallback) for the changesets Version PR so its branch push triggers `ci.yml`, and exempt the `changeset-release/main` PR from the changeset-required check by branch as well as bot author. No package changes.
