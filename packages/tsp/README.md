# @originals/tsp

TypeScript implementation of **TSP 1.0 direct mode** with **Multikey** VIDs. Peers may publish `JsonWebKey2020` keys in DID documents; this package reads them but **never emits** JsonWebKey2020 in documents we build.

## Features

- CESR encode/decode (T domain base64url wire format)
- HPKE-Base (DHKEM X25519, HKDF-SHA256, ChaCha20-Poly1305) with `info = YTSP-` and envelope-prefix AAD
- Ed25519 signatures (CESR indexed `B#` at index 0)
- VID resolution from DID documents (`TSPTransport` / `tsp` service, Multikey + JWK peers)
- `TspEndpoint` direct-mode send/receive over an in-memory inbox

## Usage

```ts
import { openTspMessage, sealTspMessage, resolveVidKeys } from '@originals/tsp';

const opened = await openTspMessage(wireUtf8Bytes, senderKeys, receiverKeys);
const outbound = await sealTspMessage(local, peer, new TextEncoder().encode('hello world'));
```

## Relationship forming

Direct mode follows TSP 1.0 §7: `XRFI` invite, `XRFA` accept, then `XSCS` (TSP_GEN) application payloads (e.g. handoff ZIP bytes). SAID digests use SHA2-256 over the envelope prefix and payload fields (dummy `0x23` in the digest slot per spec 7.2.1).

## Interop

This implementation is validated against [openwallet-foundation-labs/tsp `rev3.json`](https://github.com/openwallet-foundation-labs/tsp/blob/v0.16.0/tsp_sdk/test_vectors/rev3.json) (decode/verify). The reference Rust SDK **requires** `JsonWebKey2020` and `TSPTransport` as the first service entry, so we do not run byte-for-byte interop against it for **Multikey** Originals documents. Wire behavior follows the [TSP 1.0 specification](https://trustoverip.github.io/tswg-tsp-specification/).

### Spec gaps / ambiguities (PROVISIONAL)

- Post-quantum signature wire encoding ([spec issue #87](https://github.com/trustoverip/tswg-tsp-specification/issues/87)): ML-DSA-65 attachments not implemented here.
- PQ hybrid KEM (`MLKEM768-X25519`, HPKE KEM `0x647a`) is not implemented; classical X25519 only.
- Routed mode, nested messages, and libsodium sealed box are out of scope for this package version.

## Tests

Conformance vectors from TSP rev3 live in `tests/fixtures/rev3.json`.

```bash
cd packages/tsp && bun test
```