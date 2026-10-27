# @originals/host

The protocol-side server behind an Originals hosting instance, as run by the
Originals landing. It runs on Bun (`bun`, `bun:sqlite`, `node:fs`) and is not
browser-safe: browser code may import its types, never its values.

| Module | Contents |
|---|---|
| `app` | `buildFetch`: the request pipeline (canonical-host redirect, hosted-layout reads, `/api/*` dispatch, `/context`, static SPA with its CSP) |
| `router`, `body`, `rate-limit`, `client-ip`, `cookies` | Exact-match routing, capped body reads, rate limiting, proxy-aware client identity, cookie parsing |
| `context-document` | The JSON-LD context at `/context`, the same document `@originals/sdk` verifies against |
| `webvh-host`, `webvh-hosts`, `hosted-layout` | Anonymous did:webvh host store, the served did:webvh hosts, and the hosted layout rules |
| `originals-store`, `originals-routes`, `originals-library`, `shared-saves` | Durable per-user Originals: hosted files, the account index and evidence, and shared-host saves (P6.7) |
| `inscriptions-store`, `bitcoin-reconciliation`, `block-headers`, `block-completion`, `sat-snapshot-codec`, `money-log` | Retained inscription pairs, reconciliation against a provider, block-driven completion, and the money-path log |
| `originals-anchoring`, `instance-lock` | Server-side anchoring of Originals on Bitcoin, and the single-writer lock on a data directory |

Everything is exported from the package root.

## Seams

The host does not authenticate users itself. `createOriginalsRoutes` takes
`authenticate: (req: Request) => string | null`, which names the caller's
subject (the per-user namespace) or null; a throw counts as null, and every
route answers 401. The landing verifies its JWT there.

`buildFetch({ canonicalHost, extraWebvhHosts })` and
`servedWebvhHosts(canonicalHost, extraHosts)` take any did:webvh domains the
instance serves besides its canonical host, such as a legacy domain earlier
identities were minted on.

## Tests

```bash
bun run build   # tsc to dist/
bun test tests/
```
