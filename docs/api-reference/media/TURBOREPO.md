# Turborepo Configuration

This project uses [Turborepo](https://turbo.build/repo) for efficient task orchestration across the monorepo.

## Overview

Turborepo is a high-performance build system that provides:
- **Intelligent caching**: Never rebuild the same code twice
- **Parallel execution**: Run tasks across multiple packages simultaneously
- **Task dependencies**: Automatically build dependencies before dependents
- **Remote caching**: Share build cache across team and CI (optional)

## Structure

```
sdk/
├── turbo.json              # Turborepo configuration
├── packages/
│   └── sdk/                # Main SDK package
│       └── package.json    # Has build, test, lint scripts
└── apps/
    └── originals-explorer/ # Explorer application
        └── package.json    # Has dev, build, start scripts
```

## Installation

After cloning the repository, install dependencies:

```bash
bun install
```

This will install Turborepo along with all workspace dependencies.

## Available Commands

All commands are run from the repository root:

### Build

Build all packages in the workspace:

```bash
bun run build
# or
turbo run build
```

Turbo will automatically:
1. Build `@originals/sdk` first (dependency)
2. Then build `originals-explorer` which depends on the SDK
3. Cache the results for future builds

### Development

Start development servers:

```bash
bun run dev
```

This runs the `dev` script in all packages that have it defined.

### Testing

Run all test suites:

```bash
bun run test              # Run all tests
bun run test:coverage     # Run with coverage
bun run test:ci           # Run CI tests with coverage checks
bun run test:security     # Run security tests
bun run test:stress       # Run stress tests
```

### End-to-End Testing

```bash
bun run test:e2e          # Run e2e tests
bun run test:e2e:ui       # Run with Playwright UI
bun run test:e2e:headed   # Run in headed mode
bun run test:e2e:debug    # Run in debug mode
bun run test:e2e:report   # Show test report
```

### Linting & Formatting

```bash
bun run lint              # Lint all packages
bun run format            # Format all packages
```

### Type Checking

```bash
bun run check             # Type check all packages
```

## Task Pipeline

The task pipeline is defined in `turbo.json`:

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "build/**"]
    },
    "test": {
      "dependsOn": ["build"],
      "cache": false
    },
    "dev": {
      "dependsOn": ["^build"],
      "cache": false,
      "persistent": true
    }
  }
}
```

### Task Dependencies

- `"dependsOn": ["^build"]` - Build dependencies first (^ means dependencies in workspace)
- `"dependsOn": ["build"]` - Build current package first
- `"cache": false` - Don't cache this task (tests, dev servers)
- `"persistent": true` - Long-running task (dev servers)

## Caching

Turborepo caches task outputs in `.turbo/` directory:

- **Local cache**: Speeds up rebuilds on your machine
- **Cache hits**: When inputs haven't changed, Turbo replays cached outputs instantly
- **Cache miss**: When inputs change, Turbo runs the task and caches the new output

### Cache Outputs

Tasks with `outputs` defined will cache those directories:

- `dist/**` - TypeScript build output
- `.next/**` - Next.js build output
- `build/**` - General build artifacts
- `coverage/**` - Coverage reports

### Clearing Cache

To clear the local cache:

```bash
rm -rf .turbo
```

Or use Turbo's built-in command:

```bash
turbo run build --force
```

## Filtering

Run tasks for specific packages:

```bash
# Run build only for the SDK
turbo run build --filter=@originals/sdk

# Run dev only for the explorer app
turbo run dev --filter=originals-explorer

# Run build for SDK and its dependents
turbo run build --filter=@originals/sdk...
```

## Performance Benefits

With Turborepo, you'll see:

1. **Faster CI/CD**: Cached builds skip unnecessary work
2. **Faster local development**: Rebuilds are instant when nothing changed
3. **Parallel execution**: Multiple packages build simultaneously
4. **Incremental builds**: Only rebuild what changed

## Monorepo Workflow

When working across packages:

1. **Make changes** to SDK code
2. **Run build** - Turbo rebuilds SDK and dependent packages
3. **Run tests** - Turbo tests affected packages
4. **Start dev** - Turbo starts dev servers with latest builds

Example workflow:

```bash
# Edit packages/sdk/src/core/OriginalsSDK.ts
# ...make your changes...

# Rebuild and test
bun run build    # Rebuilds SDK and dependent apps
bun run test     # Tests SDK (apps depend on build, not tests)

# Start development
bun run dev      # Starts explorer app with latest SDK build
```

## Troubleshooting

### Task not found

If you see `Could not find task`, ensure the package has that script in its `package.json`:

```bash
cd packages/sdk
cat package.json | grep -A 5 "scripts"
```

### Cache issues

If builds seem stale, force a rebuild:

```bash
turbo run build --force
```

### Dependency issues

Ensure workspace dependencies use the correct syntax:

```json
{
  "dependencies": {
    "@originals/sdk": "workspace:*"
  }
}
```

## Remote Caching (Optional)

For team collaboration, you can enable remote caching:

1. Sign up at [Vercel](https://vercel.com)
2. Link your repo: `turbo link`
3. Enable remote caching in CI

See [Turbo docs](https://turbo.build/repo/docs/core-concepts/remote-caching) for details.

## Resources

- [Turborepo Documentation](https://turbo.build/repo/docs)
- [Turborepo Examples](https://github.com/vercel/turbo/tree/main/examples)
- [Monorepo Handbook](https://turbo.build/repo/docs/handbook)
