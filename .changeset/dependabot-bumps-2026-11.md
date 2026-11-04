---
"@originals/sdk": patch
"@originals/auth": patch
"@originals/landing": patch
---

Update dependencies from the open Dependabot PRs (#1013–#1019, #1021, #1031):
`@noble/ed25519` 3.2.0, `@noble/secp256k1` 3.2.0, `@scure/btc-signer` 2.4.1,
`bitcoinjs-lib` 7.0.5, `cborg` 6.2.1, `micro-ordinals` 0.4.0, `uuid` 14.0.3,
`@turnkey/sdk-server` 8.8.0, and `react`/`react-dom` 19.3.1 with their types.

TypeScript stays on 6.0.3 because typescript-eslint 8.72.1 supports only
`typescript <6.1.0`. The lockfile holds `@turnkey/sdk-server` at 8.8.0: 8.9.0
sends a `CREATE_SUB_ORGANIZATION_V8` activity but reads
`createSubOrganizationResultV9`, so it finds no sub-organization ID in a V8
result (`turnkey-client` test "reads the new sub-org ID from the installed SDK
V8 response").
