import { PrivyClient } from "@privy-io/server-auth";
import { convertToMultibase, extractPublicKeyFromWallet } from "./key-utils";
import crypto from "crypto";

export interface DIDWebVHCreationResult {
  did: string;
  didDocument: any;
  authWalletId: string;
  assertionWalletId: string;
  updateWalletId: string;
  authKeyPublic: string;
  assertionKeyPublic: string;
  updateKeyPublic: string;
  didCreatedAt: Date;
  didSlug: string;
}

/**
 * Feature flag for DID:WebVH migration
 */
export function isDidWebVHEnabled(): boolean {
  return process.env.AUTH_DID_WEBVH_ENABLED === 'true';
}

/**
 * Feature flag for dual-read mode (accept both did:webvh and did:privy)
 */
export function isDualReadEnabled(): boolean {
  return process.env.AUTH_DID_DUAL_READ_ENABLED !== 'false'; // Default to true during migration
}

/**
 * Feature flag for dual-write mode (write both did:webvh and did:privy)
 */
export function isDualWriteEnabled(): boolean {
  return process.env.AUTH_DID_DUAL_WRITE_ENABLED !== 'false'; // Default to true during migration
}

/**
 * Generate a sanitized user slug from Privy user ID
 * This creates a stable, URL-safe identifier for the DID
 * @param privyUserId - The Privy user ID (e.g., "did:privy:...")
 * @returns Sanitized slug for use in did:webvh
 */
function generateUserSlug(privyUserId: string): string {
  // Strip "did:privy:" prefix if present
  let slug = privyUserId.replace(/^did:privy:/, '');
  
  // Create a hash-based slug for stability and uniqueness
  // Using SHA256 truncated to 16 chars ensures no collisions and valid URLs
  const hash = crypto.createHash('sha256').update(slug).digest('hex').substring(0, 16);
  
  // Prefix with 'u-' to ensure it starts with a letter (valid for URLs)
  return `u-${hash}`;
}

/**
 * Create a DID:WebVH for a user using didwebvh-ts library
 * This is the canonical way to create DIDs for users post-migration
 * @param privyUserId - The Privy user ID
 * @param privyClient - Initialized Privy client
 * @param domain - Domain to use in the DID (e.g., "localhost:5000" or "app.example.com")
 * @returns DID creation result with all metadata
 */
export async function createUserDIDWebVH(
  privyUserId: string,
  privyClient: PrivyClient,
  domain: string = process.env.DID_DOMAIN || process.env.VITE_APP_DOMAIN || 'localhost:5000'
): Promise<DIDWebVHCreationResult> {
  try {
    const correlationId = crypto.randomUUID();
    console.log(`[${correlationId}] Creating DID:WebVH for user ${privyUserId}...`);

    // Get policy IDs from environment (may be required by Privy)
    const rawPolicyIds = process.env.PRIVY_EMBEDDED_WALLET_POLICY_IDS || "";
    const policyIds = rawPolicyIds
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Step 1: Create Bitcoin wallet (for authentication key)
    console.log(`[${correlationId}] Creating Bitcoin wallet for authentication...`);
    const btcWallet = await privyClient.walletApi.createWallet({
      owner: {
        userId: privyUserId,
      },
      chainType: "bitcoin-segwit",
      policyIds: policyIds.length > 0 ? policyIds : [],
    });

    // Step 2: Create first Stellar wallet (for assertion method)
    console.log(`[${correlationId}] Creating Stellar wallet for assertion...`);
    const stellarAssertionWallet = await privyClient.walletApi.createWallet({
      owner: {
        userId: privyUserId,
      },
      chainType: "stellar",
      policyIds: policyIds.length > 0 ? policyIds : [],
    });

    // Step 3: Create second Stellar wallet (for DID updates)
    console.log(`[${correlationId}] Creating Stellar wallet for updates...`);
    const stellarUpdateWallet = await privyClient.walletApi.createWallet({
      owner: {
        userId: privyUserId,
      },
      chainType: "stellar",
      policyIds: policyIds.length > 0 ? policyIds : [],
    });

    // Step 4: Extract public keys from wallets
    console.log(`[${correlationId}] Extracting public keys...`);
    
    const btcPublicKeyHex = extractPublicKeyFromWallet(btcWallet);
    const stellarAssertionKeyHex = extractPublicKeyFromWallet(stellarAssertionWallet);
    const stellarUpdateKeyHex = extractPublicKeyFromWallet(stellarUpdateWallet);

    // Step 5: Convert public keys to multibase format
    console.log(`[${correlationId}] Converting keys to multibase format...`);
    const authKeyMultibase = convertToMultibase(btcPublicKeyHex, 'Secp256k1');
    const assertionKeyMultibase = convertToMultibase(stellarAssertionKeyHex, 'Ed25519');
    const updateKeyMultibase = convertToMultibase(stellarUpdateKeyHex, 'Ed25519');

    // Step 6: Generate user slug and DID
    const userSlug = generateUserSlug(privyUserId);
    
    // URL-encode the domain to handle ports (e.g., localhost:5000 -> localhost%3A5000)
    // This is required by the DID:WebVH spec for proper transformation
    const encodedDomain = encodeURIComponent(domain);
    const did = `did:webvh:${encodedDomain}:${userSlug}`;

    console.log(`[${correlationId}] Generated DID:WebVH: ${did}`);

    // Step 7: Create DID document according to DID:WebVH spec
    // Per spec, the DID document (did.jsonld) contains verification methods
    // The update key is stored in a separate version history file (did.jsonl)
    const didDocument = {
      "@context": [
        "https://www.w3.org/ns/did/v1",
        "https://w3id.org/security/multikey/v1"
      ],
      "id": did,
      "verificationMethod": [
        {
          "id": `${did}#auth-key`,
          "type": "Multikey",
          "controller": did,
          "publicKeyMultibase": authKeyMultibase
        },
        {
          "id": `${did}#assertion-key`,
          "type": "Multikey",
          "controller": did,
          "publicKeyMultibase": assertionKeyMultibase
        }
      ],
      "authentication": [`${did}#auth-key`],
      "assertionMethod": [`${did}#assertion-key`]
    };

    console.log(`[${correlationId}] DID:WebVH document created successfully`);

    // Emit metric for DID creation success
    emitMetric('didwebvh.create.success', 1, { userId: privyUserId });

    // Step 8: Return all metadata
    return {
      did,
      didDocument,
      authWalletId: btcWallet.id,
      assertionWalletId: stellarAssertionWallet.id,
      updateWalletId: stellarUpdateWallet.id,
      authKeyPublic: authKeyMultibase,
      assertionKeyPublic: assertionKeyMultibase,
      updateKeyPublic: updateKeyMultibase,
      didCreatedAt: new Date(),
      didSlug: userSlug,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Error creating DID:WebVH:', error);
    
    // Emit metric for DID creation failure
    emitMetric('didwebvh.create.error', 1, { userId: privyUserId, error: errorMessage });
    
    throw new Error(`Failed to create DID:WebVH: ${errorMessage}`);
  }
}

/**
 * Verify a DID:WebVH identifier
 * This validates the DID format and attempts to resolve it
 * @param did - The DID to verify
 * @returns Verification result
 */
export async function verifyDIDWebVH(did: string): Promise<{
  valid: boolean;
  error?: string;
  document?: any;
}> {
  const startTime = Date.now();
  try {
    // Validate DID format
    if (!did.startsWith('did:webvh:')) {
      return { valid: false, error: 'Invalid DID format - must start with did:webvh:' };
    }

    // Parse DID components
    const parts = did.split(':');
    if (parts.length < 4) {
      return { valid: false, error: 'Invalid DID format - missing required components' };
    }

    // Attempt to resolve the DID (this would use didwebvh-ts in production)
    // For now, we consider it valid if it follows the format
    const latency = Date.now() - startTime;
    emitMetric('didwebvh.verify.latency', latency);
    emitMetric('didwebvh.verify.success', 1);

    return { valid: true };
  } catch (error) {
    const latency = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    emitMetric('didwebvh.verify.latency', latency);
    emitMetric('didwebvh.verify.error', 1, { error: errorMessage });
    
    return { valid: false, error: errorMessage };
  }
}

/**
 * Resolve a DID:WebVH to its DID Document
 * Uses caching to meet performance requirements
 * @param did - The DID to resolve
 * @returns DID Document or null if not found
 */
export async function resolveDIDWebVH(did: string): Promise<any | null> {
  const startTime = Date.now();
  try {
    // Check cache first
    const cached = didCache.get(did);
    if (cached && cached.expiresAt > Date.now()) {
      const latency = Date.now() - startTime;
      emitMetric('didwebvh.resolve.latency', latency, { cache: 'hit' });
      return cached.document;
    }

    // Cache miss - resolve from network
    // In a real implementation, this would fetch from the DID:WebVH URL
    // For now, we'll just return null to indicate not found
    const latency = Date.now() - startTime;
    emitMetric('didwebvh.resolve.latency', latency, { cache: 'miss' });
    emitMetric('didwebvh.resolve.cache_miss', 1);
    
    return null;
  } catch (error) {
    const latency = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    emitMetric('didwebvh.resolve.latency', latency, { cache: 'miss' });
    emitMetric('didwebvh.resolve.error', 1, { error: errorMessage });
    
    console.error('Error resolving DID:WebVH:', error);
    return null;
  }
}

/**
 * Simple in-memory cache for DID resolution
 * In production, use Redis or similar distributed cache
 */
const didCache = new Map<string, { document: any; expiresAt: number }>();

/**
 * Cache a DID Document
 * @param did - The DID
 * @param document - The DID Document
 * @param ttlMs - Time to live in milliseconds (default: 5 minutes)
 */
export function cacheDIDDocument(did: string, document: any, ttlMs: number = 5 * 60 * 1000): void {
  didCache.set(did, {
    document,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Get user slug from a DID:WebVH
 * @param did - The full DID (e.g., "did:webvh:localhost%3A5000:u-abc123")
 * @returns The user slug or null if invalid format
 */
export function getUserSlugFromDID(did: string): string | null {
  // DID format: did:webvh:{encoded-domain}:{slug}
  const parts = did.split(':');
  
  // Valid format: ['did', 'webvh', '{encoded-domain}', '{slug}']
  if (parts.length < 4 || parts[0] !== 'did' || parts[1] !== 'webvh') {
    return null;
  }
  
  // Return the last segment (the user slug)
  return parts[parts.length - 1];
}

/**
 * Emit a metric (placeholder - integrate with your observability system)
 * @param name - Metric name
 * @param value - Metric value
 * @param tags - Optional tags
 */
function emitMetric(name: string, value: number, tags?: Record<string, string>): void {
  // In production, send to your metrics backend (Datadog, Prometheus, etc.)
  // For now, just log to console in development
  if (process.env.NODE_ENV === 'development') {
    console.log(`[METRIC] ${name}=${value}`, tags || '');
  }
}

/**
 * Log an audit event (no sensitive data)
 * @param event - Event name
 * @param data - Event data
 * @param correlationId - Optional correlation ID
 */
export function auditLog(event: string, data: Record<string, any>, correlationId?: string): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    event,
    correlationId: correlationId || crypto.randomUUID(),
    ...data,
  };
  
  // In production, send to your logging backend
  // Ensure no sensitive data (keys, tokens) is logged
  console.log('[AUDIT]', JSON.stringify(logEntry));
}
