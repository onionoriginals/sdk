---
"@originals/landing": patch
---

**Fix: the shipped "First Light" example's credential no longer verifies — regenerated.**

The landing page's whole claim is that the visitor's browser re-checks the example rather than trusting the page. Since 2026-07-26 it had been rendering "Credential signature did not verify" to every visitor.

Cause: the example was minted 2026-07-15, and #445 then added `migratedTo`, `resourceId`, `fromLayer`, `toLayer` and `migratedAt` to `contexts/originals.json` — the exact five terms this credential's `credentialSubject` uses. Before that change `@vocab` absorbed them into `…/vocab#X`; after it they expand to `Originals:X`. `eddsa-rdfc-2022` signs over the RDF canonicalization of the *expanded* document, so the signing bytes changed and the existing signature stopped verifying. #445's "no signature impact" note held for credentials signed and verified against the same context version, but not for ones already signed.

The example is regenerated with the current SDK, and `verifyExample()` now has a test asserting every check passes — the gap that let this ship, since all three checks fail *softly* into a red row rather than throwing.

Worth noting for consumers generally: changing a JSON-LD context that credentials reference by URL invalidates signatures over already-issued credentials.
