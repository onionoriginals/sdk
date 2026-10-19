# Originals witness service

One Originals witness (spec P9.8; plan 011, PR 8a): `OriginalsWitness` from
`@originals/sdk/originals`, served over the PROVISIONAL `originals-witness/0.1`
HTTP protocol, with a durable approval ledger.

Before approving an entry the witness verifies it under the Originals profile,
reads the author DID itself from where did:webvh publishes it (through the
SSRF-safe fetcher, never from the request) and refuses state more than 60
seconds old, refuses keys the latest author DID does not list and every entry
once the author DID is deactivated, and refuses an entry that does not extend
the last one it approved. It records each approval before returning the proof.
Only did:webvh author DIDs can be read, so hosted Originals need a did:webvh
author.

## Routes

| Route | |
|---|---|
| `GET /health` | `{ ok: true, id }` |
| `GET /witness` | `{ protocol: "originals-witness/0.1", id }` |
| `POST /witness` | `{ original, log, witness }` → `{ proof }`, or `{ error: { category, code, message } }` |

## Configuration

| Variable | |
|---|---|
| `WITNESS_SECRET_KEY` | Secret. 64 hex characters, the Ed25519 key behind the witness's `did:key`. |
| `WITNESS_DATA_DIR` | A persistent volume for the ledger. Losing it lets the witness approve a sibling of an entry it already approved. |
| `WITNESS_PATH` | Default `/witness`. |
| `PORT` | Default `8080`. |

Start with `bun run --cwd apps/witness start` after `bun install && bun run build`.

## Deploying (owner decision)

P9.8 asks for at least three witnesses with a threshold of at least two and
less than their number, and for witnesses independent of the host. Run three
instances, each with its own key and its own volume, not inside the landing
server. Each author DID that publishes hosted Originals declares them in an
`OriginalsWitnesses` service:

```json
{ "id": "<authorDid>#originals-witnesses", "type": "OriginalsWitnesses",
  "serviceEndpoint": { "threshold": 2, "witnesses": [{ "id": "did:key:…" }, …] } }
```

The repository's Railway IaC (`.railway/railway.ts`) is scoped to the landing's
`builder` service and deletes what it does not list, so the witness services
are not added there by this PR. Adding them, and generating and storing their
keys, is the owner's call.
