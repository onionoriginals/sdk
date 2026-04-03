# Originals SDK Integration Guide

A practical guide for integrating the Originals SDK into production applications, using patterns from the Poo App (a todo list application built with React and Convex).

## Overview

The Originals SDK provides tools for creating decentralized identifiers (DIDs) and verifiable credentials. When integrating with real applications, you'll typically split responsibilities:

- **Frontend**: DID creation, asset management via the SDK
- **Backend**: Credential signing, JWT validation, data persistence

This guide walks through the complete integration pattern.

## Frontend Integration

### Installation

```bash
npm install @originals/sdk @originals/auth
```

### Basic Setup

Create a wrapper module for SDK operations. This keeps your configuration centralized and provides a clean API for your components.

```typescript
// src/lib/originals.ts
import { DIDManager } from "@originals/sdk";
import type { 
  DIDDocument, 
  VerifiableCredential, 
  KeyPair, 
  OriginalsConfig 
} from "@originals/sdk";

// SDK configuration
const config: OriginalsConfig = {
  network: "signet",      // Use "signet" for development, "mainnet" for production
  defaultKeyType: "Ed25519",
};
```

### Creating Assets with did:peer

Each asset in your application (lists, items, documents) can be represented as a `did:peer`. This gives every asset a globally unique, cryptographically verifiable identifier.

```typescript
export interface ListAsset {
  assetDid: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

/**
 * Creates a new list asset.
 * Each list is represented as a did:peer asset.
 */
export async function createListAsset(
  name: string, 
  creatorDid: string
): Promise<ListAsset> {
  const didManager = new DIDManager(config);

  // Create a did:peer for the list asset
  // Second param `true` enables numalgo2 (short DIDs)
  const result = await didManager.createDIDPeer([], true);

  return {
    assetDid: result.didDocument.id,
    name,
    createdBy: creatorDid,
    createdAt: new Date().toISOString(),
  };
}

// Re-export types that consumers might need
export type { DIDDocument, VerifiableCredential, KeyPair };
```

### Using in Components

```tsx
import { createListAsset } from "@/lib/originals";

async function handleCreateList(name: string) {
  const userDid = getCurrentUserDid(); // From your auth system
  
  // Create the DID on the frontend
  const listAsset = await createListAsset(name, userDid);
  
  // Send to backend for persistence
  await createList({
    assetDid: listAsset.assetDid,
    name: listAsset.name,
  });
}
```

## Backend Considerations (Convex/Serverless)

### The Challenge

You might expect to simply import `@originals/sdk` in your Convex actions. However, serverless environments like Convex have constraints:

1. **Bundle analysis**: Convex's deploy process analyzes your imports statically
2. **Module format issues**: Some SDK dependencies use extensionless re-exports that break analysis
3. **Node.js APIs**: Some crypto operations require specific Node.js APIs

### The Solution: Copy Essential Helpers

For backend operations, copy the specific helpers you need locally. This:
- Avoids import chain issues
- Gives you full control over dependencies
- Works reliably in serverless environments

### What to Copy

#### 1. TurnkeyWebVHSigner (for credential signing)

If you're using Turnkey for wallet management, you'll need a local signer:

```typescript
// convex/lib/turnkeySigner.ts
"use node";

import {
  MultibaseEncoding,
  multibaseEncode,
  prepareDataForSigning,
} from "didwebvh-ts";
import { sha512 } from "@noble/hashes/sha2.js";
import { concatBytes, bytesToHex } from "@noble/hashes/utils.js";
import * as ed25519 from "@noble/ed25519";

type TurnkeyClientLike = {
  apiClient: () => {
    signRawPayload: (params: {
      organizationId: string;
      signWith: string;
      payload: string;
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL";
      hashFunction: "HASH_FUNCTION_NO_OP";
    }) => Promise<{
      activity?: {
        result?: {
          signRawPayloadResult?: { r?: string; s?: string };
        };
      };
    }>;
  };
};

// Configure @noble/ed25519 with required SHA-512 function
const sha512Fn = (...msgs: Uint8Array[]) => sha512(concatBytes(...msgs));

function configureEd25519Sha512() {
  const ed25519Module = ed25519 as unknown as {
    utils?: { sha512Sync?: (...msgs: Uint8Array[]) => Uint8Array };
    etc?: { sha512Sync?: (...msgs: Uint8Array[]) => Uint8Array };
  };
  if (ed25519Module.utils) {
    ed25519Module.utils.sha512Sync = sha512Fn;
  }
  if (ed25519Module.etc) {
    ed25519Module.etc.sha512Sync = sha512Fn;
  }
}

try {
  configureEd25519Sha512();
} catch (error) {
  console.warn("Failed to configure ed25519 utils:", error);
}

export class TurnkeyWebVHSigner {
  private subOrgId: string;
  private keyId: string;
  private publicKeyMultibase: string;
  private turnkeyClient: TurnkeyClientLike;
  private verificationMethodId: string;

  constructor(
    subOrgId: string,
    keyId: string,
    publicKeyMultibase: string,
    turnkeyClient: TurnkeyClientLike,
    verificationMethodId: string
  ) {
    this.subOrgId = subOrgId;
    this.keyId = keyId;
    this.publicKeyMultibase = publicKeyMultibase;
    this.turnkeyClient = turnkeyClient;
    this.verificationMethodId = verificationMethodId;
  }

  async sign(input: {
    document: unknown;
    proof: Record<string, unknown>;
  }): Promise<{ proofValue: string }> {
    const dataToSign = await prepareDataForSigning(
      input.document as Record<string, unknown>,
      input.proof
    );
    const dataHex = `0x${bytesToHex(dataToSign)}`;

    const result = await this.turnkeyClient.apiClient().signRawPayload({
      organizationId: this.subOrgId,
      signWith: this.keyId,
      payload: dataHex,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    });

    const signRawResult = result.activity?.result?.signRawPayloadResult;
    if (!signRawResult?.r || !signRawResult?.s) {
      throw new Error("No signature returned from Turnkey");
    }

    const signature = signRawResult.r + signRawResult.s;
    const cleanSig = signature.startsWith("0x") ? signature.slice(2) : signature;
    let signatureBytes = Buffer.from(cleanSig, "hex");

    // Handle signature length normalization
    if (signatureBytes.length === 65) {
      signatureBytes = signatureBytes.slice(0, 64);
    } else if (signatureBytes.length !== 64) {
      throw new Error(`Invalid Ed25519 signature length: ${signatureBytes.length}`);
    }

    const proofValue = multibaseEncode(signatureBytes, MultibaseEncoding.BASE58_BTC);
    return { proofValue };
  }

  getVerificationMethodId() {
    return this.verificationMethodId;
  }

  getPublicKeyMultibase() {
    return this.publicKeyMultibase;
  }
}
```

#### 2. JWT Verification (using jose)

For validating auth tokens from `@originals/auth`:

```typescript
// convex/lib/jwt.ts
import * as jose from "jose";

export interface AuthTokenPayload {
  turnkeySubOrgId: string;
  email: string;
  sessionToken?: string;
}

export async function verifyAuthToken(token: string): Promise<AuthTokenPayload> {
  if (!token) {
    throw new Error("Token is required");
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("JWT_SECRET environment variable not set");
  }

  const secret = new TextEncoder().encode(jwtSecret);
  const { payload } = await jose.jwtVerify(token, secret, {
    algorithms: ["HS256"],
  });

  const jwtPayload = payload as { sub?: string; email?: string; sessionToken?: string };

  if (!jwtPayload.sub) {
    throw new Error("Token missing sub-organization ID");
  }
  if (!jwtPayload.email) {
    throw new Error("Token missing email");
  }

  return {
    turnkeySubOrgId: jwtPayload.sub,
    email: jwtPayload.email,
    sessionToken: jwtPayload.sessionToken,
  };
}

export function extractTokenFromRequest(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  
  // Fall back to cookie
  const cookieHeader = request.headers.get("Cookie");
  if (cookieHeader) {
    const match = cookieHeader.match(/auth_token=([^;]+)/);
    return match?.[1] || null;
  }
  
  return null;
}
```

## Architecture Pattern

### Recommended Split

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  @originals/sdk         @originals/auth             │    │
│  │  - DIDManager           - AuthProvider              │    │
│  │  - createDIDPeer()      - useAuth()                 │    │
│  │  - Asset creation       - Login/logout              │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────┘
                           │ API calls (JWT in header)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                        BACKEND                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Local helpers (copied from SDK)                     │    │
│  │  - TurnkeyWebVHSigner   - JWT verification          │    │
│  │  - Credential signing   - Token extraction          │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Database (Convex/Postgres/etc)                      │    │
│  │  - Store asset DIDs     - User data                 │    │
│  │  - Issued credentials   - Relationships             │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Why This Split Works

1. **Security**: Private keys and signing happen server-side
2. **Performance**: DID creation is lightweight and can happen client-side
3. **Flexibility**: Backend can use any database; frontend stays simple
4. **Compatibility**: Avoids serverless runtime constraints

## Complete Example

Here's the full flow for creating a list with a verifiable credential:

### Step 1: User Creates List (Frontend)

```tsx
// components/CreateList.tsx
import { createListAsset } from "@/lib/originals";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

function CreateListButton() {
  const createList = useMutation(api.lists.create);
  const { user } = useAuth();

  async function handleCreate() {
    // 1. Create the did:peer on the frontend
    const listAsset = await createListAsset("My List", user.did);
    
    // 2. Send to backend for storage + credential issuance
    await createList({
      assetDid: listAsset.assetDid,
      name: listAsset.name,
    });
  }

  return <button onClick={handleCreate}>Create List</button>;
}
```

### Step 2: Backend Stores and Issues VC (Convex)

```typescript
// convex/lists.ts
"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { verifyAuthToken } from "./lib/jwt";
import { TurnkeyWebVHSigner } from "./lib/turnkeySigner";

export const create = action({
  args: {
    assetDid: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    // 1. Verify the user's JWT
    const token = ctx.headers.get("Authorization")?.slice(7);
    const auth = await verifyAuthToken(token!);
    
    // 2. Store the list in the database
    const listId = await ctx.runMutation(internal.lists.insert, {
      assetDid: args.assetDid,
      name: args.name,
      ownerId: auth.turnkeySubOrgId,
    });
    
    // 3. Issue a verifiable credential for ownership
    const credential = await issueOwnershipCredential(
      args.assetDid,
      auth.turnkeySubOrgId
    );
    
    // 4. Store the credential
    await ctx.runMutation(internal.credentials.insert, {
      listId,
      credential: JSON.stringify(credential),
    });
    
    return { listId, assetDid: args.assetDid };
  },
});
```

### Step 3: Issue the Credential

```typescript
// convex/lib/credentials.ts
import { TurnkeyWebVHSigner } from "./turnkeySigner";
import { Turnkey } from "@turnkey/sdk-server";

async function issueOwnershipCredential(
  assetDid: string, 
  ownerSubOrgId: string
) {
  const turnkey = new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
    apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
    defaultOrganizationId: process.env.TURNKEY_ORG_ID!,
  });

  const signer = new TurnkeyWebVHSigner(
    ownerSubOrgId,
    keyId,
    publicKeyMultibase,
    turnkey,
    verificationMethodId
  );

  const credential = {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    type: ["VerifiableCredential", "AssetOwnershipCredential"],
    issuer: issuerDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: {
      id: ownerSubOrgId,
      owns: assetDid,
    },
  };

  const proof = await signer.sign({
    document: credential,
    proof: {
      type: "DataIntegrityProof",
      cryptosuite: "eddsa-jcs-2022",
      verificationMethod: signer.getVerificationMethodId(),
      created: new Date().toISOString(),
      proofPurpose: "assertionMethod",
    },
  });

  return { ...credential, proof };
}
```

## Summary

| Concern | Location | Package/Tool |
|---------|----------|--------------|
| DID creation | Frontend | `@originals/sdk` |
| Authentication | Frontend | `@originals/auth` |
| JWT validation | Backend | `jose` (local helper) |
| Credential signing | Backend | Local `TurnkeyWebVHSigner` |
| Data persistence | Backend | Convex/Postgres/etc |

This pattern keeps your frontend simple, your backend secure, and avoids runtime compatibility issues with serverless platforms.
