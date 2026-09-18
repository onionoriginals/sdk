---
"@originals/sdk": patch
---

Fix `config.keyStore` being completely inert on the default `OriginalsSDK`
(`OriginalsSDK3`): it was accepted, validated, and stored on `config`, but no
wired manager ever read it, contradicting `CLAUDE.md`/`V3.md`'s own framing of
the option as backing `sdk.did`/`sdk.credentials`' independent identity and
credential utilities.

- `DIDManager.createDIDWebVH`/`migrateToDIDWebVH` now persist a freshly
  generated (or caller-supplied) local did:webvh signing key into a configured
  `keyStore`, registered under both the signing verification method id and its
  did:key form — mirroring the pattern the CEL asset lifecycle already uses
  for a freshly minted controller key. Skipped when an `externalSigner` is
  used (the external system holds the key material); best-effort, so a
  keyStore write failure never undoes an already-minted DID.
- `CredentialManager.signCredential`'s `privateKeyMultibase` is now optional:
  when omitted, the configured `keyStore` is probed for `verificationMethod`'s
  private key. Throws `CREDENTIAL_SIGNING_KEY_REQUIRED` when neither an
  explicit key nor a keyStore hit is available, and
  `CREDENTIAL_VERIFICATION_METHOD_REQUIRED` when `verificationMethod` itself
  is omitted.

Scope matches `V3.md`'s documented contract: `keyStore` still does not
implicitly select or persist a CEL asset controller (`sdk.lifecycle`) or
back Bitcoin operations (`sdk.bitcoin`) — only the identity and credential
utilities.
