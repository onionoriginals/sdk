# Architecture Clarification: Assets and User DIDs

## Correct Architecture (As Implemented)

### User DID
- Each user has **one** `did:webvh:domain:username`
- Created during authentication
- Managed by Privy wallets (authentication, assertion, update keys)
- Stored in users table with wallet references

### Asset DIDs
- Each asset has **its own DID** that goes through the lifecycle:
  - `did:peer` (private, local only)
  - `did:webvh` (public, HTTPS accessible)
  - `did:btco` (Bitcoin, immutable)
- Uses the Originals SDK `OriginalsAsset` pattern ✅
- Each asset gets its own DID document stored separately

### Ownership Model

**Verifiable Credentials prove the relationship:**

1. **Asset Creation**: Asset has DID `did:webvh:domain:asset-slug`
2. **Ownership Proof**: User's DID issues a Verifiable Credential to the asset:
   ```json
   {
     "@context": ["https://www.w3.org/2018/credentials/v1"],
     "type": ["VerifiableCredential", "ResourceCreated"],
     "issuer": "did:webvh:domain:user",  // <-- User's DID
     "issuanceDate": "2025-10-06T...",
     "credentialSubject": {
       "id": "did:webvh:domain:asset-slug",  // <-- Asset's DID
       "owner": "did:webvh:domain:user",
       "assetType": "OriginalsAsset",
       "title": "My Asset",
       "resources": [...]
     },
     "proof": {
       // Signed by user's assertion key
     }
   }
   ```

### Storage Model

**User's DID Document** (`/.well-known/did/username`):
```json
{
  "id": "did:webvh:domain:username",
  "verificationMethod": [...],
  // NO service endpoints for assets
  // NO embedded assets
}
```

**Asset's DID Document** (`/.well-known/did/asset-slug`):
```json
{
  "id": "did:webvh:domain:asset-slug",
  "verificationMethod": [...],
  // Contains asset metadata
}
```

**Linked Documents (Separate Storage)**:
- Asset resources stored at: `/.well-known/webvh/asset-slug/resources/...`
- Asset content publicly accessible
- Referenced from asset's DID document

### Publishing Flow

1. **Create Asset** (`POST /api/assets/create-with-did`):
   - Creates asset in `did:peer` layer
   - Asset gets own DID: `did:peer:2.Ez...`
   - Stored in database with resources in metadata

2. **Publish to Web** (`POST /api/assets/:id/publish-to-web`):
   - Asset migrates: `did:peer` → `did:webvh`
   - New DID: `did:webvh:domain:asset-slug`
   - **User's DID issues ownership credential** ✅
   - Asset resources stored publicly
   - Asset's DID document published
   - Ownership credential links user → asset

3. **Inscribe on Bitcoin** (`POST /api/assets/:id/inscribe`):
   - Asset migrates: `did:webvh` → `did:btco`
   - Immutable record on Bitcoin blockchain
   - Ownership remains provable via credential

### Why This Architecture

✅ **Separation of Concerns**: User identity vs. asset identity  
✅ **Lifecycle Management**: Assets go through stages independently  
✅ **Verifiable Ownership**: Cryptographic proof via VCs  
✅ **Transferability**: Assets can change ownership (update credential)  
✅ **Provenance**: Complete history in asset's DID  
✅ **Privacy → Public**: Assets start private, become public as needed  

### What We Don't Do

❌ Assets as service endpoints in user's DID  
❌ Embedding assets in user's DID document  
❌ Single DID for user and all their assets  
❌ Creating new user DIDs for each publish operation  

### Verifiable Credentials Role

Credentials are the **glue** between user and asset DIDs:
- Issued by user's DID
- About the asset's DID
- Proves ownership, creation, attestation
- Can be verified by anyone
- Cryptographically signed

### Current Implementation Status

✅ User DID creation (at auth)  
✅ Asset DID lifecycle (`did:peer` → `did:webvh` → `did:btco`)  
✅ Asset resources stored publicly  
🟡 Ownership credential issuance (created but not yet signed with Privy)  
⚠️ Credential signing needs Privy integration completion  
📝 Credential should be stored in a linked document structure  

### Next Steps

1. **Complete Credential Signing**: 
   - Integrate Privy signer to actually sign the ownership credential
   - Currently creates unsigned credential as placeholder

2. **Credential Storage**:
   - Store issued credentials in a separate linked document
   - Make credentials publicly queryable
   - Link from user's DID document to their issued credentials

3. **Credential Verification**:
   - Endpoint to verify ownership credentials
   - Query all assets owned by a user via credentials
   - Verify credential chain for transferred assets

## Summary

This architecture correctly implements the three-layer protocol while maintaining clean separation between:
- **User identity** (stable did:webvh)
- **Asset identity** (lifecycle through layers)
- **Ownership proof** (verifiable credentials)

The Originals SDK `OriginalsAsset` pattern is used correctly for asset lifecycle management, while user DIDs remain stable and issue credentials to prove relationships with assets.
