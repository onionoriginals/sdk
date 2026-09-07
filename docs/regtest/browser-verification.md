# Creator browser verification on disposable Bitcoin regtest

`apps/landing/scripts/regtest-browser.ts` drives the actual landing creator UI
in Chromium: upload a PNG, create its signed Original, publish through the
authenticated durable HTTPS host, receive a confirmed local Bitcoin deposit,
and inscribe through the real browser engine and Bitcoin HTTP routes.

This is an explicit integration command, not a unit test that silently skips
when Chromium is missing. First install and build the workspace using the root
package scripts. Bitcoin Core, ord, OpenSSL and Chromium must be installed.
The integrated command installs the pinned Core/ord tools, builds the packages,
typechecks the harness, and requires Chromium (CI installs it explicitly):

```sh
bun run regtest:browser
```

For an explicit binary selection, run from the repository root:

```sh
BITCOIND_BIN=/path/to/bitcoind ORD_BIN=/path/to/ord \
CHROMIUM_PATH=/path/to/chromium \
REGTEST_BROWSER_ARTIFACTS_DIR=/tmp/originals-browser-proof \
bun apps/landing/scripts/regtest-browser.ts
```

The default runs both `commit-response-lost` and `reveal-rejected` scenarios.
They execute sequentially in separate Bun processes, isolating Vite and TLS
trust state while the outer runner aggregates the completed receipts.
Set `REGTEST_BROWSER_FAULT` to either name to run one. `REGTEST_PNG` optionally
selects a real local PNG instead of the embedded small PNG; it must meet the
creator upload limits. All Bitcoin is disposable regtest currency. Core has no
public peers and the provider uses explicit loopback Core/ord URLs.

## What is real and what is a fixture

The runner builds the existing `src/main.tsx` through the production Vite
configuration. A runner-only plugin redirects `auth/useAuth` and
`auth/turnkey-browser-client` to the declared local fixture in
`scripts/regtest-browser/session.tsx`. The fixture supplies an authenticated
test account and implements the existing signing-client interface using fresh
disposable keys. The normal CEL and Bitcoin signing adapters still execute;
no engine, transaction builder, publisher, resolver, creator component, or HTTP
adapter is replaced. No production source imports the fixture and production
authentication is unchanged. This test does not establish live Turnkey OTP,
session issuance or remote custody availability.

A separate Bun process serves the actual `buildFetch`, Bitcoin routes,
Originals routes, durable Originals store and durable inscription store. Test
fixture endpoints exist only in that executable and require a real signed JWT
for the disposable account. Browser HTTPS trust is limited to the ephemeral
certificate's public key in a disposable Chromium profile; the runner trusts
that certificate explicitly. Neither system trust nor global TLS verification
is changed. Browser, runner and server reject unexpected HTTP origins, and any
attempted public-provider fallback fails the proof.

## Restart and recovery assertions

Before every broadcast, the provider wrapper reopens the inscription store
from disk and asserts both signed transactions are already persisted. It then
injects one of two faults: Core accepts the commit but its response is lost,
or the reveal is rejected before reaching Core.

The runner closes Chromium, stops the application process, disables all new
signatures, restarts Core and ord on the same data directories, refreshes the
Core cookie, and starts a new application process on the same HTTPS origin.
It reopens Chromium's persisted profile and clicks the real **Finish
inscription** action on **Your Originals**. It mines the recovered pair and
checks the actual confirmed UI state.

Fresh SDK instances then resolve the hosted publication, on-sat history and
Bitcoin DID. The proof checks identical PNG bytes, asset identity, accepted
head, CBOR CEL metadata, transaction IDs, and signed transaction bytes. The
audit must show no new signature request after restart, and every recovery
broadcast must match the original persisted pair exactly. Hosted bytes must
still resolve after the server restarts from disk.

The real creator also generates a separate `metadata.json` resource. The PNG
is inline on Bitcoin; the second resource remains on the durable HTTPS host.
The sat-only resolver must report that resource as missing. The runner then
downloads and verifies all hosted bytes afresh, combines those attachments
with the freshly accepted on-sat history, and requires a fresh SDK load to
verify every resource digest and the accepted head. The receipt records this
distinction rather than claiming both resources were inscribed inline.

## Evidence and limits

Each scenario writes `receipt.json`, interrupted/recovered screenshots,
browser console output, stage events, application logs, a persistence/signing
audit, and Core/ord logs under its artifact directory. The combined
`receipt.json` is written only after every requested scenario passes. Failures
write `failure.json` and, when a page is available, `failure.png` and
`failure.html`; the command exits nonzero. Keys, the JWT secret, cookie and
browser profile remain in the disposable working directory and are not copied
to proof artifacts.

The existing `regtest-journey.ts` covers a broader SDK lifecycle and reorg
matrix, but its browser is an HTTP adapter and its application restart rebuilds
handlers in one process. The existing component browser test uses deferred
network fixtures. This runner adds the missing real Chromium plus separate
process/disk recovery evidence; its receipt does not prove a public-host or
mainnet release gate. It also does not simulate abrupt power loss, filesystem
corruption, a deep reorg, or an external signing service outage during initial
creation. Production behavior is unchanged; the runner itself is the new
integration verification, so there is no separate mirrored unit test.
