## What

Brief description of the change.

## Why

What problem does this solve? Link to the related issue: Closes #

## How

Explain the approach. Call out any non-obvious design decisions.

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)
- [ ] Test addition or improvement

## Checklist

- [ ] My code follows the project's code style (TypeScript, absolute imports, Multikey encoding)
- [ ] I have added tests that cover my changes
- [ ] All new and existing tests pass (`bun test`)
- [ ] Linting passes (`bun run lint`)
- [ ] I have updated JSDoc comments for any changed public APIs
- [ ] My commits follow [Conventional Commits](https://www.conventionalcommits.org/) format
- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md)

## Testing

Describe how you tested your changes:

- [ ] Unit tests
- [ ] Integration tests
- [ ] Manual testing (describe steps)

## Screenshots / Output (if applicable)

<!-- Add screenshots or relevant command output -->

## REV acceptance criteria

- [ ] Updated `.rev/task.json`: observable criteria, the named tests that establish each, and path globs covering every changed file
- [ ] Named tests pass on this branch and fail without the change
- [ ] Contract reviewed with `review-contract.js` and `REV_CONTRACT_PR_<number>` pinned

See the [REV tests gate guide](../.rev/README.md).
