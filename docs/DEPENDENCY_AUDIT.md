# Dependency audit

**Last reviewed:** 2026-08-24, against `@originals/sdk` 3.0.0-next.1,
`@originals/cel` 0.2.0-next.1, `@originals/auth` 3.0.0-next.0.

## The live answer is CI, not this file

`bun audit --prod` and `bun audit` run as a **required CI job** on every push and
pull request (`.github/workflows/ci.yml`, job `audit`). A new advisory against
anything in the tree turns the build red on the next commit.

That job — not this page — is the source of truth. This page exists to record the
things a tool cannot tell you: which advisories we have deliberately overridden,
and why. Do not read a package table here as current; the previous version of
this file listed `@scure/bip32`, `cbor-js`, `multiformats`, noble v1.x and
`@semantic-release/*` long after all of them had left the tree, which made it
actively misleading.

**Current state: `bun audit` reports no vulnerabilities.**

## Why `--prod` runs separately

Production advisories reach every consumer of the published packages: `npm audit`
fires on *their* install, against dependencies they did not choose and cannot
easily replace. A dev-only advisory is our problem; a production one is
everybody's. The CI job runs `bun audit --prod` as its own step so the two can
never be conflated in a summary count — which is exactly how a shipped one went
unnoticed (see undici below).

## Standing overrides

These live in the root `package.json` under `overrides`. Each forces a
transitive dependency to a patched version its own parent has not yet moved to.
Every one of them is a **bug in someone else's dependency range**, so each should
be deleted as soon as the parent catches up.

| Override | Forced to | Why | Remove when |
|---|---|---|---|
| `undici` | `^6.28.0` | **Shipped to every SDK consumer.** `jsonld@8` → `@digitalbazaar/http-client@3.4.1` → `undici@^5.21.2`, which resolved to 5.29.0: ten high advisories (unbounded WebSocket memory, request smuggling, CRLF injection, response-queue poisoning). The whole 5.x line and 6.x up to 6.27.0 are affected, so no in-range version is clean. | `jsonld@9` is adopted — it depends on `http-client@4`, whose own range is already `^6.28.0`. See the note below on why that upgrade is not this change. |
| `js-yaml` | `^4.3.1` | Quadratic CPU consumption in `!!omap` resolution (GHSA-5p4m-2wfm-xmqj) affects 3.x and 4.x below 4.3.1. Reached through `didwebvh-ts` (production) and through `changesets`/`commitlint` (dev). | `didwebvh-ts`, `read-yaml-file` and `cosmiconfig` all require ≥4.3.1. |
| `brace-expansion` | `^5.0.8` | Two DoS advisories below 5.0.8 (unbounded expansion length; unbounded intermediate arrays bypassing the earlier mitigation). Dev-only — reaches us through `eslint` and `typescript-eslint`. | eslint's tree moves past 5.0.7. |
| `nanoid` | `^3.3.16` | Non-secure generators can loop indefinitely on negative or zero size. Dev-only, via `vite`. | vite's tree moves past 3.3.15. |
| `postcss` | `^8.5.23` | Path traversal via `sourceMappingURL` auto-loading discloses arbitrary `.map` files. Dev-only, via `vite`. | vite's tree moves past 8.5.22. |
| `human-id` | `4.1.1` | Pre-existing; pins changesets' branch-name generator. | — |

Forcing `js-yaml` to 4.x collapses the two copies in the tree onto one. That is
a real behaviour change for `read-yaml-file` and `cosmiconfig`, which sat on
3.15.0 — both were checked by running `bunx changeset status` and `commitlint`
against the overridden tree, and both work (v4's `load` is the API they use;
only the removed `safeLoad`/`safeDump` would have broken them).

### Why not simply upgrade `jsonld` to 9?

It is the obvious fix and it does not work yet. `jsonld@9.0.0` pulls
`rdf-canonize@5` and a stricter safe mode; against it, eight tests fail — the
whole BBS+ `bbs-2023` selective-disclosure round-trip, plus safe-mode
canonicalization in `CredentialManager`. That is the canonicalization step
underneath every signature this SDK produces, so it is not a dependency bump to
land inside a packaging fix. The override closes the advisory today; the
upgrade needs its own change with the BBS+ suite green.

## Production dependency surface

Enumerated so the shape is legible, not to be maintained as a version table —
read `package.json` for versions and `bun audit` for advisories.

- **`@originals/sdk`** — `@noble/*` and `@scure/*` (curves, ed25519, hashes,
  secp256k1, base, btc-signer), `@digitalbazaar/bbs-signatures`, `@originals/cel`,
  `b58`, `bitcoinjs-lib`, `didwebvh-ts`, `fflate`, `jsonld`, `micro-ordinals`,
  `uuid`.
- **`@originals/cel`** — `@noble/curves`, `@noble/ed25519`, `@noble/hashes`,
  `@scure/base`, `cborg`. Deliberately minimal: no Bitcoin stack, no `jsonld`,
  no Node builtins (enforced by `scripts/check-browser-safety.mjs`).
- **`@originals/auth`** — `@noble/*`, `@originals/sdk`, `@turnkey/*`,
  `jsonwebtoken`.

The `@noble/*` and `@scure/*` families are the audited, minimal-dependency
crypto libraries this SDK is built on. They pull nothing transitively, which is
why none of the advisories above ever touch the signing path.

`jsonld` is the one heavyweight, and it is used only for JSON-LD
canonicalization and BBS+ selective disclosure. It is lazy-imported
(`src/crypto/signingInput.ts`, `src/vc/utils/jsonld.ts`) so it never lands in a
consumer's bundle unless they sign or verify a credential — but it is a hard
`dependencies` entry, so its advisories still fire on every adopter's `npm
install`. That is the whole reason the `undici` override exists.

## Version pinning strategy

Caret ranges in every `package.json`, exact versions in `bun.lock`. Consumers
resolve against their own lockfile; the `overrides` block is the only place we
override that, and only for the advisories above.

CI installs with `--frozen-lockfile` in the audit job: auditing a tree that has
drifted from the committed lockfile is auditing something we do not ship.

## Automation

`.github/dependabot.yml` runs weekly with grouped updates for the crypto
families and dev tooling. Dependabot proposes; the `audit` job is what blocks.
