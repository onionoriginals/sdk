# specs/protocol — provenance warning

Everything in this directory landed in a single unreviewed bulk commit
(`210a8a4 "Up (#148)"`, 2026-03-16, agent-generated) and has not been
individually verified against the implementation.

`originals-protocol-rfc.md` was removed 2026-07-10: it mis-expanded CEL as
"Canonical Event Log" (the implementation and docs/ORIGINALS_CEL_SPEC.md
define the **Cryptographic** Event Log, a W3C CCG CEL profile) and specified
a five-event log schema matching neither `packages/sdk/src/cel/` nor the W3C
spec it cited.

Authoritative documents:
- `originals-whitepaper.md` — protocol vision
- `docs/ORIGINALS_CEL_SPEC.md` + `packages/sdk/src/cel/` — CEL mechanics
- `docs/superpowers/specs/2026-07-10-cel-backbone-did-cel-design.md` — current direction
- `ORIGINALS_PROTOCOL_SPECIFICATION.md` — corroborating (agent-written, Nov 2025)

The remaining btco method specs here may contain salvageable material but
must be verified against code before being cited.
