# Archive — historical & process artifacts

These files are **not authoritative** and are kept only for historical reference.
They were moved out of the repository root so new contributors are not misled by
stale or superseded material. Nothing here describes the current, shipped state
of the SDK.

For current information, start at [`../README.md`](../README.md) →
**Documentation & Specification**, which points to the canonical protocol spec
([`../specs/protocol/originals-protocol-rfc.md`](../specs/protocol/originals-protocol-rfc.md)).

## What's in here

### AI-agent orchestration / process scratch
These are inputs and logs for an automated multi-agent development workflow
("Lisa" the planner, "Ralph" the builder). They are not project documentation.

- `PROMPT_lisa.md`, `PROMPT_ralph.md` — agent system prompts
- `NOTES.md` — operator→agent scratch channel
- `IMPLEMENTATION_PLAN.md` — live agent task board
- `NEXT_TASKS_PROMPTS.md` — copy-paste prompt library
- `LOOP_LOG.md` — automated "correctness loop" log
- `FOLLOWUP.md` — correctness-loop triage ledger
- `SECURITY_AUDIT_COMPLETE.md` — an automated status/announcement wrapper
- `tasks/` — PRDs plus `ralph*.sh` loop-runner scripts and prompts
- `plans/` — 50+ numbered per-task agent plan files

### Superseded specifications (pre-CEL)
Two root documents both claimed to be the "v1.0 specification" and described
**different** credential models; both predate the current event-log model and are
superseded by [`../specs/protocol/originals-protocol-rfc.md`](../specs/protocol/originals-protocol-rfc.md).

- `ORIGINALS_SPECIFICATION_v1.0.md` — three-credential model, "Based on Whitepaper v1.1"
- `ORIGINALS_PROTOCOL_SPECIFICATION.md` — a different five-credential taxonomy

### Point-in-time assessments & reports (dated, largely stale)
- `FIRST_RELEASE_ASSESSMENT.md`, `ORIGINALS_SDK_ASSESSMENT.md` — Nov 2025 release-readiness reviews
- `IMPLEMENTATION_ROADMAP.md` — Nov 2025 roadmap draft
- `REFACTORING_REVIEW.md` — snapshot of an unfinished explorer refactor
- `SECURITY_AUDIT_REPORT.md`, `SECURITY_AUDIT_SUMMARY.md` — Oct 2025 audit (findings since remediated)

> The **vision** whitepaper ([`../originals-whitepaper.md`](../originals-whitepaper.md))
> and the current security policy ([`../SECURITY.md`](../SECURITY.md)) intentionally
> remain in the repo root — they are current, not archived.
