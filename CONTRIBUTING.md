# Contributing to Originals SDK

Thank you for your interest in contributing to the Originals SDK! This guide will help you get started.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (v1.0 or later)
- [Node.js](https://nodejs.org/) (v18 or later, for tooling compatibility)
- Git

### Setup

1. Fork the repository on GitHub.
2. Clone your fork locally:

```bash
git clone https://github.com/<your-username>/sdk.git
cd sdk
```

3. Install dependencies:

```bash
bun install
```

4. Verify everything works:

```bash
bun run build
bun test
```

## Development Workflow

### Branch Naming

Use descriptive branch names with a category prefix:

- `feat/short-description` — new features
- `fix/short-description` — bug fixes
- `docs/short-description` — documentation changes
- `refactor/short-description` — code refactoring
- `test/short-description` — test additions or fixes

### Making Changes

1. Create a branch from `main`.
2. Write your code. Follow the existing patterns in the codebase.
3. Add or update tests for your changes.
4. Run the full test suite to confirm nothing is broken:

```bash
bun test
```

5. Run the linter:

```bash
bun run lint
```

6. Commit your changes using [Conventional Commits](#commit-messages).

### Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must follow this format:

```
<type>(<scope>): <description>

[optional body]
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`

**Scopes:** `sdk`, `auth`, `did`, `vc`, `bitcoin`, `lifecycle`, `migration`

**Examples:**

```
feat(sdk): add batch credential signing
fix(bitcoin): correct fee estimation for large inscriptions
docs(sdk): update WebVH network configuration guide
test(vc): add BBS+ selective disclosure edge cases
```

Commits are validated by a commit-lint hook — your commit will be rejected if it doesn't match the format.

### Code Style

- **TypeScript** — all source code is TypeScript. No `any` types without justification.
- **Imports** — use absolute imports from `src/` root, not relative paths.
- **Key encoding** — always use multibase Multikey format, never JWK.
- **Errors** — use `StructuredError` from `src/utils/telemetry.ts`.
- **Tests** — colocate unit tests in `tests/unit/` mirroring the `src/` directory structure.

### Testing

```bash
# All tests
bun test

# Specific suite
cd packages/sdk && bun test tests/unit
cd packages/sdk && bun test tests/integration

# Single file
bun test packages/sdk/tests/unit/crypto/Multikey.test.ts

# With coverage
bun run test:coverage
```

All new features and bug fixes require tests. Aim for meaningful coverage — test behavior, not implementation details.

### Project Structure

```
packages/
  sdk/           # Core SDK (where most work happens)
    src/
      bitcoin/   # Bitcoin/Ordinals integration
      core/      # OriginalsSDK entry point
      did/       # DID methods (peer, webvh, btco)
      lifecycle/ # Asset migration between layers
      vc/        # Verifiable Credentials
      types/     # Shared type definitions
    tests/
      unit/
      integration/
      security/
      stress/
  auth/          # Authentication package
```

## Submitting a Pull Request

1. Push your branch to your fork.
2. Open a pull request against `main` on `onionoriginals/sdk`.
3. Fill in the PR template — describe what changed and why.
4. Ensure CI passes. If it doesn't, fix the issues before requesting review.
5. A maintainer will review your PR. Be responsive to feedback.

### What Makes a Good PR

- **Focused.** One logical change per PR. Don't bundle unrelated fixes.
- **Tested.** New behavior has tests. Bug fixes include a regression test.
- **Documented.** Update JSDoc comments for public API changes.
- **Small.** Smaller PRs get reviewed faster. If your change is large, consider splitting it.

## Reporting Issues

Use the [GitHub issue tracker](https://github.com/onionoriginals/sdk/issues). Before opening a new issue, search existing issues to avoid duplicates.

When reporting a bug, include:

- SDK version (`bun pm ls @originals/sdk`)
- Runtime environment (Bun version, OS)
- Steps to reproduce
- Expected vs. actual behavior
- Error messages or stack traces

## Security Vulnerabilities

**Do not open a public issue for security vulnerabilities.** Instead, email security@aviarytech.com with details. We will respond within 48 hours.

## Code of Conduct

This project is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold it. Report unacceptable behavior to conduct@aviarytech.com.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
