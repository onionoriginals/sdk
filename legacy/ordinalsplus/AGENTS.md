# Repository Guidelines

This project hosts multiple packages for the Ordinals Plus suite. All code contributions should follow these high‑level rules gathered from the existing documentation.

## Setup
- Install Bun and all dependencies by running `./scripts/configure.sh` from the repository root.
- Development servers are assumed to be running in watch mode; do not include commands to start or restart them in commits or documentation.

## Coding Standards
- Use **TypeScript** across all packages.
- Frontend code (ordinals-plus-explorer) must use **React** with **Tailwind CSS**. Do not add custom CSS files or CSS‑in‑JS libraries. Use `lucide-react` for all icons and ensure dark‑mode support with `dark:` classes. Prefer card‑based UI components and blue/indigo gradients for section headers.
- Keep modules focused on single responsibilities. Favor functional programming patterns where appropriate. Implement robust error handling, especially around asynchronous operations and blockchain interactions.

## Testing
- Organize tests according to `TESTING.md` and `standardized-test-structure.md`:
  - Unit tests under `tests/unit` (or `__tests__` next to source files in the API and explorer packages).
  - Integration, E2E and performance tests in their respective directories.
- Aim for at least **80% code coverage**. Run `npm test` (or `npm run test:windsurf` for a summarized view) before committing.
- Continuous integration runs all tests, so make sure they pass locally.

## Project Structure Overview
- `packages/ordinalsplus` – shared core library.
- `packages/ordinals-plus-api` – Elysia.js backend service.
- `packages/ordinals-plus-explorer` – React frontend.
- `prd/` and `specs/` – requirements documents and protocol specifications.

Adhering to these guidelines keeps the codebase consistent and maintainable.

---

## Expanded Agent Guidelines

- Prefer explicit assumptions and list required clarifications when context is incomplete; proceed with safe defaults.
- Use small, reviewable edits. After each edit, run lints/tests relevant to changed areas and verify build output.
- When evaluating designs, briefly compare alternatives and capture rationale.
- Treat external systems (Bitcoin/Ord, storage, wallets) via provider interfaces and mocks for testability.
- Emit telemetry events for critical operations and use `StructuredError` with stable codes for failures.

## Definition of Done (DoD)

- Acceptance criteria met and checked off
- Unit and integration tests added; all tests pass locally and in CI
- Linting, type checking, and build succeed without warnings
- Public APIs documented and changelog updated (if applicable)
- Observability (telemetry/error codes) added for new critical paths
- Security/privacy considerations addressed (no secrets in logs)

## Observability Guidance

- Use `emitTelemetry` for lifecycle events (create/publish/inscribe/transfer)
- Use `StructuredError` with codes like `CONFIG_UNSUPPORTED_KEY_TYPE`, `ORD_PROVIDER_INVALID_RESPONSE`, `STORAGE_PUT_FAILED`
- Include minimal, structured attributes (durations, sizes, identifiers), avoid PII/secrets

## Examples

- Pagination edge cases: page=0/pageSize=0 → 400; pageSize>1000 → clamp to 1000 and emit warning telemetry
- Fee estimation: record source (`feeOracle` vs `ordinalsProvider` vs `provided`) and value; warn on fallback paths
- DID migration: log from→to layer, slug, and validation results; error on invalid domain or satoshi

