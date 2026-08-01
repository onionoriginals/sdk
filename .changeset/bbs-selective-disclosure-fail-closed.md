---
"@originals/sdk": major
---

**Security:** BBS+ selective disclosure now fails closed. Both no-key paths threw away the caller's privacy intent while reporting success.

`deriveSelectiveProof` fell back, for any credential without a `bbs-2023` proof, to returning the credential **unchanged** while listing the undisclosed paths in `hiddenFields`. A caller who trusted that report and forwarded `result.credential` published every field it claimed to withhold. It now throws `BBS_BASE_PROOF_REQUIRED`.

`prepareSelectiveDisclosure` had the matching hole: given no key pair it returned a "metadata-only" result — the credential untouched, pointer arrays attached — which read as success but created no proof, so nothing could ever be derived from it. It now throws `BBS_KEY_REQUIRED`.

These combined into one trap: the example in `docs/LLM_AGENT_GUIDE.md` passed no key, so it demonstrated the metadata-only path, and a reader following it got a credential with no proof and then a "derived" result that redacted nothing. The example is corrected to show the real flow.

**Breaking:** calls that previously resolved now throw. Any code relying on either fallback was not performing selective disclosure — it was either producing an unusable credential or leaking. Pass a BBS+ key pair to `prepareSelectiveDisclosure` and derive from its output.

Note the SDK still cannot generate BLS12-381 keys (`KeyManager` covers ES256K / Ed25519 / ES256), so issuers must bring their own via `@digitalbazaar/bbs-signatures`; `multikey.encodePublicKey(publicKey, 'Bls12381G2')` encodes it for the DID document. The documented example shows this.
