# CEL 3 landing browser proof

This fixture uses installed Chrome, the production Vite build, the real creator UI and SDK, and the real anonymous hosting routes over disposable local HTTPS. It does not call Turnkey or a public Bitcoin network. Certificate errors are ignored only in this dedicated browser context; no trust store is modified.

The driver uploads a PNG through the file input, creates the asset, publishes it, checks native CEL 3 history and exact bytes, then reloads the page. The fresh engine cold-loads the WebVH DID through the real HTTP adapter and verifies both histories and all resource bytes. The receipt records the DID, signed document, bytes, upload URLs, page errors, and SHA-256 fingerprints of the exact built HTML/JS/CSS used. `published.png` shows the resulting UI.

Separate focused tests cover authenticated hosting with a real JWT and durable filesystem store, account namespace rejection, partial hosted upload recovery, and exact signed Bitcoin pair replay after a lost response. These tests substitute local signing custody for Turnkey; they do not establish live Turnkey operation or mainnet readiness.

## Reproduce

From the repository root, build the local fixture:

```sh
VITE_WEBVH_HOST=regtest.localhost:3449 VITE_BTC_NETWORK=off bun run --cwd apps/landing build
openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/landing-v3-qa.key -out /tmp/landing-v3-qa.crt -days 1 -subj /CN=regtest.localhost -addext 'subjectAltName=DNS:regtest.localhost,IP:127.0.0.1'
bun docs/release/evidence/landing-cel3-browser/server.ts
```

In another terminal:

```sh
node docs/release/evidence/landing-cel3-browser/browser-qa.mjs
```

The script assumes Google Chrome's standard macOS installation path and the repository's existing `playwright-core` dependency. It closes its browser when finished. Stop the disposable server after inspecting the result.

The screenshot is local UI evidence. The receipt's cryptographic checks concern this fixture's hosted CEL and PNG, not Bitcoin acceptance. The separate real regtest journey supplies local-chain evidence.

The final candidate was also exercised at a 390 × 844 viewport using the same driver with the viewport and output directory changed. `mobile-receipt.json` and `published-mobile.png` retain that independent PNG journey. Both screenshots were visually inspected.
