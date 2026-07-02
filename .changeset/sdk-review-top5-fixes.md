---
"@originals/sdk": patch
---

Fix five serious correctness and security issues found in a full SDK review:

- **vc**: `Verifier.verifyCredentialMultiSig` now rejects duplicate proofs from the same signer, closing a threshold bypass where one authorized key could satisfy any N-of-M policy by repeating its proof.
- **utils**: `base64.decode` now returns the decoded bytes instead of wrapping the Buffer pool's backing ArrayBuffer, which returned ~8KB of unrelated memory on Node and corrupted base64url/multibase/CEL digest decoding.
- **did**: deactivated (🔥 tombstoned) `did:btco` DIDs no longer resolve to the pre-deactivation document; resolution returns `didDocument: null` with `didDocumentMetadata.deactivated: true`.
- **crypto**: private-key multicodec headers for secp256k1, P256, and BLS12-381 G2 now match the multicodec registry varints; legacy SDK-encoded secp256k1 private keys are still accepted on decode.
- **bitcoin**: `selectUtxos`/`buildTransferTransaction` now exclude inscription-bearing UTXOs by default; pass `forbidInscriptionBearingInputs: false` to opt in to spending them.
