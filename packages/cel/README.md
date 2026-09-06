# @originals/cel

For Originals SDK 3.0.0 assets, import the CEL 3 profile from
`@originals/cel/v3`. It supplies strict JSON/CBOR transport, canonical event
identity, authenticated controller history, and the ordered Bitcoin publication
fold. See [V3.md](./V3.md) for the supported contracts and limits.

```ts
import { parseDocument, verifyHistory } from '@originals/cel/v3';
const document = parseDocument(serializedLog, 'json');
const result = verifyHistory(document);
```

History verification authenticates controllers and signed resource descriptors.
It does not fetch resource bytes, establish WebVH hosting, or prove Bitcoin
acceptance or current possession. The full SDK supplies those public interfaces.

The root, `/encoding`, `/cbor`, and `/testing` entry points retain the preceding
CEL utility API for existing integrations. They do not verify the Originals
CEL 3 profile and are not a fallback for pre-3.0 Originals. New asset applications
should use `@originals/sdk` or the explicit `/v3` profile.

Node 20.10 or later is required. The profile is also browser-safe. Licensed MIT.
