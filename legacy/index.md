## Legacy packages: what to copy and where to wire it into the Originals SDK

This document maps working implementations in `legacy/` to their integration points in the current SDK under `src/`. Use these as authoritative reference implementations when porting functionality.

### Scope at a glance
- di-wings (`legacy/di-wings/`): cryptography, Multikey, VC issuance/verification (v1/v2), VC workflow orchestration.
- ordinalsplus monorepo (`legacy/ordinalsplus/`): BTCO DID method, Ordinals resource providers/resolution, API patterns, Explorer examples.
- Originals-Explorer (`legacy/Originals-Explorer/`): reference UI + API app demonstrating SDK usage (BTCO DID, Originals asset lifecycle, VC flows). Use as an implementation reference; prefer wiring via `src/` SDK modules.

---

## DIDs (BTCO) – create/resolve/update

- Copy-from (core resolver):
  - `legacy/ordinalsplus/packages/ordinalsplus/src/did/btco-did-resolver.ts` → DID resolution for `did:btco[:test|:sig]:<sat>` including inscription scanning and CBOR metadata handling.
  - Resource providers used by the resolver:
    - `legacy/ordinalsplus/packages/ordinalsplus/src/resources/providers/ord-node-provider.ts`
    - `legacy/ordinalsplus/packages/ordinalsplus/src/resources/providers/ordiscan-provider.ts`
    - Provider factory/types in `legacy/ordinalsplus/packages/ordinalsplus/src/resources/providers/` and `.../resource-resolver.ts`.

- Wire-into (SDK targets):
  - Prefer integrating the resolver behind `src/did/DIDManager.ts` (fill in `resolveDID` logic) and/or exposing a new internal resolver utility under `src/did/`.
  - Use `src/bitcoin/OrdinalsClient.ts` as the network/inscription transport layer. Either adapt the legacy `ResourceProvider` interfaces to call `OrdinalsClient`, or enhance `OrdinalsClient` to match the provider surface (`getSatInfo`, `resolveInscription`, `getMetadata`).

- Copy-from (DID document creation format):
  - `legacy/ordinalsplus/packages/ordinalsplus/src/did/did-document.ts` (`createDidDocument`) for correct `@context`, `verificationMethod` (Multikey or Ed25519), and relationships.
  - UI example for assembling a BTCO DID Document (including Multikey and deterministic `#keyId`):
    - `legacy/ordinalsplus/packages/ordinals-plus-explorer/src/components/create/CreateDidButton.tsx`.

- Specs for reference:
  - `legacy/ordinalsplus/specs/btco-did-method.txt`
  - `legacy/ordinalsplus/packages/ordinalsplus/.aigne/doc-smith/docs/api-reference-dids.md`

Recommended minimal port
- Bring over `BtcoDidResolver` and one provider (`OrdNodeProvider`), and adapt provider fetches to go through `OrdinalsClient`.
- Add `createDidDocument` helper under `src/did/` to generate compliant DID Docs for `did:btco`.

---

## Ordinals and Linked Resources

- Copy-from (resource resolution):
  - Core resolver and provider types: `legacy/ordinalsplus/packages/ordinalsplus/src/resources/resource-resolver.ts`, `.../providers/types.ts`.
  - Providers to fetch inscription content and metadata (CBOR): `ord-node-provider.ts`, `ordiscan-provider.ts`, and `static-data-provider.ts` (for tests/examples).

- Wire-into (SDK targets):
  - Map provider calls to `src/bitcoin/OrdinalsClient.ts` methods. If needed, extend `OrdinalsClient` to support:
    - getSatInfo(satoshi) → inscription IDs
    - resolveInscription(id) → content_url, content_type, sat, metadata (decoded CBOR)
    - getMetadata(id) → raw/decoded CBOR

Copy tip
- Start by porting the type interfaces and transform helpers, then adapt network calls to your chosen backend (ord node, ordiscan, or another indexer).

---

## Verifiable Credentials (VC) – issue, present, verify

- Copy-from (pure VC primitives, v1/v2 auto-detection):
  - `legacy/di-wings/src/lib/vcs/index.ts` exports `Issuer`, `Verifier`, and utilities like `createDocumentLoader` and `Multikey` support.
  - Cryptographic key material and Multikey implementations live in `legacy/di-wings/src/lib/crypto/`.

- Wire-into (SDK targets):
  - Use inside `src/vc/CredentialManager.ts` for:
    - issueCredential: delegate to di-wings `Issuer.issue` (or port the minimal needed parts if external dep is undesired).
    - verifyCredential / verifyPresentation: delegate to di-wings `Verifier`.
  - Ensure DID resolution used during verification calls into `DIDManager` (which may call the ported `BtcoDidResolver`).

- Copy-from (orchestration/workflows, optional):
  - VC-API style workflows: `legacy/di-wings/src/lib/vc-api/WorkflowService.ts` for end-to-end exchanges, template transforms (JSONata), and response VPs.
  - Use as a reference for building higher-level flows; not required for baseline SDK issuance/verification.

- Backend service reference (optional):
  - `legacy/ordinalsplus/packages/ordinals-plus-api/src/services/vcService.ts` shows provider-configured verification and DID resolution composition. Use it to mirror a clean separation between DID resolution and VC verification.

Specs/background
- `legacy/ordinalsplus/packages/ordinalsplus/.aigne/doc-smith/docs/core-concepts-verifiable-credentials.md`

---

## Where each piece lives (code references)

Resolver (BTCO DID):
```1:30:legacy/ordinalsplus/packages/ordinalsplus/src/did/btco-did-resolver.ts
import { BitcoinNetwork } from '../types';
import { ResourceProvider } from '../resources/providers/types';
// ... more code ...
export class BtcoDidResolver {
  // resolve(did, options): returns didDocument + inscriptions + metadata
}
```

Resource providers (Ord node):
```79:99:legacy/ordinalsplus/packages/ordinalsplus/src/resources/providers/ord-node-provider.ts
export class OrdNodeProvider implements ResourceProvider {
  // implements getSatInfo, resolveInscription, getMetadata, etc.
}
```

VC issuance/verification (version-aware):
```24:45:legacy/di-wings/src/lib/vcs/index.ts
export class Issuer {
  static async issue(credential: any, options: any): Promise<any> {
    // v2 via IssuerV2, otherwise v1 via Multikey and LD-Proofs
  }
}
```

DID Document creation helper (BTCO):
```89:118:legacy/ordinalsplus/packages/ordinalsplus/src/did/did-document.ts
export async function createDidDocument(
  satNumber: number | string,
  network: BitcoinNetwork = 'mainnet',
  options: CreateDidDocumentOptions = {}
): Promise<DidDocumentWithKeys> {
  // sets @context, verificationMethod, authentication, etc.
}
```

---

## Integration notes for this SDK

- Map to current modules:
  - `src/did/DIDManager.ts`: implement `resolveDID` using `BtcoDidResolver`; add helpers to create BTCO DID Documents.
  - `src/bitcoin/OrdinalsClient.ts`: expose methods used by providers, or wrap a provider implementation around it.
  - `src/vc/CredentialManager.ts`: delegate issue/verify to di-wings VC utilities; ensure a document loader is available and `DIDManager` is used for resolver hooks.

- Dependencies you’ll need when porting:
  - For Multikey and signatures: `@noble/ed25519`, `@noble/secp256k1`, `jsonld` (and canonicalization), possibly `multiformats`.
  - CBOR for metadata: choose a stable CBOR decoder if not already present.
  - If you reuse the provider classes as-is, ensure `fetch` is available (or inject an HTTP client) and environment variables (node endpoints/API keys) are set.

- Networks and prefixes:
  - Mainnet: `did:btco:<sat>`
  - Testnet: `did:btco:test:<sat>`
  - Signet: `did:btco:sig:<sat>`

---

## Quick-start copy recipes

1) Add BTCO DID resolution:
   - Copy `BtcoDidResolver` and `OrdNodeProvider` to `src/did/` and `src/bitcoin/providers/` (or adapt to use `OrdinalsClient`).
   - Implement `DIDManager.resolveDID` by delegating to the resolver.

2) Enable VC issue/verify:
   - Copy `di-wings/src/lib/vcs/index.ts` (Issuer/Verifier + `createDocumentLoader`) and minimal Multikey support you need.
   - In `src/vc/CredentialManager.ts`, call Issuer/Verifier and wire DID resolution via `DIDManager`.

3) Create BTCO DID Documents:
   - Copy `createDidDocument` and adapt for SDK context; expose a helper in `src/did/`.

4) Resource resolution (optional):
   - Copy `ResourceResolver` and one provider; point network calls to `OrdinalsClient`.

---

## When in doubt
Use the ordinalsplus specs (`legacy/ordinalsplus/specs/*.txt`) and the explorer `CreateDidButton.tsx` as canonical examples for BTCO DID document structure and Multikey usage. The di-wings VC classes are the shortest path to working VC issuance and verification in the SDK.


---

## Originals Explorer app – reference UI/API

- Location:
  - `legacy/Originals-Explorer/`

- Purpose:
  - A full-stack reference app (React + Vite UI with an Express server) that demonstrates how to use the SDK for BTCO DID flows, Originals asset lifecycle, and VC issuance/verification in a product-like setting.
  - Treat this as an example of UI/UX and API composition. For production SDK features, prefer the modules under `src/`.

- How to run locally (from repo root):
  - Dev server:
    ```bash
    cd /Users/brian/Projects/originals/sdk/legacy/Originals-Explorer
    npm install
    npm run dev
    ```
  - Build and start (production):
    ```bash
    npm run build
    npm start
    ```

- Notes:
  - The Explorer relies on environment configuration for its backend (database/session/storage/auth, etc.). Consult the code to supply any required environment variables before running in production mode.
  - Use this app to see end-to-end flows; when porting logic into the SDK, map behaviors to `src/did/DIDManager.ts`, `src/lifecycle/LifecycleManager.ts`, `src/vc/CredentialManager.ts`, and `src/bitcoin/*`.

