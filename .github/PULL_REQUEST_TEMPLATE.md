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

- [ ] Updated `.rev/task.json` with observable requirements for this PR
- [ ] Updated `.rev/collect.sh` and `.rev/sources.json` with relevant code and fresh behavioral evidence
- [ ] Acceptance criteria and probe expectations are ready for independent review

See [REV setup and evidence guide](../.rev/README.md).
