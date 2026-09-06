# Originals

An Original is a digital asset with a verifiable history of its creator's claims.
Its authorship and its possession are separate concepts.

## Language

**Original**:
A digital asset described by its authenticated creation and subsequent authorized history.
_Avoid_: DID document, inscription (as synonyms for the asset)

**Resource**:
A named file belonging to an Original. Different versions can have different bytes while retaining the same resource identity.

**Controller**:
The key authorized to act for an Original at a particular point in its history.
_Avoid_: owner (when discussing authority to make creator claims)

**Creator lineage**:
The succession of controllers established by an Original's accepted history. Membership in that history does not give every former controller continuing authority.

**Retired key**:
A former controller whose authority ended at an accepted rotation. Its historical signatures remain meaningful; possession of the sat does not restore its authority.

**Holder**:
The party controlling the Bitcoin sat carrying an anchored Original. Possession alone does not grant authority to make creator claims.

**Publication**:
A release of signed history for others to discover and verify. A Bitcoin publication can carry several consecutive entries.

**Boundary publication**:
The publication that brings an Original's existing history onto its Bitcoin sat.

**Delta publication**:
A later publication containing only the entries added since the last accepted publication.

**Verified head**:
The latest entry accepted after checking the preceding history and the applicable authority rules.
