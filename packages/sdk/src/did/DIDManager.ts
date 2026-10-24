import { DIDDocument, OriginalsConfig, KeyPair, ExternalSigner, ExternalVerifier } from '../types/index.js';
import { getBitcoinNetworkForWebVH } from '../types/network.js';
import { BtcoDidResolver } from './BtcoDidResolver.js';
import { createBtcoDidDocument } from './createBtcoDidDocument.js';
import { StructuredError } from '../utils/telemetry.js';
import { multikey } from '../crypto/Multikey.js';
import { WebVHManager } from './WebVHManager.js';
import { Ed25519Verifier } from './Ed25519Verifier.js';
import type {
  RotateWebVHKeysOptions,
  RotateWebVHKeysResult,
  RecoverWebVHOptions,
  RecoverWebVHResult,
} from './WebVHManager.js';
import { validateSatoshiNumber, canonicalizeSatoshi, MAX_SATOSHI_SUPPLY } from '../utils/satoshi-validation.js';
import { canonicalizeWebVHDomain } from './webvh-names.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
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
 * Longest source-DID suffix carried verbatim into the did:webvh slug during
 * migration. Longer suffixes are replaced by a 32-hex-char SHA-256 prefix of
 * the suffix so the slug — which becomes a filesystem directory name when the
 * DID log is saved, and a URL path segment when it is hosted — always fits
 * within the 255-byte filename limit.
 */
const MAX_HUMAN_READABLE_SLUG_LENGTH = 64;

/**
 * Collect the source document's verification methods to carry into the migrated
 * did:webvh document, preserving each key's verification relationship (#299).
 * Keys are gathered both from the top-level `verificationMethod` list and — for
 * relationships whose keys are embedded directly (e.g. an embedded X25519
 * `keyAgreement` key) — from the relationship arrays themselves, so a
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

/**
 * Resolve the caller-supplied did:webvh domain, or throw. The SDK no longer
 * guesses one: #520 decided the *.originals.build networks are never stood up,
 * and a did:webvh domain is permanent once published — so an omitted domain
 * must fail loudly rather than mint a DID at a host nobody serves (#531). The
 * configured webvhNetwork tier deliberately does NOT supply a default here.
 *
 * A non-blank domain is canonicalized by `canonicalizeWebVHDomain`
 * (identity policy: a DNS host, punycode host or `localhost`, `URL#host` spelling), which
 * throws a `StructuredError` `INVALID_DOMAIN` otherwise.
 */
export function requireWebVHDomain(domain: string | undefined): string {
  if (typeof domain !== 'string' || domain.trim().length === 0) {
    throw new StructuredError(
      'WEBVH_DOMAIN_REQUIRED',
      'A did:webvh domain is required: pass an explicit `domain` (e.g. "example.com" or ' +
      '"localhost:3000"). The SDK no longer defaults to a *.originals.build host — those ' +
      'networks are not served, and a did:webvh domain is permanent once published.'
    );
  }
  return canonicalizeWebVHDomain(domain, { identity: true });
}

/** Methods whose documents can change without this instance's knowledge, so `mode: 'current'` reads them again. */
function changesElsewhere(did: string): boolean {
  return did.startsWith('did:webvh:') || did.startsWith('did:btco:');
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

  /**
   * Migrate a DID document to a real did:webvh.
   *
   * The migration goes through WebVHManager.createDIDWebVH (didwebvh-ts
   * createDID), so the resulting DID has a genuine SCID and a signed DID log
   * — `did:webvh:{SCID}:{domain}:{slug}` — resolvable by any conformant
   * resolver once the log is hosted. (The previous implementation merely
   * renamed the document id to `did:webvh:{domain}:{slug}`, which no resolver
   * — including this SDK's own — could ever resolve; issue #245.)
   *
   * `domain` is required: an omitted or empty domain throws
   * WEBVH_DOMAIN_REQUIRED rather than defaulting to a *.originals.build host
   * nobody serves (#531).
   *
   * Returns the FULL migration result — not just the DID document. The signed
   * `log` must be hosted (did.jsonl) for the DID to resolve, and the returned
   * `keyPair` (generated unless a keyPair or externalSigner was supplied via
   * `options`; absent when an externalSigner holds the key material) must be
   * persisted for future updates/rotations. Discarding them leaves the
   * migrated DID unhostable and un-updatable. Provide either `keyPair` OR
   * `externalSigner` in `options`, never both.
   *
   * The source document's verification methods are carried over as
   * verification-only keys, its services are preserved, and the original
   * source DID is recorded in `alsoKnownAs`. The `keyAgreement`,
   * `capabilityInvocation`, and `capabilityDelegation` relationships each key
   * held in the source document are preserved (#299). `authentication` and
   * `assertionMethod` are re-assigned to the new signing key (`#key-0`) in the
   * created document — a carried key cannot re-assume them here; republish via
   * updateDIDWebVH if a carried key must also authenticate/assert.
   */
  async migrateToDIDWebVH(
    didDoc: DIDDocument,
    domain: string,
    options?: MigrateToWebVHOptions
  ): Promise<MigrateToWebVHResult> {
    return this.track('did.migrateToDIDWebVH', async () => {
    // The caller must name the host; an omitted domain throws rather than
    // defaulting to a *.originals.build network nobody serves (#531).
    // requireWebVHDomain also canonicalizes (trim + lowercase + host/port
    // validation), so `normalized` below is already the exact value to mint
    // the did:webvh identifier from (#722, #761, #764).
    const normalized = requireWebVHDomain(domain);

    // Stable slug derived from the source DID's last segment. The slug becomes
    // both a did:webvh path segment and a directory name in saveDIDLog, so it
    // must stay well under the 255-byte filename limit: short suffixes keep the
    // human-readable form; anything longer collapses to a short, stable hash of
    // the suffix.
    const parts = (didDoc.id || '').split(':');
    const originalSuffix = parts[parts.length - 1];
    const rawSlug = (originalSuffix || '')
      .toString()
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .toLowerCase();
    const slug = rawSlug.length <= MAX_HUMAN_READABLE_SLUG_LENGTH
      ? rawSlug
      : bytesToHex(sha256(new TextEncoder().encode(originalSuffix))).slice(0, 32);

    // Carry the source document's multikey verification methods over as
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
      ...(result.keyPair ? { keyPair: result.keyPair } : {}),
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
  private getConfiguredBitcoinNetwork(): 'mainnet' | 'testnet' | 'regtest' | 'signet' | undefined {
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
    const network: 'mainnet' | 'testnet' | 'regtest' | 'signet' = this.getConfiguredBitcoinNetwork() ?? 'mainnet';

    // Carry over the first verification method's key into the did:btco
    // document. If the source document declares a verification method but its
    // key cannot be carried (missing or undecodable multikey), FAIL LOUDLY:
    // silently continuing used to mint a KEYLESS did:btco document, so callers
    // believed they had migrated an identity they control while the resulting
    // DID had no usable verification method (issue #318).
    const firstVm = didDoc.verificationMethod?.[0];
    let publicKey: Uint8Array | undefined;
    let keyType: Parameters<typeof createBtcoDidDocument>[2]['keyType'] | undefined;
    if (firstVm) {
      if (!firstVm.publicKeyMultibase) {
        throw new StructuredError(
          'BTCO_MIGRATION_KEY_DECODE_FAILED',
          `Cannot migrate ${didDoc.id} to did:btco: verification method ${firstVm.id} has no publicKeyMultibase, so its key cannot be carried into the did:btco document. Migrating anyway would produce a keyless DID with no usable verification method.`,
          { did: didDoc.id, verificationMethodId: firstVm.id }
        );
      }
      try {
        const decoded = multikey.decodePublicKey(firstVm.publicKeyMultibase);
        publicKey = decoded.key;
        keyType = decoded.type;
      } catch (err) {
        throw new StructuredError(
          'BTCO_MIGRATION_KEY_DECODE_FAILED',
          `Cannot migrate ${didDoc.id} to did:btco: failed to decode the multikey of verification method ${firstVm.id} (${err instanceof Error ? err.message : String(err)}). Migrating anyway would produce a keyless DID with no usable verification method.`,
          { did: didDoc.id, verificationMethodId: firstVm.id }
        );
      }
    }

    // Explicit keyless case: the source document declares NO verification
    // methods at all, so there is genuinely no key material to lose. Only then
    // do we mint a minimal btco DID document without keys.
    let btcoDoc: DIDDocument;
    if (publicKey && keyType) {
      btcoDoc = createBtcoDidDocument(satoshi, network, { publicKey, keyType });
    } else {
      const prefix =
        network === 'mainnet' ? 'did:btco:'
        : network === 'regtest' ? 'did:btco:reg:'
        : network === 'testnet' ? 'did:btco:test:'
        : 'did:btco:sig:';
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

  /**
   * Cross-network did:btco guard (issue #267). The configured ordinalsProvider
   * is pinned to one Bitcoin network, so a DID whose encoded network differs
   * must be rejected — otherwise an attacker can inscribe a "did:btco:reg:N"
   * document on mainnet sat N and have it resolve as the regtest DID. This runs
   * BEFORE the cache lookup: DIDCache supports a pluggable persistent storage
   * adapter that may be shared between SDK instances on different networks, so
   * a cached cross-network document must not bypass the guard (issue #312). It
   * is a prefix parse of the DID string — no provider query. Where the SDK's
   * network is unknown, the resolver compares the DID with the sat read's own
   * network, and a mismatch there fails the same way.
   */
  private assertBtcoNetworkMatchesProvider(did: string): void {
    if (!did.startsWith('did:btco:') || !this.config.ordinalsProvider) return;
    const btcoNetworkPrefix = did.match(/^did:btco:(reg|sig|test):/)?.[1];
    // 'test' (testnet) has no OrdinalsClient/config counterpart; preserve
    // existing pass-through behavior for it.
    //
    // Only reject when the SDK's network is actually known. If neither
    // `network` nor `webvhNetwork` is configured, the provider's chain is
    // genuinely unknown, so defaulting to mainnet and rejecting a reg/sig DID
    // would be a false positive — fall through and let the provider answer
    // (its own resolution still validates the DID).
    const providerNetwork = this.getConfiguredBitcoinNetwork();
    if (btcoNetworkPrefix === 'test' || !providerNetwork) return;
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

  async resolveDID(did: string, options?: DIDResolutionOptions): Promise<DIDDocument | null> {
    return this.resolveDIDTracked(did, options);
  }

  /**
   * Resolve a DID together with freshness metadata: whether the document
   * came from cache, an explicit offline snapshot, or a live re-resolution,
   * plus when it was resolved and whether the cache entry is pinned
   * (issue #602). Security-sensitive authorization decisions should request
   * `mode: 'current'` (as `Verifier` and `DocumentLoader` already do
   * internally) rather than branch on this metadata.
   */
  async resolveDIDWithFreshness(
    did: string,
    options?: { mode?: 'cache' | 'current' | 'offline' }
  ): Promise<DIDResolutionResult> {
    if (options?.mode === 'offline') {
      const cached = await this.cache.getWithMetadata(did);
      return {
        didDocument: cached?.document ?? null,
        didResolutionMetadata: {
          source: 'offline-snapshot',
          fresh: false,
          resolvedAt: cached?.resolvedAt ?? null,
          pinned: cached?.pinned ?? false,
        },
      };
    }

    // `mode: 'current'` only actually makes `resolveDID` bypass its cache for
    // did:webvh and did:btco (the methods whose cache entry can go stale
    // behind this instance's back — see `changesElsewhere`). For every other
    // method, `resolveDID` may still legitimately serve a cached document even
    // when 'current' was requested, so this must check the cache itself rather
    // than assume a network read happened — otherwise a genuine cache hit gets
    // mislabeled `source: 'network', fresh: true`.
    const bypassesCache = options?.mode === 'current' && changesElsewhere(did);

    if (!bypassesCache) {
      const cached = await this.cache.getWithMetadata(did);
      if (cached) {
        return {
          didDocument: cached.document,
          didResolutionMetadata: {
            source: 'cache',
            fresh: false,
            resolvedAt: cached.resolvedAt,
            pinned: cached.pinned,
          },
        };
      }
    }

    const didDocument = await this.resolveDID(did, options?.mode === 'current' ? { mode: 'current' } : undefined);
    if (!didDocument) {
      return {
        didDocument: null,
        didResolutionMetadata: { source: 'network', fresh: false, resolvedAt: null, pinned: false },
      };
    }
    // Read back what resolveDID just persisted so resolvedAt/pinned reflect
    // the actual cache entry rather than an approximate timestamp.
    const stored = await this.cache.getWithMetadata(did);
    return {
      didDocument,
      didResolutionMetadata: {
        source: 'network',
        fresh: true,
        resolvedAt: stored?.resolvedAt ?? Date.now(),
        pinned: stored?.pinned ?? false,
      },
    };
  }

  private async resolveDIDTracked(
    did: string,
    options: DIDResolutionOptions | undefined
  ): Promise<DIDDocument | null> {
    return this.track('did.resolveDID', async () => {
      // Network guard must precede the cache read (issue #312).
      this.assertBtcoNetworkMatchesProvider(did);

      // Check cache first (unless skipCache is set, or the caller requested
      // `mode: 'current'` for a mutable method). did:webvh authority can be
      // rotated/recovered by another process/host at any time, and a did:btco
      // by whoever holds its sat inscribing a new version; a verifier
      // deciding whether a key is PRESENTLY authorized must not accept a
      // cached (however recent, and even pinned) pre-rotation document as
      // current-authority evidence — that cache can only be invalidated by
      // this same DIDManager instance's own mutations (issue #602). Other
      // methods are unaffected: did:key never populates this cache at all
      // (it is synthesized locally by DocumentLoader).
      const requiresFreshResolution = options?.mode === 'current' && changesElsewhere(did);
      if (!options?.skipCache && !requiresFreshResolution) {
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
        // did:peer is not a supported method; it falls through to the
        // unsupported-method null below like any other unknown method.
        if (did.startsWith('did:btco:')) {
          // Cross-network guard already enforced pre-cache by
          // assertBtcoNetworkMatchesProvider (issues #267/#312). A did:btco is
          // read as one complete sat snapshot, with its DID document in the
          // inscription metadata (did:btco method v0.2.0; plan 011 PR 9c). A
          // provider that cannot take one cannot resolve did:btco.
          const provider = this.config.ordinalsProvider;
          if (!provider?.getSatSnapshot) {
            throw new StructuredError(
              'ORD_PROVIDER_REQUIRED',
              'Resolving did:btco requires an ordinalsProvider that reads complete sat snapshots (getSatSnapshot), ' +
              'such as RegtestProvider or QuickNodeProvider. See README.md for configuration examples.'
            );
          }
          const resolver = new BtcoDidResolver({ satSnapshot: (sat) => provider.getSatSnapshot!(sat) });
          const resolved = await resolver.resolve(did);
          if (resolved.resolutionMetadata.error === 'networkMismatch') {
            throw new StructuredError('BTCO_NETWORK_MISMATCH', `Cannot resolve ${did}: ${resolved.resolutionMetadata.message ?? 'the provider reads another network'}`);
          }
          result = resolved.didDocument || null;
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
   * Creates a new did:webvh DID with proper cryptographic signing.
   *
   * Delegates to WebVHManager.createDIDWebVH — the single implementation.
   * (This method used to carry a diverged duplicate of that logic which,
   * among other gaps, skipped path-segment validation.)
   *
   * `options.domain` is required: an omitted or empty domain throws
   * WEBVH_DOMAIN_REQUIRED rather than defaulting to a *.originals.build host
   * nobody serves (#531).
   *
   * Provide either `keyPair` OR `externalSigner`, never both (CLAUDE.md
   * gotcha #7). With an externalSigner the result carries NO `keyPair`.
   *
   * @param options - Creation options including domain and optional key pair or external signer
   * @returns The created DID, document, log, and key pair (if generated)
   */
  async createDIDWebVH(options: CreateWebVHOptions): Promise<CreateWebVHResult> {
    // The caller must name the host; an omitted domain throws rather than
    // defaulting to a *.originals.build network nobody serves (#531).
    const domain = requireWebVHDomain(options.domain);
    return this.getWebVHManager().createDIDWebVH({ ...options, domain });
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

interface DIDLogEntry {
  versionId: string;
  versionTime: string;
  parameters: Record<string, unknown>;
  state: Record<string, unknown>;
  proof?: Record<string, unknown>[];
}

type DIDLog = DIDLogEntry[];

/**
 * Options controlling DID resolution freshness (issue #602).
 */
export interface DIDResolutionOptions {
  /** @deprecated use `mode: 'current'` instead. */
  skipCache?: boolean;
  /**
   * - `'cache'` (default): return a cached document when present, subject to
   *   the usual TTL/pinning rules.
   * - `'current'`: for mutable methods (did:webvh), bypass the cache read
   *   entirely and always re-resolve live, so an externally rotated or
   *   recovered DID cannot remain authoritative from a stale or pinned
   *   cache entry. Required for security-sensitive authorization decisions.
   */
  mode?: 'cache' | 'current';
}

export interface DIDResolutionMetadata {
  /** Where the returned document came from. */
  source: 'cache' | 'network' | 'offline-snapshot';
  /** Whether this resolution bypassed the cache to read live state. */
  fresh: boolean;
  /** When the returned document was resolved/cached, or null if unresolved. */
  resolvedAt: number | null;
  /** Whether the cache entry backing this result is pinned. */
  pinned: boolean;
}

export interface DIDResolutionResult {
  didDocument: DIDDocument | null;
  didResolutionMetadata: DIDResolutionMetadata;
}

export interface CreateWebVHOptions {
  domain: string; // Required — the type enforces it and a blank value throws WEBVH_DOMAIN_REQUIRED at runtime (#531)
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
  /**
   * The generated (or caller-provided) update key pair — MUST be persisted
   * for future updates/rotations. Absent when an `externalSigner` was used:
   * the external system holds the key material.
   */
  keyPair?: KeyPair;
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
  /**
   * The generated (or caller-provided) update key pair — MUST be persisted.
   * Absent when an `externalSigner` was used (no fake placeholder is returned).
   */
  keyPair?: KeyPair;
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
