# Plan 032: BtcoDidResolver must use inscription CONTENT (not ord metadata) as the DID document

## Status

- **State**: DONE (branch `correctness/round1-0`)
- **Priority**: P0 (critical, security/correctness)
- **Effort**: M
- **Risk**: MEDIUM (changes the authoritative source of the resolved DID document)
- **Category**: correctness / security
- **Planned at**: atop `origin/main`@`8881c1d`, 2026-06-23

## Why this matters

`BtcoDidResolver.resolve` (src/did/BtcoDidResolver.ts) fetches the inscription
content from `inscription.content_url` (the on-chain inscribed bytes) and the
inscription "metadata" separately from the ord API server via
`provider.getMetadata(inscriptionId)`.

Before this fix (lines 160-169), the resolver:

1. Fetched the inscription **content** and checked only that it *matched a
   pattern* (`didPattern.test(inscriptionData.content)`), then
2. **Discarded the content** and used the **metadata** object as the DID
   document:

```ts
inscriptionData.isValidDid = didPattern.test(inscriptionData.content);
if (inscriptionData.isValidDid && inscriptionData.metadata) {
  const didDocument = inscriptionData.metadata as unknown as DIDDocument;
  if (this.isValidDidDocument(didDocument) && didDocument.id === expectedDid) {
    inscriptionData.didDocument = didDocument;
  } ...
}
```

The metadata comes from an off-chain API endpoint (the ord server), **not** from
the immutable on-chain inscription. An attacker who controls (or can spoof / MITM)
the ord metadata endpoint can return a DID document containing
attacker-controlled `verificationMethod` / `authentication` entries. That forged
document is then returned as the resolved DID document and used for signature
verification — letting the attacker forge signatures that appear to be valid for
a `did:btco` identity. This defeats the entire trust model of `did:btco`, where
the Bitcoin inscription is supposed to be the single source of truth.

This is consistent with the project THREAT_MODEL.md (F9) treating the on-chain
inscription content as the authoritative artifact and the content_url fetch as
security-relevant; the metadata endpoint is a non-authoritative convenience.

## The fix

Parse the **inscription content** as the DID document and stop trusting the ord
metadata as the document source.

In `BtcoDidResolver.resolve`, after fetching `inscriptionData.content`:

1. Keep fetching metadata (it is still surfaced on `BtcoInscriptionData.metadata`
   for diagnostics), but never treat it as the DID document.
2. Determine `isValidDid` as before (content matches the expected
   `did:btco[...]:<sat>` pattern, with optional `BTCO DID: ` prefix).
3. When `isValidDid`, parse the DID document **from the content**:
   - Strip an optional leading `BTCO DID: ` marker.
   - `JSON.parse` the remaining text.
   - Validate with the existing `isValidDidDocument` guard AND
     `didDocument.id === expectedDid`.
   - On success, set `inscriptionData.didDocument` to the parsed-from-content
     document. On any parse/validation failure, set
     `inscriptionData.error = 'Invalid DID document structure or mismatched ID'`
     and leave `didDocument` unset.
4. Deactivation (`🔥`) handling is unchanged and still clears `didDocument`.

A new private helper `parseDidDocumentFromContent(content): DIDDocument | null`
encapsulates the prefix-strip + JSON.parse (returns `null` on any error).

### Why content can be JSON-parsed

`createBtcoDidDocument` produces a standard W3C DID Document object. The
canonical on-chain representation inscribed for a `did:btco` is that JSON
document (optionally prefixed by the human-readable `BTCO DID: ` marker the
resolver already special-cases in its pattern). Parsing the content as JSON is
therefore the correct way to recover the authoritative document.

## Tests

- New regression test (security): a provider whose `getMetadata` returns a
  **forged** document (extra attacker verificationMethod, or a different one)
  while the inscription **content** carries the legitimate DID document JSON.
  - BEFORE fix: resolver returns the forged metadata document (attacker keys).
  - AFTER fix: resolver returns the document parsed from content; the attacker's
    metadata keys never appear in the resolved document.
- New test: content is valid DID-document JSON and metadata is `null` ⇒ resolves
  successfully from content (previously impossible — required metadata).
- New test: content matches the DID pattern but is NOT valid JSON / not a valid
  document ⇒ `error = 'Invalid DID document structure or mismatched ID'`,
  `didDocument` null.
- Existing tests in `tests/unit/did/BtcoDidResolver.test.ts` that encoded the old
  (insecure) "document comes from metadata, content is just a marker" behavior
  are updated so the inscription **content** carries the DID-document JSON. This
  reflects the corrected, secure contract.

## Invariant

```
bunx tsc --noEmit   # 0 errors
bun run build       # succeeds
bun run test        # SDK + auth suites 0-fail
```
