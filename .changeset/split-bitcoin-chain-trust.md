---
"@originals/sdk": major
"@originals/cel": major
---

Expose required `chainEvidence: { assurance, source? }` metadata on sat results and
DID/publication metadata. Core JSON input and ordinary providers stay
`provider-asserted`; failures before a snapshot is obtained report `unavailable`.

The default SDK accepts an application-selected `chainValidator`. The exported
`createBitcoinCoreChainValidator` checks chain tips, active block hashes, and
ordered transactions against a separately trusted Core endpoint with explicit
RPC credentials and bounded requests, bytes, and elapsed time. Successful checks
earn `node-validated`; configured validation failures fail closed. Detached
snapshots prevent asynchronous mutation from changing the view being resolved.

These labels never establish complete Ordinals enumeration, sat trajectory,
ownership or inscription content bindings. Issue #594 remains open. Required
result fields are a breaking type change for callers constructing result literals.
