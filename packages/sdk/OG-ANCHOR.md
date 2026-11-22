# `originals-og anchor`: anchoring a did:og Original on Bitcoin

The command behind step b of the mainnet release gate (originals-spec PR 69,
section 13): a fresh mainnet inscription in the current format, made by the
owner, verified from Bitcoin alone with exactly the P9.18 evidence set and
through a public host. It creates a new did:webvh for the author, builds and
signs the did:og genesis and anchoring entries, shows a funding address and
the exact amount, inscribes after the funding output confirms, and reads
everything back from a public ord explorer.

Nothing is broadcast without an explicit confirmation. On mainnet `--yes` is
ignored: every confirmation needs `yes` typed at the prompt.

## Keys and state

- `keygen --out <file>` writes a new key file (mode 0600, refusing to
  overwrite) with two Ed25519 secrets: the did:webvh update key and the
  assertion key that signs the Original's entries. They differ because an
  entry's key may not be an updateKey of the author DID's own log (P5.3).
  The command reads the file and never prints, logs or copies it. Keep it out
  of any repository.
- `--state <dir>` holds `anchor-state.json` (mode 0600): the author DID, the
  entries, the ephemeral reveal key, the funding outpoint, the sat and the
  signed transactions. Every step resumes from it. Keep it until `verify`
  passes; the reveal key is needed until the reveal confirms.

## Steps

| Step | What it does |
|---|---|
| `author` | Creates `did:webvh:<SCID>:<domain>:authors:<name>` (default domain `originals.build`), prints its `did.jsonl` and the exact URL to serve it at (`https://<domain>/authors/<name>/did.jsonl`), writes it to `<state>/did.jsonl`, waits for confirmation, then fetches the URL (no redirects) and checks it is the same log and verifies under did:webvh. |
| `prepare` | Builds the genesis entry for `--file` (`--media-type`, `--title`), chooses the body (P9.30: by default a WebP preview for an image, none for other types unless `--preview <file>`; `--body full` or `none` to choose), sizes the publication with the largest sat number, prints the P9.18 disclosure and the funding address with the exact amount. |
| `fund` | Waits for the funding output (one confirmation), asks the ord explorer for its first sat (the anchoring sat), refuses a sat that already carries an Originals inscription (P9.34), signs the anchoring entry with `did:btco:<sat>` and the genesis network, verifies the committed log through it as a local copy with the author history to be inscribed (P9.18), prints the disclosure again with the real cost, and asks for confirmation. |
| `broadcast` | Signs and broadcasts the commit and each reveal through the chain backend; the sat moves at input 0 and offset 0 into each part and then to `--holder` (no pointer, P14.12). A retry rebroadcasts the same transactions, never a re-signed entry (P9.6). Each is labelled pending (in the mempool) or submitted, not observed (P9.18). |
| `verify` | Waits for the final reveal to be 6 blocks deep by default (`--min-confirmations`), so the Original's publication history meets the transfer check's depth (P7.22, P14.13), and for the explorer to index it, reads the sat's inscriptions, each envelope from its reveal transaction, chain order and the holder at one tip, computes the report from exactly that evidence set (P9.18), fetches the author's `did.jsonl` from its public URL and checks it matches the inscribed history, and writes `last-run.json` with the transactions, sat, heights, tip, report and host check. Exit 0 only if `outcome` is `verified`, `state` `current`, `bitcoin` `anchored`, the transfer check on the publication history passes and the host copy matches. The transfer check never covers the transaction that last moved the sat: the holder is whoever the explorer reports (P9.11), however recently the sat moved; check that transaction's depth yourself if you need the transfer settled (T7-074). |
| `run` | All five in order. |

## Backends

- Transactions: mempool.space's Esplora API for `--network mainnet`,
  `signet` or `testnet` (`--esplora <url>` to use another), or Bitcoin Core's
  RPC with `--rpc-url` and `--rpc-auth` (regtest).
- Inscriptions: an ord 0.29.x explorer's JSON API (P9.31): ordinals.com for
  mainnet, signet.ordinals.com for signet, or `--ord <url>`. It must index
  sats (`/output/<outpoint>` returns `sat_ranges`).

## What originals.build must serve

For the default `--domain originals.build` and `--name <name>`, a did:webvh
resolver fetches `https://originals.build/authors/<name>/did.jsonl`. That
route must:

- return the file the `author` step prints (also in `<state>/did.jsonl`),
  byte for byte: one JSON line per entry, each ending in `\n`, no BOM, no
  re-serialisation;
- answer `GET` and `HEAD` with `200`, `Content-Type: application/jsonl`
  (did:webvh does not fix a media type; `application/jsonl` or `text/plain`
  both work with didwebvh-ts) and `X-Content-Type-Options: nosniff`;
- answer directly, with no redirect (P8.5: verifiers do not follow redirects)
  and no HTML fallback from the SPA for that path;
- send `Access-Control-Allow-Origin: *` so browser resolvers can read it;
- use `Cache-Control: no-cache` or a short max-age, since a later version of
  the DID appends lines to the same file.

The SPA's catch-all route must not answer `/authors/<name>/did.jsonl`. The
app's current layout serves identity logs at `/<slug>/did.jsonl`, one segment
deep, so `/authors/<name>/did.jsonl` needs a new static file or route.

## The mainnet run (owner)

```sh
bun install && bun run build
cd packages/sdk
KEY=~/originals-keys/author-keys.json          # outside any repository
STATE=~/originals-anchor/mainnet-1              # keep until verify passes
node dist/og/cli.js keygen --out "$KEY"
node dist/og/cli.js anchor author    --state "$STATE" --key "$KEY" --network mainnet --name <name>
#   serve $STATE/did.jsonl at https://originals.build/authors/<name>/did.jsonl, then type yes
node dist/og/cli.js anchor prepare   --state "$STATE" --key "$KEY" --network mainnet \
  --file <path> --media-type <type> --title "<title>" --holder <ordinals-capable bc1p… address> [--fee-rate <sat/vB>]
#   send EXACTLY the printed amount to the printed bc1p… address from any wallet
node dist/og/cli.js anchor fund      --state "$STATE" --key "$KEY" --network mainnet
node dist/og/cli.js anchor broadcast --state "$STATE" --key "$KEY" --network mainnet
node dist/og/cli.js anchor verify    --state "$STATE" --key "$KEY" --network mainnet --out "$STATE/last-run.json"
```

## Tests

- `bun test tests/unit/og/` (key file, author DID form and URL, previews,
  local-copy refusal, disclosure, the commit/reveal chain).
- `bun run regtest:og` (needs Bitcoin Core and ord 0.29.x on `PATH`): four
  end-to-end runs on a disposable regtest chain: a Markdown file inscribed in
  full, an image with a generated WebP preview, a 348,000-byte version in two
  parts on one sat, and the spec's bitcoin vector (T14-093) inscribed with
  this SDK's builder and read back with its reader. Each writes a
  `scripts/og-*.last-run*.json` record.
