Originals: Authentic Decentralized Digital Assets
Version 1.2 — July 2026 Brian Richter (Aviary Tech)
Abstract
Originals is a minimal protocol for creating, discovering, and transferring digital assets with cryptographically verifiable provenance. Each asset IS a Cryptographic Event Log (CEL): a signed, hash-chained record of every authorship event in its life, whose genesis hash is the asset's identity. That identity migrates through three infrastructure-native layers: private (did:cel), public (did:webvh), and transferable (did:btco). Ownership moves only on Bitcoin — on the final layer the asset is bound to a single satoshi (did:btco:<sat>), and owning the asset IS controlling that satoshi — ensuring that economic value is secured by the world’s most resilient consensus network, while creation and discovery incur no blockchain cost. The protocol requires no smart contracts, trusted third parties, or bespoke blockchains.
1. Introduction
Digital assets today depend on platforms that can vanish or mutate content, undermining authenticity. Existing NFT systems pin hashes but trade mutable URLs. Mainstream web media offers discoverability without cryptographic guarantees or ownership. Conversely Originals ensure provenance is inseparable from the asset and security organically scales with value. This delivers what existing platforms fail to provide.
2. System Overview
Originals organizes the asset lifecycle into three layers with the ability to migrate in one direction. Every authorship operation — creation, migration, resource update, key rotation — appends a digitally signed event to the asset’s event log, forming an auditable hash chain: did:cel → did:webvh → did:btco
1. Private Creation — did:cel: The asset’s genesis identity is derived from the hash of its signed create event. Resources are referenced by content hash, keeping the log byte-light. Creation and verification are offline and free.
a. Because the create event is signed and hash-bound to its content the moment it exists, creators can assert authorship or prove existence of a resource immediately, prior to any public migration.
2. Public Discovery — did:webvh: The DID document and event log are hosted on any HTTPS server (or a free hosted Originals network), making the asset indexable by existing web crawlers. No economic activity occurs here.
3. Transferable Ownership — did:btco: The asset is inscribed on Bitcoin via the Ordinals protocol, on a satoshi the inscriber selects. That satoshi IS the asset’s final identity (did:btco:<sat>) and its ownership: whoever controls the satoshi owns the asset. This layer is final — there is no fallback to did:webvh once an asset is on Bitcoin.
The protocol separates authorship from ownership. The event log records authorship only; transferring ownership is a pure Bitcoin satoshi transfer that writes nothing to the log. The current owner is read live from Bitcoin, never from a log entry or a credential.

  3. Data Model
Each layer shares the same verification stack:
1. Cryptographic Event Log — the asset itself: signed, hash-chained events (create, migrate, update, rotateKey)
2. DID Document — keys and services for the current layer; on did:btco it embeds an anchor committing to the event log head
3. Resources — digital content (images, text, code, data, etc.), referenced by content hash
W3C Verifiable Credentials with Data Integrity proofs complement the log for third-party claims about an asset. A single verification routine checks the entire signed chain — signatures, hash links, and Bitcoin anchoring — with identical code regardless of layer, requires only public keys, and fails closed.

 4. Economic Layer Separation
Only Bitcoin prevents double-spending; therefore all trades must settle in did:btco, as satoshi transfers. Lower layers handle creativity and distribution where consensus is unnecessary. Market forces push valuable assets upward, aligning security spend with asset value.
 Layer
Security
Cost
Economic Role
did:cel
High (self-contained)
0
None
did:webvh
Medium (HTTPS)
0 hosted; ≈ $25 / yr self-hosted
None
did:btco
Maximum (Bitcoin)
≈ $75–200 one-time
All transfers
          5. Incentives
Creators pay nothing to experiment, little or nothing to be discovered, and only migrate to Bitcoin when a buyer emerges. Collectors gain the strongest guarantees when value justifies the fee. No party subsidises unused security.
6. Security Considerations
1. Data Integrity: Provenance is the whole signed hash chain. Every event is signed and linked to its predecessor by hash; tampering with any event breaks the chain, and verification fails closed.
2. Key Rotation & Recovery: On did:btco, signing keys are rotated by reinscribing the same-identity DID document on the same satoshi — cooperatively, signed by the outgoing controller, or, when the previous controller’s signature is unobtainable (e.g. an uncooperative seller), self-signed by the current satoshi holder: the reinscription itself proves satoshi control and authorizes the rotation. Historical provenance is unbroken. Rotation grants the ability to author new events; it does not grant or transfer ownership — the satoshi already is the ownership.
3. Front-Running & Uniqueness: The first inscription to anchor a given asset identity on Bitcoin is canonical (first-anchor-wins); later anchorings of the same identity are rejected. Verifiers enforce this fail-closed at resolution time — if uniqueness cannot be checked, verification fails rather than trusting the claim.
4. Layer Resilience: Failure in web hosting affects discoverability but not ownership; Bitcoin anchoring is final, and the asset’s full provenance is recoverable from its satoshi alone.
5. Content Permanence: The anchoring inscription’s content is the asset’s current media itself; its metadata carries the DID document and the full event log. Identity, history, and current content therefore survive any host and are recoverable from the bare satoshi. Additional resources are referenced by content hash: they remain verifiable against the inscribed hashes (any surviving copy can be authenticated) but depend on at least one copy surviving, and implementations MUST record which resources are inscribed versus referenced so holders can assess availability risk.
7. Related Work
Originals builds directly on the interoperability of W3C DID and VC standards, and the finality of Bitcoin’s Ordinals protocol, but deliberately separates the processes of asset creation, discovery, and settlement.
8. Conclusion
Originals offers a simple path from creation to permanent ownership without inventing new blockchains. By letting economic gravity decide when an asset deserves Bitcoin immutability, the system pairs mainstream web usability with maximal security, creating a pragmatic bridge for decentralized digital provenance.

 Appendix 1: Example Use Cases for Originals Digital Art Provenance and Transfer
● An artist creates an image and issues a did:cel version for experimentation and feedback among peers.
● Once the piece sparks interest, the artist migrates it to did:webvh, making it discoverable on a personal domain for wider public viewing.
● Upon sale, the work is migrated to did:btco and inscribed on a satoshi of the artist’s choosing. The authorship chain is immutable and publicly auditable, and ownership is provable live on Bitcoin: whoever controls the satoshi owns the work, and each resale is an ordinary satoshi transfer.
Scientific Data Publication
● A researcher documents original datasets with a did:cel identifier for internal lab use and collaboration.
● When ready to publish, the dataset is migrated to did:webvh and hosted on an institutional server for public referencing and indexing.
● Following peer review or receipt of a grant, the data’s origin and record are finalized by migrating to did:btco, making its provenance tamper-resistant and allowing future citations to reference its Bitcoin-inscribed authenticity.
DAO Governance
● A DAO establishes its community by issuing did:cel records to early members, representing identity and participation rights without cost.
● As the DAO grows, membership records are migrated to did:webvh, making them discoverable and verifiable on the open web while still off-chain. This enables public recognition of contributors, roles, and proposals.
● When decisions, commitments, or treasury actions require permanence, they are finalized by migrating to did:btco. These inscriptions on Bitcoin create an immutable, censorship-resistant record of governance outcomes and membership proofs, ensuring long-term transparency, accountability, and trust.

 Software Release with Verifiable Supply Chain
● An open-source project maintains did:cel records for unreleased or developmental branches.
● Minor releases are migrated to did:webvh for web-wide indexing and downloads.
● Major releases are further migrated to did:btco, enabling governments and
enterprises to verify provenance and source integrity, reducing supply chain risks.
Heritage Collectibles
● Archivists, museums, or estates catalog rare items with did:cel records, creating verifiable records without needing a blockchain.
● did:webvh migration makes these records publicly discoverable and indexable for researchers and the public.
● did:btco anchoring makes provenance and content integrity permanent: the asset's identity, history, and current media are inscribed on its satoshi and survive any host. Additional referenced resources remain verifiable against the inscribed hashes (any surviving copy can be authenticated) but depend on at least one copy surviving.
Consumer Goods with Provenance Trails
● A manufacturer issues did:cel records for limited-run sneakers, instruments, or other goods.
● did:webvh provides a verifiable public registry of authentic items, reducing counterfeiting risk.
● did:btco anchoring secures authenticity through resales, market shifts, or brand collapse: each resale is a satoshi transfer, and the current holder is always provable directly from Bitcoin.
