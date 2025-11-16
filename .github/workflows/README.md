# GitHub Actions Workflows

## NPM Package Publish Workflow

The `publish.yml` workflow automatically publishes the `@originals/sdk` package to npm when changes are pushed to the `main` branch.

### Required Secrets

You only need to configure **ONE secret** in your GitHub repository:

#### `NPM_TOKEN`
This is your npm authentication token used to publish packages.

**How to create it:**

1. Log in to [npmjs.com](https://www.npmjs.com)
2. Click on your profile icon → "Access Tokens"
3. Click "Generate New Token" → "Classic Token"
4. Select **"Automation"** type (for CI/CD publishing)
5. Copy the token

**Add it to GitHub:**

1. Go to your repository on GitHub
2. Click "Settings" → "Secrets and variables" → "Actions"
3. Click "New repository secret"
4. Name: `NPM_TOKEN`
5. Value: Paste your npm token
6. Click "Add secret"

### Built-in Tokens

The workflow uses `GITHUB_TOKEN` which is automatically provided by GitHub Actions - **you don't need to create this**.

### How It Works

The workflow:
1. Triggers on every push to `main`
2. Checks out the code
3. Sets up Bun and installs dependencies
4. Builds the project
5. Runs tests to ensure quality
6. Uses semantic-release to:
   - Analyze commit messages
   - Determine the new version number
   - Update package.json and CHANGELOG.md
   - Publish to npm
   - Create a GitHub release

### Commit Message Format

Use conventional commits to control versioning:

- `feat: add new feature` → **minor** version bump (1.0.0 → 1.1.0)
- `fix: resolve bug` → **patch** version bump (1.0.0 → 1.0.1)
- Commit with `BREAKING CHANGE:` in body → **major** version bump (1.0.0 → 2.0.0)

### Example Commits

```bash
# Patch release (1.0.0 → 1.0.1)
git commit -m "fix: correct DID resolution error"

# Minor release (1.0.0 → 1.1.0)
git commit -m "feat: add support for did:btco migration"

# Major release (1.0.0 → 2.0.0)
git commit -m "feat: redesign credential API

BREAKING CHANGE: CredentialManager.create() now requires issuerDID parameter"
```
