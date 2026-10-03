---
"@originals/auth": patch
---

**`getOrCreateTurnkeySubOrg` now repairs missing required account roles in an existing sub-org's wallet(s), not just a totally missing wallet** (#784).

Previously, the existing-sub-org branch of `getOrCreateTurnkeySubOrgUnlocked` only checked whether the sub-org had *a* wallet at all (`walletCount > 0`); it never checked whether that wallet actually carried all three required accounts (`bitcoin-auth`, `did-assertion`, `did-update`). A sub-org whose wallet was missing one or more of those roles — for example from a partial provisioning failure, or from external tooling that added a wallet without the full account layout — stayed incomplete on every login, unlike the client-side `ensureWalletWithAccounts`, which already checked per-role completeness.

`getOrCreateTurnkeySubOrg` now enumerates accounts across all of the sub-org's wallets, computes which required roles are missing sub-org-wide (a role satisfied in any wallet counts as present), and adds any globally-missing role in place on one deterministic wallet — never duplicating a role that already exists elsewhere in the sub-org, and never minting a replacement sub-org. If enumerating any wallet's accounts fails, the repair is skipped for that login (fails soft) rather than risk inferring a role absent from incomplete data.
