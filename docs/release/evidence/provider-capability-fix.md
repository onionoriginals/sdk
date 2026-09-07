# Production provider capability correction

Runtime: `71e57306ed08aa50ab1954c459a0fa9b8631471d`.

The initial production snapshot failed at the address-index guard. Pinned ord
0.29.0 derives `/sat` ownership from the current output transaction; the address
index serves the inverse address-to-outputs lookup. The selected CEL 3 contract
requires a complete snapshot-qualified observation, not that inverse index.

Primary source: [ord sat handler](https://github.com/ordinals/ord/blob/7e37a3bd3391044b39f5f11f20dfdb8b3764cd0e/src/subcommand/server.rs#L727-L791)
and [address lookup](https://github.com/ordinals/ord/blob/7e37a3bd3391044b39f5f11f20dfdb8b3764cd0e/src/subcommand/server.rs#L1219-L1239).
The regression failed with the original guard, then passed after removing only
that condition. A real Core 31.1 / ord 0.29.0 transfer with address indexing off
confirmed unchanged PNG/publication evidence and fresh ownership/satpoint.
Address-dependent RegtestProvider operations retain their capability guard.
Explicit null ownership behavior is unchanged; missing fields remain failures.

The next production read exposed QuickNode's ambiguous JSON-RPC internal error
for an inscription without metadata. Its documented raw gateway supplies an
inscription-specific 404 for absence and a JSON hex string for present CBOR.
The configured `contentBaseUrl` now supplies both raw content and raw metadata.
Only the exact matching 404 absence marker returns null. Generic 404s, 500s,
HTTP 200 null, decoded metadata objects, oversized responses and deadlines fail.
Without a configured raw gateway the existing RPC contract remains unchanged.

Primary source: [QuickNode REST/RPC mapping](https://www.quicknode.com/docs/bitcoin/ordinals/overview)
and [ord recursive metadata](https://docs.ordinals.com/inscriptions/recursion.html).
The positive production metadata fixture is 418 bytes and matches the original
transaction witness exactly; no CBOR decoding/re-encoding establishes that proof.

Validation: 170 adapter tests; package builds and types; all three real creator
regtest scenarios plus the new no-address-index transfer; complete production
known-PNG snapshot with expected digest. Bounded review identified an HTTP 200
null ambiguity, which was fixed and covered by a regression before this commit.
Full CI and fresh stable artifacts are recorded separately after completion.

Receipts: [provider preflight](production-provider-check.json),
[metadata witness](production-metadata-witness.json),
[no-address transfer](regtest-no-address-index.json),
[resolved snapshot](production-snapshot-resolved.json).
