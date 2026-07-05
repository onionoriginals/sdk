import { DIDDocument, OriginalsConfig, AssetResource, KeyPair, ExternalSigner, ExternalVerifier } from '../types/index.js';
import { getNetworkDomain, DEFAULT_WEBVH_NETWORK, getBitcoinNetworkForWebVH } from '../types/network.js';
import { BtcoDidResolver } from './BtcoDidResolver.js';
import { OrdinalsClient } from '../bitcoin/OrdinalsClient.js';
import { createBtcoDidDocument } from './createBtcoDidDocument.js';
import { OrdinalsClientProviderAdapter } from './providers/OrdinalsClientProviderAdapter.js';
import { OrdinalsProviderResolverAdapter } from './providers/OrdinalsProviderResolverAdapter.js';
import { StructuredError } from '../utils/telemetry.js';
import { multikey } from '../crypto/Multikey.js';
import { KeyManager } from './KeyManager.js';
import { WebVHManager, normalizeUpdateKey, assertEd25519WebVHUpdateKeys } from './WebVHManager.js';
import { Ed25519Verifier } from './Ed25519Verifier.js';
import type {
  RotateWebVHKeysOptions,
  RotateWebVHKeysResult,
  RecoverWebVHOptions,
  RecoverWebVHResult,
} from './WebVHManager.js';
import { Ed25519Signer } from '../crypto/Signer.js';
import { validateSatoshiNumber, canonicalizeSatoshi, MAX_SATOSHI_SUPPLY } from '../utils/satoshi-validation.js';
import { DIDCache } from './DIDCache.js';
import type { MetricsCollector } from '../utils/MetricsCollector.js';

/** A carried-over verification method annotated with the single relationship
 * (purpose) it should assume in the migrated did:webvh document. */
interface CarriedVerificationMethod {
  type: 'Multikey';
  publicKeyMultibase: string;
  purpose?: 'keyAgreement' | 'capabilityInvocation' | 'capabilityDelegation';
}

// Relationships that survive migration to did:webvh. authentication and
// assertionMethod are intentionally excluded: the created document assigns them
// to the new signing key (#key-0), so a carried key cannot re-assume them. The
// order is the priority used when a key participates in more than one (a single
// Multikey `purpose` can encode only one).
const PRESERVABLE_RELATIONSHIPS = ['keyAgreement', 'capabilityDelegation', 'capabilityInvocation'] as const;

/**
 * Collect the source did:peer document's verification methods to carry into the
 * migrated did:webvh document, preserving each key's verification relationship
 * (#299). Keys are gathered both from the top-level `verificationMethod` list
 * and — for relationships whose keys are embedded directly (common for X25519
 * `keyAgreement` in did:peer) — from the relationship arrays themselves, so a
 * keyAgreement key that never appears in `verificationMethod` is not lost.
 */
function collectCarriedVerificationMethods(didDoc: DIDDocument): CarriedVerificationMethod[] {
  const byKey = new Map<string, CarriedVerificationMethod>();

  const add = (publicKeyMultibase: unknown, purpose?: CarriedVerificationMethod['purpose']): void => {
    if (typeof publicKeyMultibase !== 'string' || publicKeyMultibase.length === 0) return;
    const existing = byKey.get(publicKeyMultibase);
    if (existing) {
      // First preservable relationship wins the single `purpose` slot.
      if (!existing.purpose && purpose) existing.purpose = purpose;
      return;
    }
    byKey.set(publicKeyMultibase, { type: 'Multikey', publicKeyMultibase, purpose });
  };

  // Bare verification methods (relationship, if any, resolved below).
  for (const vm of didDoc.verificationMethod || []) {
    add(vm.publicKeyMultibase);
  }

  // Assign purposes from the relationship arrays; also picks up embedded keys
  // that are not present in `verificationMethod`.
  for (const rel of PRESERVABLE_RELATIONSHIPS) {
    const entries = didDoc[rel];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry === 'string') {
        const vm = (didDoc.verificationMethod || []).find((v) => v.id === entry);
        if (vm) add(vm.publicKeyMultibase, rel);
      } else if (entry && typeof entry === 'object') {
        add(entry.publicKeyMultibase, rel);
      }
    }
  }

  return Array.from(byKey.values());
}

export class DIDManager {
  private webvhManager?: WebVHManager;
  private readonly metrics?: MetricsCollector;
  public readonly cache: DIDCache;

  constructor(private config: OriginalsConfig, metrics?: MetricsCollector) {
    this.metrics = metrics;
    this.cache = new DIDCache({
      ...(config.didCache || {}),
      metrics,
    });
  }

  private track<T>(op: string, fn: () => Promise<T>): Promise<T> {
    return this.metrics ? this.metrics.track(op, fn) : fn();
  }

  async createDIDPeer(resources: AssetResource[], returnKeyPair?: false): Promise<DIDDocument>;
  async createDIDPeer(resources: AssetResource[], returnKeyPair: true): Promise<{ didDocument: DIDDocument; keyPair: { privateKey: string; publicKey: string } }>;
  async createDIDPeer(resources: AssetResource[], returnKeyPair?: boolean): Promise<DIDDocument | { didDocument: DIDDocument; keyPair: { privateKey: string; publicKey: string } }> {
    return this.track('did.createDIDPeer', async () => {
    // Generate a multikey keypair according to configured defaultKeyType
    const keyManager = new KeyManager();
    const desiredType = this.config.defaultKeyType || 'ES256K';
    const keyPair = await keyManager.generateKeyPair(desiredType);

    // Use @aviarytech/did-peer to create a did:peer (variant 4 long-form for full VM+context)
    const didPeerMod = await import('@aviarytech/did-peer') as unknown as {
      createNumAlgo4: (vms: unknown[], service?: unknown, extra?: unknown) => Promise<string>;
      resolve: (did: string) => Promise<Record<string, unknown>>;
    };
    const did: string = await didPeerMod.createNumAlgo4(
      [
        {
          // type validated by the library; controller/id not required
          type: 'Multikey',
          publicKeyMultibase: keyPair.publicKey
        }
      ],
      undefined,
      undefined
    );

    // Resolve to DID Document using the same library
    const rawResolved = await didPeerMod.resolve(did);
    // Type the resolved document properly
    const resolved = rawResolved as unknown as {
      id?: string;
      verificationMethod?: Array<Record<string, unknown>>;
      authentication?: string[];
      assertionMethod?: string[];
      [key: string]: unknown;
    };
    // Ensure controller is set on VM entries for compatibility
    if (resolved && Array.isArray(resolved.verificationMethod)) {
      resolved.verificationMethod = resolved.verificationMethod.map((vm) => ({
        controller: did,
        ...vm
      }));
    }
    // Ensure relationships exist and reference a VM
    const vmIds: string[] = Array.isArray(resolved?.verificationMethod)
      ? (resolved.verificationMethod as Array<{ id?: string }>).map((vm) => vm.id).filter(Boolean) as string[]
      : [];
    if (!resolved.authentication || resolved.authentication.length === 0) {
      if (vmIds.length > 0) resolved.authentication = [vmIds[0]];
    }
    if (!resolved.assertionMethod || resolved.assertionMethod.length === 0) {
      resolved.assertionMethod = resolved.authentication || (vmIds.length > 0 ? [vmIds[0]] : []);
    }

    if (returnKeyPair) {
      return { didDocument: resolved as unknown as DIDDocument, keyPair };
    }
    return resolved as unknown as DIDDocument;
    }); // end track did.createDIDPeer
  }

  /**
   * Migrate a did:peer document to a real did:webvh.
   *
   * The migration goes through WebVHManager.createDIDWebVH (didwebvh-ts
   * createDID), so the resulting DID has a genuine SCID and a signed DID log
   * — `did:webvh:{SCID}:{domain}:{slug}` — resolvable by any conformant
   * resolver once the log is hosted. (The previous implementation merely
   * renamed the document id to `did:webvh:{domain}:{slug}`, which no resolver
   * — including this SDK's own — could ever resolve; issue #245.)
   *
   * Returns the FULL migration result — not just the DID document. The signed
   * `log` must be hosted (did.jsonl) for the DID to resolve, and the returned
   * `keyPair` (generated unless a keyPair/externalSigner was supplied via
   * `options`) must be persisted for future updates/rotations. Discarding
   * them leaves the migrated DID unhostable and un-updatable.
   *
   * The peer document's verification methods are carried over as
   * verification-only keys, its services are preserved, and the original
   * did:peer is recorded in `alsoKnownAs`. The `keyAgreement`,
   * `capabilityInvocation`, and `capabilityDelegation` relationships each key
   * held in the source document are preserved (#299). `authentication` and
   * `assertionMethod` are re-assigned to the new signing key (`#key-0`) in the
   * created document — a carried key cannot re-assume them here; republish via
   * updateDIDWebVH if a carried key must also authenticate/assert.
   */
  async migrateToDIDWebVH(
    didDoc: DIDDocument,
    domain?: string,
    options?: MigrateToWebVHOptions
  ): Promise<MigrateToWebVHResult> {
    return this.track('did.migrateToDIDWebVH', async () => {
    // Use provided domain or get default from configured network
    const network = this.config.webvhNetwork || DEFAULT_WEBVH_NETWORK;
    const targetDomain = domain || getNetworkDomain(network);

    // Flexible domain validation - allow development domains with ports
    const normalized = String(targetDomain || '').trim().toLowerCase();
    
    // Split domain and port if present
    const [domainPart, portPart] = normalized.split(':');
    
    // Validate port if present
    if (portPart && (!/^\d+$/.test(portPart) || parseInt(portPart) < 1 || parseInt(portPart) > 65535)) {
      throw new Error(`Invalid domain: ${domain} - invalid port`);
    }
    
    // Allow localhost and IP addresses for development
    const isLocalhost = domainPart === 'localhost';
    const isIP = /^(\d{1,3}\.){3}\d{1,3}$/.test(domainPart);
    
    if (!isLocalhost && !isIP) {
      // For non-localhost domains, require proper domain format
      const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
      const domainRegex = new RegExp(`^(?=.{1,253}$)(?:${label})(?:\\.(?:${label}))+?$`, 'i');
      if (!domainRegex.test(domainPart)) {
        throw new Error('Invalid domain');
      }
    }

    // Stable slug derived from original peer DID suffix (or last segment)
    const parts = (didDoc.id || '').split(':');
    const method = parts.slice(0, 2).join(':');
    const originalSuffix = method === 'did:peer' ? parts.slice(2).join(':') : parts[parts.length - 1];
    const slug = (originalSuffix || '')
      .toString()
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .toLowerCase();

    // Carry the peer document's multikey verification methods over as
    // verification-only keys (they do not become updateKeys — log updates are
    // authorized by the signing key generated/provided below). Each carried key
    // also keeps the verification relationship it held in the source document
    // (keyAgreement / capabilityInvocation / capabilityDelegation) so that,
    // e.g., an X25519 keyAgreement key still authorizes encryption after the
    // migration instead of existing as an orphaned verification method (#299).
    // authentication and assertionMethod are owned by the new signing key
    // (#key-0) in the created did:webvh document, so a carried key cannot
    // re-assume those here.
    const carriedVerificationMethods = collectCarriedVerificationMethods(didDoc);

    // Preserve service endpoints
    const services = Array.isArray(didDoc.service)
      ? didDoc.service.map((svc) => ({ ...(svc as unknown as Record<string, unknown>) }))
      : undefined;

    const oldDid = didDoc.id;

    // Create a REAL did:webvh — genuine SCID, signed DID log — via
    // WebVHManager/didwebvh-ts (issue #245). didwebvh-ts percent-encodes a
    // port colon itself, so host[:port] is passed as-is.
    const result = await this.getWebVHManager().createDIDWebVH({
      domain: normalized,
      paths: slug ? [slug] : [],
      keyPair: options?.keyPair,
      externalSigner: options?.externalSigner,
      externalVerifier: options?.externalVerifier,
      verificationMethods: options?.verificationMethods,
      updateKeys: options?.updateKeys,
      outputDir: options?.outputDir,
      portable: options?.portable ?? false,
      additionalVerificationMethods: carriedVerificationMethods,
      alsoKnownAs: [oldDid],
      services,
    });

    return {
      did: result.did,
      didDocument: result.didDocument,
      log: result.log as unknown as DIDLog,
      keyPair: result.keyPair,
      logPath: result.logPath,
      previousDid: oldDid,
    };
    }); // end track did.migrateToDIDWebVH
  }

  /**
   * The Bitcoin network this SDK instance is configured for, or `undefined`
   * when neither an explicit `network` nor a `webvhNetwork` is set (the SDK's
   * network is genuinely unknown). An explicit `network` wins over the WebVH
   * mapping (issue #247). Single source of truth for both did:btco minting
   * (migrateToDIDBTCO) and the cross-network resolution guard (issue #267), so
   * the two can never disagree about which network the SDK is on.
   */
  private getConfiguredBitcoinNetwork(): 'mainnet' | 'regtest' | 'signet' | undefined {
    if (this.config.network) return this.config.network;
    if (this.config.webvhNetwork) return getBitcoinNetworkForWebVH(this.config.webvhNetwork);
    return undefined;
  }

  async migrateToDIDBTCO(didDoc: DIDDocument, satoshi: string): Promise<DIDDocument> {
    return this.track('did.migrateToDIDBTCO', async () => {
    // Validate satoshi parameter
    const validation = validateSatoshiNumber(satoshi);
    if (!validation.valid) {
      throw new Error(`Invalid satoshi identifier: ${validation.error}`);
    }

    // Additional range validation for positive values within Bitcoin supply
    const satoshiNum = Number(satoshi);
    if (satoshiNum < 0) {
      throw new Error('Satoshi identifier must be positive (>= 0)');
    }
    if (satoshiNum > MAX_SATOSHI_SUPPLY) {
      throw new Error(`Satoshi identifier must be within Bitcoin's total supply (0 to ${MAX_SATOSHI_SUPPLY.toLocaleString()})`);
    }

    // Determine the Bitcoin network. An explicitly configured `network` wins:
    // OriginalsSDK.create() always injects a default webvhNetwork ('pichu'),
    // so deriving from webvhNetwork first would silently override an explicit
    // `network: 'regtest'` and mint mainnet-form identifiers for regtest
    // inscriptions (issue #247). The WebVH mapping (magby→regtest,
    // cleffa→signet, pichu→mainnet) applies only when no explicit Bitcoin
    // network was configured.
    const network: 'mainnet' | 'regtest' | 'signet' = this.getConfiguredBitcoinNetwork() ?? 'mainnet';

    // Try to carry over the first multikey VM if present
    const firstVm = didDoc.verificationMethod?.[0];
    let publicKey: Uint8Array | undefined;
    let keyType: Parameters<typeof createBtcoDidDocument>[2]['keyType'] | undefined;
    try {
      if (firstVm && firstVm.publicKeyMultibase) {
        const decoded = multikey.decodePublicKey(firstVm.publicKeyMultibase);
        publicKey = decoded.key;
        keyType = decoded.type;
      }
    } catch (err) {
      // Unable to decode public key from verification method; will proceed without key material
      if (this.config.enableLogging) {
        console.warn('Failed to decode verification method public key:', err);
      }
    }

    // If no key material is available, generate a minimal btco DID doc without keys
    let btcoDoc: DIDDocument;
    if (publicKey && keyType) {
      btcoDoc = createBtcoDidDocument(satoshi, network, { publicKey, keyType });
    } else {
      const prefix = network === 'mainnet' ? 'did:btco:' : network === 'regtest' ? 'did:btco:reg:' : 'did:btco:sig:';
      btcoDoc = {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: prefix + canonicalizeSatoshi(satoshi)
      };
    }

    // Carry over service endpoints if present
    if (didDoc.service && didDoc.service.length > 0) {
      btcoDoc.service = didDoc.service;
    }
    return await Promise.resolve(btcoDoc);
    }); // end track did.migrateToDIDBTCO
  }

  async resolveDID(did: string, options?: { skipCache?: boolean }): Promise<DIDDocument | null> {
    return this.track('did.resolveDID', async () => {
      // Check cache first (unless skipCache is set). The read is best-effort:
      // a throwing storage adapter must not crash resolution — treat it as a miss.
      if (!options?.skipCache) {
        let cached: DIDDocument | null = null;
        try {
          cached = await this.cache.get(did);
        } catch {
          // best-effort cache read
        }
        if (cached) {
          return cached;
        }
      }

      // Resolution failures and unsupported methods return null — never a
      // fabricated stub document. A stub would pass validateDIDDocument and
      // make "does this DID exist?" checks succeed for DIDs that failed to
      // resolve, pushing the error far downstream.
      let result: DIDDocument | null = null;
      try {
        if (did.startsWith('did:peer:')) {
          try {
            const mod = await import('@aviarytech/did-peer') as unknown as { resolve: (did: string) => Promise<Record<string, unknown>> };
            const doc = await mod.resolve(did);
            result = doc as unknown as DIDDocument;
          } catch (err) {
            if (this.config.enableLogging) {
              console.warn('Failed to resolve did:peer:', err);
            }
          }
        } else if (did.startsWith('did:btco:')) {
          if (this.config.ordinalsProvider) {
            // The configured ordinalsProvider is pinned to one Bitcoin
            // network, so a DID whose encoded network differs must be
            // rejected before querying (issue #267): otherwise an attacker
            // can inscribe "did:btco:reg:N" content on mainnet sat N and have
            // it resolve — and be cached — as the regtest DID.
            const btcoNetworkPrefix = did.match(/^did:btco:(reg|sig|test):/)?.[1];
            // 'test' (testnet) has no OrdinalsClient/config counterpart;
            // preserve existing pass-through behavior for it.
            //
            // Only reject when the SDK's network is actually known. If neither
            // `network` nor `webvhNetwork` is configured, the provider's chain
            // is genuinely unknown, so defaulting to mainnet and rejecting a
            // reg/sig DID would be a false positive — fall through and let the
            // provider answer (its own resolution still validates the DID).
            const providerNetwork = this.getConfiguredBitcoinNetwork();
            if (btcoNetworkPrefix !== 'test' && providerNetwork) {
              const didNetwork: 'mainnet' | 'regtest' | 'signet' =
                btcoNetworkPrefix === 'reg' ? 'regtest'
                : btcoNetworkPrefix === 'sig' ? 'signet'
                : 'mainnet';
              if (didNetwork !== providerNetwork) {
                throw new StructuredError(
                  'BTCO_NETWORK_MISMATCH',
                  `Cannot resolve ${did}: the DID targets the ${didNetwork} network but the configured ` +
                  `ordinalsProvider serves ${providerNetwork}. Configure an SDK instance for ${didNetwork} ` +
                  'to resolve this DID.'
                );
              }
            }
            // The configured ordinalsProvider is the source of truth for
            // Bitcoin state (it performed the inscriptions), so resolution
            // must go through it — not through a freshly constructed HTTP
            // client pointed at some unrelated endpoint.
            const adapter = new OrdinalsProviderResolverAdapter(this.config.ordinalsProvider);
            const resolver = new BtcoDidResolver({ provider: adapter, fetchFn: adapter.fetchContent });
            const resolved = await resolver.resolve(did);
            result = resolved.didDocument || null;
          } else if (this.config.bitcoinRpcUrl) {
            const rpcUrl = this.config.bitcoinRpcUrl;
            // The network is encoded in the DID itself (did:btco:reg:/did:btco:sig:,
            // unprefixed = mainnet), so resolution must follow the DID, not the
            // SDK-wide config — a signet DID handed to a mainnet-configured SDK
            // must still be treated as a signet identifier.
            const btcoPrefix = did.match(/^did:btco:(reg|sig|test):/)?.[1];
            const network: 'mainnet' | 'regtest' | 'signet' =
              btcoPrefix === 'reg' ? 'regtest'
              : btcoPrefix === 'sig' ? 'signet'
              : btcoPrefix === 'test'
                // OrdinalsClient has no testnet variant; fall back to the
                // configured network (BtcoDidResolver still validates the DID
                // against its own testnet prefix).
                ? (this.config.network || 'mainnet')
                : 'mainnet';
            const client = new OrdinalsClient(rpcUrl, network);
            const adapter = new OrdinalsClientProviderAdapter(client, rpcUrl);
            const resolver = new BtcoDidResolver({ provider: adapter });
            const resolved = await resolver.resolve(did);
            result = resolved.didDocument || null;
          } else {
            // No provider and no explicit RPC URL: fail loudly. Silently
            // defaulting to http://localhost:3000 either fails far from the
            // cause or — worse — trusts whatever unrelated service happens to
            // listen there as the source of DID documents.
            throw new StructuredError(
              'ORD_PROVIDER_REQUIRED',
              'Resolving did:btco requires an ordinalsProvider (or an explicit bitcoinRpcUrl) to be configured. ' +
              'Provide an ordinalsProvider when creating the SDK. See README.md for configuration examples.'
            );
          }
        } else if (did.startsWith('did:webvh:')) {
          try {
            const mod = await import('didwebvh-ts') as {
              resolveDID?: (did: string, options?: { verifier?: ExternalVerifier }) => Promise<{ doc?: Record<string, unknown> }>;
            };
            if (mod && typeof mod.resolveDID === 'function') {
              // didwebvh-ts requires a verifier to validate the DID log's
              // signatures during resolution; the first log entry is always
              // verified, so omitting it makes resolveDID throw internally and
              // every valid did:webvh resolve to null. Ed25519Verifier is the
              // SDK's spec-compliant verifier for these logs.
              const resolved = await mod.resolveDID(did, { verifier: new Ed25519Verifier() });
              if (resolved && resolved.doc) {
                result = resolved.doc as unknown as DIDDocument;
              }
            }
          } catch (err) {
            if (this.config.enableLogging) {
              console.warn('Failed to resolve did:webvh:', err);
            }
          }
        } else if (this.config.enableLogging) {
          console.warn(`Unsupported DID method for resolution: ${did}`);
        }
      } catch (err) {
        // Misconfiguration must fail loudly — swallowing it into a null would
        // reproduce the silent-failure mode this error exists to prevent.
        if (err instanceof StructuredError &&
            (err.code === 'ORD_PROVIDER_REQUIRED' || err.code === 'BTCO_NETWORK_MISMATCH')) {
          throw err;
        }
        // DID resolution failed
        if (this.config.enableLogging) {
          console.error('Failed to resolve DID:', err);
        }
        return null;
      }

      // Only cache genuinely-resolved documents; transient failures (e.g. network
      // blips on did:webvh) must not poison the cache with a degraded stub.
      if (result) {
        try {
          await this.cache.set(did, result);
        } catch {
          // Cache write is best-effort; a storage failure must not discard a
          // successfully-resolved document.
        }
      }
      return result;
    }); // end track did.resolveDID
  }

  validateDIDDocument(didDoc: DIDDocument): boolean {
    return !!didDoc.id && Array.isArray(didDoc['@context']);
  }

  private getLayerFromDID(did: string): 'did:peer' | 'did:webvh' | 'did:btco' {
    if (did.startsWith('did:peer:')) return 'did:peer';
    if (did.startsWith('did:webvh:')) return 'did:webvh';
    if (did.startsWith('did:btco:')) return 'did:btco';
    throw new Error('Unsupported DID method');
  }

  createBtcoDidDocument(
    satNumber: number | string,
    network: 'mainnet' | 'regtest' | 'signet',
    options: Parameters<typeof createBtcoDidDocument>[2]
  ): DIDDocument {
    return createBtcoDidDocument(satNumber, network, options);
  }

  // ========================================================================
  // DID:WebVH Methods
  // ========================================================================

  /**
   * Creates a new did:webvh DID with proper cryptographic signing
   * @param options - Creation options including domain and optional key pair or external signer
   * @returns The created DID, document, log, and key pair (if generated)
   */
  async createDIDWebVH(options: CreateWebVHOptions): Promise<CreateWebVHResult> {
    const {
      domain: providedDomain,
      keyPair: providedKeyPair,
      paths = [],
      portable = false,
      outputDir,
      externalSigner,
      externalVerifier,
      verificationMethods: providedVerificationMethods,
      updateKeys: providedUpdateKeys
    } = options;

    // Use provided domain or get default from configured network
    const network = this.config.webvhNetwork || DEFAULT_WEBVH_NETWORK;
    const domain = providedDomain || getNetworkDomain(network);

    // Dynamically import didwebvh-ts to avoid module resolution issues
    const mod = await import('didwebvh-ts') as unknown as {
      createDID: (options: Record<string, unknown>) => Promise<{
        did: string;
        doc: Record<string, unknown>;
        log: DIDLog;
      }>;
      prepareDataForSigning: (
        document: Record<string, unknown>,
        proof: Record<string, unknown>
      ) => Promise<Uint8Array>;
    };
    const { createDID, prepareDataForSigning } = mod;

    // Runtime validation of imported module
    if (typeof createDID !== 'function' || typeof prepareDataForSigning !== 'function') {
      throw new Error('Failed to load didwebvh-ts: invalid module exports');
    }

    let signer: Signer | ExternalSigner;
    let verifier: Verifier | ExternalVerifier;
    let keyPair: KeyPair | undefined;
    let verificationMethods: WebVHVerificationMethod[];
    let updateKeys: string[];

    // Use external signer if provided (e.g., Turnkey integration)
    if (externalSigner) {
      if (!providedVerificationMethods || providedVerificationMethods.length === 0) {
        throw new Error('verificationMethods are required when using externalSigner');
      }
      if (!providedUpdateKeys || providedUpdateKeys.length === 0) {
        throw new Error('updateKeys are required when using externalSigner');
      }

      signer = externalSigner;
      // An ExternalSigner has no verify(); silently casting it to a verifier
      // makes didwebvh-ts fail deep inside with "verifier.verify is not a
      // function". Accept the signer only if it actually implements verify().
      if (externalVerifier) {
        verifier = externalVerifier;
      } else if (typeof (externalSigner as unknown as { verify?: unknown }).verify === 'function') {
        verifier = externalSigner as unknown as ExternalVerifier;
      } else {
        throw new Error(
          'externalVerifier is required when the provided externalSigner does not implement verify()'
        );
      }
      verificationMethods = providedVerificationMethods;
      updateKeys = providedUpdateKeys.map(normalizeUpdateKey);
      assertEd25519WebVHUpdateKeys(updateKeys);
      keyPair = undefined; // No key pair when using external signer
    } else {
      // Generate or use provided key pair (Ed25519 for did:webvh)
      const keyManager = new KeyManager();
      keyPair = providedKeyPair || await keyManager.generateKeyPair('Ed25519');

      // Create verification methods
      verificationMethods = [
        {
          type: 'Multikey',
          publicKeyMultibase: keyPair.publicKey,
        }
      ];

      // Create signer using our adapter
      const internalSigner = new OriginalsWebVHSigner(
        keyPair.privateKey,
        verificationMethods[0],
        prepareDataForSigning,
        { verificationMethod: verificationMethods[0] }
      );

      signer = internalSigner;
      verifier = internalSigner; // Use the same signer as verifier
      // Bare multikey format per the did:webvh spec (didwebvh-ts >= 2.8)
      updateKeys = [keyPair.publicKey];
    }

    // Create the DID using didwebvh-ts
    const result = await createDID({
      domain,
      signer,
      verifier,
      updateKeys,
      verificationMethods,
      context: [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1'
      ],
      paths,
      portable,
      authentication: ['#key-0'],
      assertionMethod: ['#key-0'],
    });

    // Validate the returned DID document
    if (!this.validateDIDDocument(result.doc as unknown as DIDDocument)) {
      throw new Error('Invalid DID document returned from createDID');
    }

    // Save the log to did.jsonl if output directory is provided
    let logPath: string | undefined;
    if (outputDir) {
      logPath = await this.saveDIDLog(result.did, result.log, outputDir);
    }

    return {
      did: result.did,
      didDocument: result.doc as unknown as DIDDocument,
      log: result.log,
      keyPair: keyPair || { publicKey: '', privateKey: '' }, // Return empty keypair if using external signer
      logPath,
    };
  }

  /**
   * Updates a DID:WebVH document. Delegates to WebVHManager, which refuses to
   * append an ordinary entry on a pre-rotation chain (that would set an
   * un-committed updateKey and break resolution for every resolver).
   * @param options - Update options
   * @returns Updated DID document and log
   */
  async updateDIDWebVH(options: {
    did: string;
    currentLog: DIDLog;
    updates: Partial<DIDDocument>;
    signer: ExternalSigner | { privateKey: string; publicKey: string };
    verifier?: ExternalVerifier;
    outputDir?: string;
  }): Promise<{ didDocument: DIDDocument; log: DIDLog; logPath?: string }> {
    const result = await this.getWebVHManager().updateDIDWebVH(options);
    await this.invalidateCachedDID(options.did);
    return result;
  }

  /**
   * Append a new did:webvh log entry that rotates the signing key. The CURRENT
   * key pair (which must be authorized by the latest entry's updateKeys) signs
   * the rotation, and the NEW key becomes both the verification method and the
   * updateKey authorized for the next rotation.
   */
  async rotateDIDWebVHKeys(options: RotateWebVHKeysOptions): Promise<RotateWebVHKeysResult> {
    const result = await this.getWebVHManager().rotateDIDWebVHKeys(options);
    await this.invalidateCachedDID(options.did);
    return result;
  }

  /**
   * Recover a did:webvh after key compromise. Behaves like a rotation (the
   * compromised key authorizes the recovery entry, a new key takes over), and
   * additionally emits a W3C KeyRecoveryCredential documenting the event.
   */
  async recoverDIDWebVH(options: RecoverWebVHOptions): Promise<RecoverWebVHResult> {
    const result = await this.getWebVHManager().recoverDIDWebVH(options);
    await this.invalidateCachedDID(options.did);
    return result;
  }

  /**
   * Drop the cached document for a DID after a successful mutation
   * (update/rotate/recover). Without this, resolveDID keeps serving the
   * pre-mutation document — including a compromised key after recovery —
   * for up to the cache TTL (issue #268). Best-effort: a failing cache
   * backend must not fail the mutation that already succeeded.
   */
  private async invalidateCachedDID(did: string): Promise<void> {
    try {
      await this.cache.delete(did);
    } catch {
      // best-effort cache invalidation
    }
  }

  /** Lazily instantiate the WebVHManager used for rotation/recovery primitives. */
  private getWebVHManager(): WebVHManager {
    if (!this.webvhManager) {
      this.webvhManager = new WebVHManager();
    }
    return this.webvhManager;
  }

  /**
   * Saves the DID log to the appropriate did.jsonl path
   * @param did - The DID identifier
   * @param log - The DID log to save
   * @param baseDir - Base directory for saving (e.g., public/.well-known)
   * @returns The full path where the log was saved
   */
  async saveDIDLog(did: string, log: DIDLog, baseDir: string): Promise<string> {
    // Delegate to WebVHManager: single source of truth for the SCID-first
    // did:webvh parsing and the resolution-URL-mirroring layout (issue #246).
    return this.getWebVHManager().saveDIDLog(did, log, baseDir);
  }

  /**
   * Loads a DID log from a did.jsonl file
   * @param logPath - Path to the did.jsonl file
   * @returns The loaded DID log
   */
  async loadDIDLog(logPath: string): Promise<DIDLog> {
    return this.getWebVHManager().loadDIDLog(logPath);
  }

}

// Type definitions for didwebvh-ts (to avoid module resolution issues)
interface WebVHVerificationMethod {
  id?: string;
  type: string;
  controller?: string;
  publicKeyMultibase: string;
  secretKeyMultibase?: string;
  purpose?: 'authentication' | 'assertionMethod' | 'keyAgreement' | 'capabilityInvocation' | 'capabilityDelegation';
}

interface SigningInput {
  document: Record<string, unknown>;
  proof: Record<string, unknown>;
}

interface SigningOutput {
  proofValue: string;
}

interface SignerOptions {
  verificationMethod?: WebVHVerificationMethod | null;
  useStaticId?: boolean;
}

interface Signer {
  sign(input: SigningInput): Promise<SigningOutput>;
  getVerificationMethodId(): string;
}

interface Verifier {
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
}

interface DIDLogEntry {
  versionId: string;
  versionTime: string;
  parameters: Record<string, unknown>;
  state: Record<string, unknown>;
  proof?: Record<string, unknown>[];
}

type DIDLog = DIDLogEntry[];

export interface CreateWebVHOptions {
  domain?: string; // Optional - defaults to configured webvhNetwork domain
  keyPair?: KeyPair;
  paths?: string[];
  portable?: boolean;
  outputDir?: string;
  externalSigner?: ExternalSigner;
  externalVerifier?: ExternalVerifier;
  verificationMethods?: WebVHVerificationMethod[];
  updateKeys?: string[];
}

/**
 * Result of migrateToDIDWebVH: the migrated document plus everything needed
 * to actually operate the DID — the signed log to host and the update key
 * pair to persist.
 */
export interface MigrateToWebVHResult {
  did: string;
  didDocument: DIDDocument;
  log: DIDLog;
  keyPair: KeyPair;
  logPath?: string;
  previousDid: string;
}

/**
 * Options for migrateToDIDWebVH. Signing options
 * mirror CreateWebVHOptions: supply a keyPair or externalSigner to control the
 * did:webvh update key; otherwise a fresh Ed25519 key pair is generated.
 */
export interface MigrateToWebVHOptions {
  keyPair?: KeyPair;
  externalSigner?: ExternalSigner;
  externalVerifier?: ExternalVerifier;
  verificationMethods?: WebVHVerificationMethod[];
  updateKeys?: string[];
  outputDir?: string;
  portable?: boolean;
}

export interface CreateWebVHResult {
  did: string;
  didDocument: DIDDocument;
  log: DIDLog;
  keyPair: KeyPair;
  logPath?: string;
}

// Rotation/recovery option and result shapes are defined alongside the
// WebVHManager primitives they drive.
export type {
  RotateWebVHKeysOptions,
  RotateWebVHKeysResult,
  RecoverWebVHOptions,
  RecoverWebVHResult,
  KeyRecoveryCredential,
} from './WebVHManager.js';

/**
 * Adapter to use Originals SDK signers with didwebvh-ts
 */
class OriginalsWebVHSigner implements Signer, Verifier {
  private privateKeyMultibase: string;
  private signer: Ed25519Signer;
  protected verificationMethod?: WebVHVerificationMethod | null;
  protected useStaticId: boolean;
  private prepareDataForSigning: (document: Record<string, unknown>, proof: Record<string, unknown>) => Promise<Uint8Array>;

  constructor(
    privateKeyMultibase: string,
    verificationMethod: WebVHVerificationMethod,
    prepareDataForSigning: (document: Record<string, unknown>, proof: Record<string, unknown>) => Promise<Uint8Array>,
    options: SignerOptions = {}
  ) {
    this.privateKeyMultibase = privateKeyMultibase;
    this.verificationMethod = options.verificationMethod || verificationMethod;
    this.useStaticId = options.useStaticId || false;
    this.signer = new Ed25519Signer();
    this.prepareDataForSigning = prepareDataForSigning;
  }

  async sign(input: SigningInput): Promise<SigningOutput> {
    // Prepare the data for signing using didwebvh-ts's canonical approach
    const dataToSign = await this.prepareDataForSigning(input.document, input.proof);
    
    // Sign using our Ed25519 signer
    const signature: Buffer = await this.signer.sign(
      Buffer.from(dataToSign),
      this.privateKeyMultibase
    );

    // Encode signature as multibase
    const proofValue = multikey.encodeMultibase(signature);

    return { proofValue };
  }

  async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
    // Decode the public key to multibase format
    const publicKeyMultibase = multikey.encodePublicKey(publicKey, 'Ed25519');
    
    // Verify using our Ed25519 signer
    const messageBuffer: Buffer = Buffer.from(message);
    const signatureBuffer: Buffer = Buffer.from(signature);
    
    return this.signer.verify(
      messageBuffer,
      signatureBuffer,
      publicKeyMultibase
    );
  }

  getVerificationMethodId(): string {
    // didwebvh-ts requires verification method to be a did:key: identifier
    // Extract the multibase key from the verification method
    const publicKeyMultibase = this.verificationMethod?.publicKeyMultibase;
    if (!publicKeyMultibase) {
      throw new Error('Verification method must have publicKeyMultibase');
    }
    // Return as did:key format which didwebvh-ts expects
    return `did:key:${publicKeyMultibase}`;
  }
}


