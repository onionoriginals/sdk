# Originals Protocol — Minimal Specification

**Status:** Draft  
**Version:** 0.1  
**Author:** Brian + Krusty  
**Date:** 2026-01-29

---

## Overview

Originals is a protocol for creating digital assets that progress through three stages:

1. **Private** — Created offline, zero cost, self-verifiable
2. **Public** — Discoverable on the web
3. **Permanent** — Anchored to Bitcoin, tradeable

One identity. One log. The asset IS the log.

---

## Core Concept

An Original is a **Cryptographic Event Log (CEL)** identified by a `did:cel` DID.

```
did:cel:<hash-of-initial-event>
```

The DID is derived from the content hash of the first log entry. It never changes. Only the **location** and **witnesses** change as the asset progresses.

---

## The Three Stages

### Stage 1: Private

```
Location:  Local device (file, app storage, etc.)
Witnesses: None
Cost:      Free
```

- User creates content (image, text, data, whatever)
- SDK generates a CEL with a `create` event
- DID is computed from the hash of this event
- Asset exists only on user's device
- Fully verifiable offline

**Output:** `did:cel:abc123` + log file

### Stage 2: Public

```
Location:  Web (HTTPS)
Witnesses: Web server timestamp
Cost:      Hosting only
```

- User publishes the log to a web endpoint
- Log URL follows pattern: `https://example.com/.well-known/cel/<did>`
- Server adds a witness proof (signed timestamp)
- Asset becomes discoverable via DID resolution

**Output:** Same `did:cel:abc123`, now resolvable on web

### Stage 3: Permanent

```
Location:  Bitcoin (inscription)
Witnesses: Bitcoin block
Cost:      Transaction fee
```

- User inscribes a commitment to the log on Bitcoin
- A specific satoshi becomes the ownership anchor
- Whoever controls that satoshi owns the asset
- Log can still live on web; Bitcoin proves ownership

**Output:** Same `did:cel:abc123`, now tradeable via satoshi transfer

---

## Data Model

### Event Log

```json
{
  "events": [
    {
      "type": "create",
      "data": { ... },
      "proof": [ ... ]
    },
    {
      "type": "update",
      "previousEvent": "<hash>",
      "data": { ... },
      "proof": [ ... ]
    }
  ]
}
```

### Create Event

```json
{
  "type": "create",
  "data": {
    "content": {
      "url": ["ipfs://...", "https://..."],
      "mediaType": "image/png",
      "digestMultibase": "uEiC..."
    },
    "metadata": {
      "name": "My Art",
      "description": "A thing I made",
      "createdAt": "2026-01-29T00:00:00Z"
    }
  },
  "proof": [{
    "type": "DataIntegrityProof",
    "cryptosuite": "eddsa-jcs-2022",
    "verificationMethod": "did:key:z6Mk...",
    "proofPurpose": "assertionMethod",
    "proofValue": "z..."
  }]
}
```

### Witness Proof (added at Stage 2/3)

```json
{
  "type": "DataIntegrityProof",
  "cryptosuite": "eddsa-jcs-2022",
  "verificationMethod": "did:web:example.com#witness",
  "proofPurpose": "assertionMethod",
  "proofValue": "z...",
  "witnessedAt": "2026-01-29T12:00:00Z"
}
```

For Bitcoin (Stage 3):
```json
{
  "type": "BitcoinWitnessProof",
  "txid": "abc123...",
  "blockHeight": 900000,
  "satoshi": 123456789,
  "proofValue": "..."
}
```

---

## DID Resolution

### did:cel Method

```
did:cel:<multibase-multihash-of-initial-event>
```

**Resolution process:**
1. Check local cache
2. Query known web endpoints: `https://<domain>/.well-known/cel/<did>`
3. Query Bitcoin for ownership anchor (if inscribed)

**DID Document** (derived from log):
```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:cel:abc123",
  "verificationMethod": [{
    "id": "did:cel:abc123#key-1",
    "type": "Multikey",
    "controller": "did:cel:abc123",
    "publicKeyMultibase": "z6Mk..."
  }],
  "authentication": ["did:cel:abc123#key-1"],
  "assertionMethod": ["did:cel:abc123#key-1"],
  "service": [{
    "id": "did:cel:abc123#log",
    "type": "CelLog",
    "serviceEndpoint": "https://example.com/.well-known/cel/did:cel:abc123"
  }]
}
```

---

## Operations

### create(content, metadata) → Original

1. Generate keypair (Ed25519)
2. Build create event with content reference
3. Sign event
4. Compute DID from event hash
5. Return `{ did, log, keys }`

### publish(original, domain) → Original

1. Upload log to `https://<domain>/.well-known/cel/<did>`
2. Server signs witness proof
3. Append witness proof to log
4. Return updated original

### inscribe(original) → Original

1. Create Bitcoin transaction with commitment
2. Commit = hash of current log state
3. Specific satoshi becomes ownership anchor
4. Append Bitcoin witness proof to log
5. Return updated original with satoshi reference

### transfer(original, toAddress) → txid

1. Transfer the anchor satoshi to new address
2. New satoshi holder is new owner
3. Log unchanged; ownership tracked on Bitcoin

### verify(original) → VerificationResult

1. Verify all proofs in log
2. Verify hash chain integrity
3. Verify witness proofs if present
4. If inscribed, verify Bitcoin ownership
5. Return `{ valid, owner, witnesses, errors }`

---

## What We're NOT Building

- ❌ New blockchain
- ❌ Smart contracts  
- ❌ Token/coin
- ❌ Consensus mechanism
- ❌ Decentralized storage (use IPFS, Arweave, whatever)
- ❌ Witness network (witnesses are optional, pluggable)

---

## Open Questions

1. **Log location after inscription:** Does the log stay on web, or can it be inscribed too?

2. **Ownership vs Control:** Satoshi owner = asset owner. But who can *update* the log? Controller keys in the log?

3. **Key rotation:** How do we handle key rotation while keeping the DID stable?

4. **Multiple content:** Can one Original have multiple resources, or is it 1:1?

5. **Versioning:** How do we handle content updates vs ownership transfers?

---

## Implementation Phases

### Phase 1: Private Creation
- [ ] did:cel DID method implementation
- [ ] CEL event log creation
- [ ] Ed25519 signing
- [ ] Local verification

### Phase 2: Web Publication  
- [ ] Log hosting endpoint
- [ ] DID resolution over HTTPS
- [ ] Web witness service

### Phase 3: Bitcoin Anchoring
- [ ] Inscription format
- [ ] Satoshi-to-asset mapping
- [ ] Ownership verification
- [ ] Transfer mechanics

---

## References

- [W3C DID Core](https://www.w3.org/TR/did-core/)
- [W3C CEL Spec (Draft)](https://digitalbazaar.github.io/cel-spec/)
- [Data Integrity 1.0](https://www.w3.org/TR/vc-data-integrity/)
- [Ordinals Protocol](https://docs.ordinals.com/)

---

*This is the simplest version that could work. We can add complexity only when we need it.*
