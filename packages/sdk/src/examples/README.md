# SDK examples

`basic-usage.ts` and `run.ts` exercise the current SDK in this checkout through
its public `@originals/sdk` export. From the repository root, with the Bun version
in `package.json` installed:

```sh
bun install --frozen-lockfile
bun run build
bun run packages/sdk/src/examples/run.ts basic
```

Omitting `basic` runs the same example. It creates a local Original from text,
edits its name and resource bytes, serializes both resource versions, and loads
and verifies the saved envelope in a fresh SDK without custody. The output ends
with `Resource version: 2` and `Local history and bytes verified: true`.

The demo generates a fresh, disposable Ed25519 key in memory. It does not save
the key or asset, contact a host, or prepare or submit a Bitcoin transaction.
For real assets, provide and retain your own signing custody. Local verification
checks authenticated history and resource bytes, not publication or possession.

## Retained previous-SDK examples

The `create-*-original.ts` and `full-lifecycle-flow.ts` files are historical
examples of the previous typed-asset and lifecycle APIs. They remain here as
reference material, but are not supported by the current SDK or imported by the
runner. The previous `module` and `lifecycle` runner modes now fail with an
explicit message rather than failing on removed exports or silently reporting
success. Do not use these files as current onboarding instructions.

See [the current API guide](../../V3.md) for the supported asset operations and
publication requirements. This local example does not change the protocol or
specify a future SDK architecture.

## Verification

After building the packages, from `packages/sdk`:

```sh
bun run typecheck:examples
bun test tests/integration/LocalExample.test.ts
```

The type check resolves the built public package declarations. The integration
tests execute the example and runner, including rejected arguments, in the
normal package test suite.
