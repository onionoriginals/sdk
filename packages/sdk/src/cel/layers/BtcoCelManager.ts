/**
 * BtcoCelManager - CEL Manager for did:btco Layer
 * 
 * Manages migration of Originals assets to the did:btco layer (Layer 2).
 * This layer provides Bitcoin-based witnessing for maximum immutability.
 * 
 * The did:btco method anchors asset provenance on the Bitcoin blockchain
 * using ordinals inscriptions, providing the highest level of trust
 * and permanence in the Originals Protocol.
 * 
 * @see https://github.com/aviarytech/did-btco
 */

import type { EventLog, ExternalReference, UpdateOptions, AssetState, WitnessProof } from '../types.js';
import { appendEvent } from '../algorithms/appendEvent.js';
import type { BitcoinManager } from '../../bitcoin/BitcoinManager.js';
import type { CelSigner } from './PeerCelManager.js';
import { btcoDidPrefix, btcoDidFromSatoshi } from '../btcoDid.js';
import { deriveDidCel } from '../celDid.js';
import { computeDigestMultibase } from '../hash.js';
import { canonicalizeEntryForChain } from '../canonicalize.js';

/**
 * Configuration options for BtcoCelManager
 */
export interface BtcoCelConfig {
  /** The DID URL of the verification method for signing */
  verificationMethod?: string;
  /** The purpose of proofs (defaults to 'assertionMethod') */
  proofPurpose?: string;
  /** Fee rate in sat/vB for Bitcoin transactions (optional - BitcoinManager will estimate if not provided) */
  feeRate?: number;
  /**
   * Bitcoin network fallback for replaying LEGACY btco logs whose signed
   * migration data predates the recorded `network` field, when no
   * BitcoinManager is configured (read-only replay). New logs record the
   * network in the signed data, so this is never consulted for them.
   */
  network?: 'mainnet' | 'regtest' | 'signet';
}

/**
 * Migration data stored in the update event when migrating to btco
 */
export interface BtcoMigrationData {
  /** The source DID from the previous layer */
  sourceDid: string;
  /**
   * The resolvable did:btco:<satoshi> DID. Optional in the signed event data:
   * the satoshi is only known after inscription, so it is carried in the
   * bitcoin witness proof and the DID is derived from there during state
   * derivation rather than being embedded in (and signed as part of) the data.
   */
  targetDid?: string;
  /**
   * The resolvable `did:btco:<network>:<sat>` anchor, SIGNED into the migrate
   * body (#397, design 2026-07-13). Unlike targetDid this is required by the
   * anchored-sat verifier: the sat is pinned before the reveal (via
   * inscribeData's buildContent callback) so it can be signed here, and the
   * verifier derives the anchoring sat from THIS signed field — not the
   * unsigned witness proof. Absent only on legacy logs written before #397.
   */
  to?: string;
  /** The target layer */
  layer: 'btco';
  /**
   * The Bitcoin network the inscription is made on, recorded at migration time.
   * The network is known before inscription (unlike the satoshi), so it lives in
   * the SIGNED migration data — this lets state derivation reconstruct the
   * network-scoped did:btco identifier deterministically from the log rather
   * than from the replaying SDK's runtime config. Absent on logs created before
   * this field existed.
   */
  network?: 'mainnet' | 'regtest' | 'signet';
  /** The Bitcoin transaction ID anchoring the migration */
  txid?: string;
  /** The inscription ID on Bitcoin */
  inscriptionId?: string;
  /** ISO 8601 timestamp of migration */
  migratedAt: string;
}

/**
 * BtcoCelManager - Manages CEL-based asset migration to did:btco layer
 * 
 * The btco layer is the final publication layer for Originals assets.
 * Assets at this layer:
 * - Have a did:btco identifier anchored on Bitcoin
 * - Have mandatory Bitcoin witness attestations via ordinals
 * - Provide maximum immutability and timestamping
 * - Cannot be migrated to any other layer
 * 
 * @example
 * ```typescript
 * const bitcoinManager = new BitcoinManager(config);
 * const manager = new BtcoCelManager(
 *   async (data) => createEdDsaProof(data, privateKey),
 *   bitcoinManager
 * );
 * 
 * const btcoLog = await manager.migrate(webvhLog);
 * console.log(btcoLog.events[btcoLog.events.length - 1].data.txid);
 * ```
 */
export class BtcoCelManager {
  private signer: CelSigner;
  private bitcoinManager?: BitcoinManager;
  private config: BtcoCelConfig;

  /**
   * Creates a new BtcoCelManager instance
   *
   * @param signer - Function that signs data and returns a DataIntegrityProof
   * @param bitcoinManager - BitcoinManager instance for ordinals inscriptions.
   *   Optional: only WRITE operations (migrate — it inscribes) need it; pure
   *   reads like getCurrentState replay the persisted log deterministically
   *   and work without one.
   * @param config - Optional configuration options
   */
  constructor(
    signer: CelSigner,
    bitcoinManager?: BitcoinManager,
    config: BtcoCelConfig = {}
  ) {
    if (typeof signer !== 'function') {
      throw new Error('BtcoCelManager requires a signer function');
    }
    // Guard the optional middle parameter: passing a config object where the
    // BitcoinManager belongs (`new BtcoCelManager(signer, { feeRate: 5 })`)
    // would otherwise be silently accepted and only blow up deep inside
    // migrate(). Duck-type on the one method every manager (and test mock)
    // provides.
    if (
      bitcoinManager !== undefined &&
      typeof (bitcoinManager as unknown as { inscribeData?: unknown }).inscribeData !== 'function'
    ) {
      throw new Error(
        'BtcoCelManager second argument must be a BitcoinManager (or undefined for read-only replay); ' +
        'pass configuration as the third argument.'
      );
    }

    this.signer = signer;
    this.bitcoinManager = bitcoinManager;
    this.config = {
      proofPurpose: 'assertionMethod',
      ...config,
    };
  }

  /** The BitcoinManager, or a clear error for write paths that need one. */
  private requireBitcoinManager(): BitcoinManager {
    if (!this.bitcoinManager) {
      throw new Error('BTCO operations require a BitcoinManager. Provide it in config.btco.bitcoinManager');
    }
    return this.bitcoinManager;
  }

  /**
   * Migrates a webvh layer event log to the did:btco layer
   * 
   * This method:
   * 1. Validates the input log (must have migrated to webvh layer)
   * 2. Creates an update event with migration data
   * 3. Adds mandatory Bitcoin witness proof via ordinals inscription
   * 4. Generates a did:btco DID based on the inscription
   * 5. Returns the updated EventLog
   * 
   * Note: Bitcoin witness is REQUIRED at this layer - it cannot be skipped.
   * 
   * @param webvhLog - The event log from the webvh layer to migrate
   * @returns Promise resolving to an EventLog with the migration event appended
   * 
   * @throws Error if the log is empty, deactivated, or not from webvh layer
   * @throws Error if signer produces invalid proof
   * @throws Error if Bitcoin inscription fails
   */
  async migrate(webvhLog: EventLog): Promise<EventLog> {
    // Migration inscribes on Bitcoin — it is the write path that genuinely
    // needs a BitcoinManager. Fail up front with a clear error.
    const bitcoinManager = this.requireBitcoinManager();

    // Validate input log
    if (!webvhLog || !webvhLog.events || webvhLog.events.length === 0) {
      throw new Error('Cannot migrate an empty event log');
    }

    // Get the create event to extract source DID
    const createEvent = webvhLog.events[0];
    if (createEvent.type !== 'create') {
      throw new Error('First event must be a create event');
    }

    // Find the current layer and DID by checking for migration events
    let currentDid: string | undefined;
    let currentLayer: string | undefined;

    // Look through events to find the latest migration
    for (const event of webvhLog.events) {
      const eventData = event.data as Record<string, unknown>;
      
      if (event.type === 'create') {
        // Dual-read: new-shape genesis (controller present) derives its
        // identity (did:cel); legacy genesis embeds `did` and is read verbatim.
        currentDid = eventData.controller !== undefined
          ? deriveDidCel(webvhLog)
          : (eventData.did as string);
        currentLayer = eventData.layer as string || 'peer';
      } else if (
        // Type-first: first-class 'migrate' events are migrations by type.
        (event.type === 'migrate' && eventData?.layer) ||
        // Legacy sniff kept verbatim: old logs record migrations as 'update'
        // events. Detect via sourceDid (present on both webvh and btco
        // migrations) rather than targetDid (webvh-only), so a log already
        // migrated to btco is recognised as such and the terminal guard below
        // correctly rejects a second btco migration. webvh migrations carry
        // the resolvable targetDid; btco migrations don't, but migrate() only
        // proceeds from the webvh layer anyway.
        (event.type === 'update' && eventData.sourceDid && eventData.layer && eventData.migratedAt)
      ) {
        currentLayer = eventData.layer as string;
        currentDid = (eventData.targetDid as string) ?? (eventData.sourceDid as string);
      }
    }

    if (!currentDid) {
      throw new Error('Could not determine current DID from event log');
    }

    // Validate source is from webvh layer (only webvh can migrate to btco)
    if (currentLayer !== 'webvh') {
      throw new Error(`Cannot migrate from ${currentLayer} layer to btco layer. Must migrate to webvh first.`);
    }

    // Check if log is already deactivated
    const lastEvent = webvhLog.events[webvhLog.events.length - 1];
    if (lastEvent.type === 'deactivate') {
      throw new Error('Cannot migrate a deactivated event log');
    }

    const network = bitcoinManager.network;

    // The did:cel back-link so on-chain anchorings are enumerable for the
    // first-anchor-wins uniqueness check: new-shape genesis derives its did:cel;
    // a legacy genesis embeds `did` (uniqueness is not run for those, but the
    // back-link is harmless). Placed in the inscribed doc's alsoKnownAs.
    const genesisData = createEvent.data as Record<string, unknown>;
    const didCel = genesisData.controller !== undefined
      ? deriveDidCel(webvhLog)
      : (genesisData.did as string | undefined);

    // Build update options
    const updateOptions: UpdateOptions = {
      signer: this.signer,
      verificationMethod: this.config.verificationMethod || `${currentDid}#key-0`,
      proofPurpose: this.config.proofPurpose,
    };

    // Pin-sat-first (#397, design 2026-07-13). The anchored-sat verifier requires
    // the migrate body to SIGN its anchoring sat as `to: did:btco:<network>:<sat>`,
    // but the sat is only known after the reveal. inscribeData's buildContent
    // callback pins the sat BEFORE the reveal, so we sign the migrate event —
    // carrying the resolvable `to` — inside it, then inscribe the asset's btco DID
    // document, which IS the witness artifact: its #cel OriginalsCelAnchor commits
    // to that event's chain digest. Mirrors LifecycleManager.inscribeOnBitcoin.
    // (Replaces the old digest-first appendEvent→witnessEvent path, which emitted a
    // bare migrate the verifier now rejects with UNBOUND_ANCHOR.)
    let signedLog: EventLog | undefined;
    let signedTo: string | undefined;
    const inscription = await bitcoinManager.inscribeData(
      async (satoshi: string) => {
        const migrationData: BtcoMigrationData = {
          sourceDid: currentDid!,
          layer: 'btco',
          // The network lives in the SIGNED data so replaying the log is
          // deterministic; the sat completes the resolvable `to` anchor.
          network,
          to: btcoDidFromSatoshi(satoshi, network),
          migratedAt: new Date().toISOString(),
        };
        signedTo = migrationData.to;
        signedLog = await appendEvent(webvhLog, 'migrate', migrationData, updateOptions);
        // The DID doc's #cel anchor commits to THIS migrate event's chain digest
        // (proof-excluded), so the append must precede doc construction.
        const migrateEvent = signedLog.events[signedLog.events.length - 1];
        const headDigestMultibase = computeDigestMultibase(canonicalizeEntryForChain(migrateEvent));
        const btcoDid = btcoDidFromSatoshi(satoshi, network);
        const btcoDoc = {
          '@context': ['https://www.w3.org/ns/did/v1'],
          id: btcoDid,
          // Back-link the did:cel so on-chain anchorings are enumerable (uniqueness).
          ...(didCel ? { alsoKnownAs: [didCel] } : {}),
          service: [
            {
              id: `${btcoDid}#cel`,
              type: 'OriginalsCelAnchor',
              serviceEndpoint: { headDigestMultibase },
            },
          ],
        };
        return Buffer.from(JSON.stringify(btcoDoc));
      },
      'application/did+json',
      this.config.feeRate,
      // Key the shared money-lock by the asset's stable identity so a concurrent
      // inscription of the same asset (even from another manager) is rejected
      // before broadcast rather than double-paying (mirrors LifecycleManager, #303).
      { lockKey: didCel ?? currentDid }
    ) as {
      txid: string;
      inscriptionId: string;
      satoshi?: string;
      blockHeight?: number;
    };

    if (!signedLog || signedTo === undefined) {
      throw new Error('Bitcoin inscription did not invoke the buildContent callback to sign the migrate event');
    }
    if (!inscription.inscriptionId || !inscription.txid) {
      throw new Error('Bitcoin inscription did not return a valid inscription id or transaction id');
    }
    // The satoshi anchors the did:btco identity. Fail closed if absent, and —
    // critically — if it diverges from the sat signed into `data.to`: the sat
    // signed, the sat the witness proof carries, and the sat the inscription
    // landed on MUST all agree, or the log would anchor to the wrong sat.
    // Normalise to a string: the verifier only recognises bitcoin witness proofs
    // whose `satoshi` is a string, so a provider that returns a numeric sat would
    // otherwise produce a paid-for but permanently unverifiable log.
    if (inscription.satoshi === undefined || inscription.satoshi === null || (inscription.satoshi as unknown) === '') {
      throw new Error('Bitcoin inscription did not return a satoshi ordinal (required for the did:btco anchor)');
    }
    const satoshi = String(inscription.satoshi);
    if (signedTo !== btcoDidFromSatoshi(satoshi, network)) {
      throw new Error(
        `Anchoring sat mismatch: migrate event signed ${signedTo} but the inscription landed on satoshi ${satoshi}`
      );
    }

    // Attach the bitcoin witness proof carrying that SAME sat. Chain digests
    // exclude the proof array, so this post-hoc attach cannot alter the signed
    // body or the anchored head digest (mirrors witnessEvent / LifecycleManager).
    const now = new Date().toISOString();
    const witnessProof: WitnessProof & {
      txid: string;
      satoshi: string;
      inscriptionId: string;
      blockHeight?: number;
    } = {
      type: 'DataIntegrityProof',
      cryptosuite: 'bitcoin-ordinals-2024',
      created: now,
      verificationMethod: this.config.verificationMethod ?? 'did:btco:witness',
      proofPurpose: 'assertionMethod',
      proofValue: `z${inscription.inscriptionId}`,
      witnessedAt: now,
      txid: inscription.txid,
      satoshi,
      inscriptionId: inscription.inscriptionId,
      ...(inscription.blockHeight !== undefined ? { blockHeight: inscription.blockHeight } : {}),
    };

    const migrateIdx = signedLog.events.length - 1;
    const events = signedLog.events.slice();
    events[migrateIdx] = {
      ...events[migrateIdx],
      proof: [...events[migrateIdx].proof, witnessProof],
    };

    return { ...signedLog, events };
  }

  /**
   * The network-scoped did:btco prefix for the configured Bitcoin network.
   * Delegates to the shared helper so all btco identifiers the SDK emits
   * (state derivation, CLI display) agree on the prefix.
   */
  private btcoDidPrefix(network: string | undefined): string {
    return btcoDidPrefix(network);
  }

  /**
   * Derives the current asset state by replaying all events in the log.
   *
   * @param log - The event log to derive state from
   * @returns The current AssetState derived from replaying events
   */
  getCurrentState(log: EventLog): AssetState {
    // Validate input log
    if (!log || !log.events || log.events.length === 0) {
      throw new Error('Cannot get state from an empty event log');
    }

    // First event must be a create event
    const createEvent = log.events[0];
    if (createEvent.type !== 'create') {
      throw new Error('First event must be a create event');
    }

    // Extract initial state from create event. Dual-read the genesis: a
    // new-shape genesis (`controller` present) derives its identity (did:cel)
    // and sources the creator from the controller; a legacy genesis embeds
    // `did`/`creator` and is read verbatim.
    const createData = createEvent.data as Record<string, unknown>;
    const isLegacyGenesis = createData.controller === undefined && createData.did !== undefined;

    // Shapeless genesis (neither controller nor did): the verifier reports no
    // assetDid for this shape (verifyEventLog.ts), so minting a did:cel here
    // would produce state for a DID the log cannot back. Fail closed instead.
    if (createData.controller === undefined && createData.did === undefined) {
      throw new Error(
        'Cannot derive asset state: genesis create event has neither `controller` nor `did`'
      );
    }

    // Initialize state from create event
    const state: AssetState = {
      did: isLegacyGenesis ? (createData.did as string) : deriveDidCel(log),
      name: createData.name as string | undefined,
      layer: (createData.layer as 'peer' | 'webvh' | 'btco') || 'peer',
      resources: (createData.resources as ExternalReference[]) || [],
      creator: (createData.creator as string | undefined) ?? (createData.controller as string | undefined),
      controller: createData.controller as string | undefined,
      createdAt: createData.createdAt as string | undefined,
      updatedAt: undefined,
      deactivated: false,
      metadata: {},
    };

    // Apply subsequent events
    for (let i = 1; i < log.events.length; i++) {
      const event = log.events[i];

      if (event.type === 'update' || event.type === 'migrate') {
        const updateData = event.data as Record<string, unknown>;

        // Type-first: first-class 'migrate' events are migrations by type.
        // Legacy logs record migrations as 'update' events — the sniff via
        // sourceDid + layer (regular updates don't carry them) is kept
        // verbatim as fallback. (btco migrations no longer carry targetDid in
        // the signed data — see below.)
        if (event.type === 'migrate' || (updateData.sourceDid && updateData.layer && updateData.migratedAt)) {
          // Migration event - update DID and layer
          state.layer = updateData.layer as 'peer' | 'webvh' | 'btco';
          state.updatedAt = updateData.migratedAt as string;

          // Store migration info in metadata
          state.metadata = state.metadata || {};
          state.metadata.sourceDid = updateData.sourceDid;

          // For btco, the Bitcoin details (txid, inscriptionId, satoshi) are
          // NOT in the signed data — they can't be known before inscription.
          // They are read from the bitcoin witness proof, and the resolvable
          // did:btco:<satoshi> DID is derived from the proof's satoshi.
          if (updateData.layer === 'btco') {
            const bitcoinProof = (event.proof as ReadonlyArray<unknown> | undefined)?.find(
              (p): p is Record<string, unknown> =>
                !!p && typeof p === 'object' && (p as Record<string, unknown>).cryptosuite === 'bitcoin-ordinals-2024'
            );
            if (bitcoinProof?.txid) {
              state.metadata.txid = bitcoinProof.txid;
            }
            if (bitcoinProof?.inscriptionId) {
              state.metadata.inscriptionId = bitcoinProof.inscriptionId;
            }
            if (bitcoinProof?.satoshi) {
              state.metadata.satoshi = bitcoinProof.satoshi;
              // Canonical, resolvable did:btco identifier. The identifier is
              // network-scoped: only mainnet is bare (`did:btco:<sat>`), while
              // signet/regtest carry a prefix (`did:btco:sig:` / `did:btco:reg:`),
              // matching DIDManager/createBtcoDidDocument. The network is read
              // from the SIGNED migration data so replaying a persisted log is
              // deterministic — the DID does not change with the replaying SDK's
              // configured network. Fall back to a configured BitcoinManager's
              // network only for legacy logs written before the network was
              // recorded; without either source, deriving a DID would just be
              // guessing the network, so fail closed with a clear error.
              const network = (updateData.network as string | undefined)
                ?? this.bitcoinManager?.network
                ?? this.config.network;
              if (updateData.network === undefined && !this.bitcoinManager && this.config.network === undefined) {
                throw new Error(
                  'Legacy btco log does not record its Bitcoin network in the signed migration data; ' +
                  'configure a BitcoinManager (config.btco.bitcoinManager) or a fallback network ' +
                  '(BtcoCelConfig.network) so the network can be supplied.'
                );
              }
              state.metadata.network = network;
              state.did = `${this.btcoDidPrefix(network)}:${bitcoinProof.satoshi as string}`;
            }
          } else {
            // Non-btco (webvh) migrations carry their targetDid in the data
            // (domain-derived, known at signing time).
            if (updateData.targetDid) {
              state.did = updateData.targetDid as string;
            }
            if (updateData.domain) {
              state.metadata.domain = updateData.domain;
            }
          }
        } else {
          // Regular update event
          if (updateData.name !== undefined) {
            state.name = updateData.name as string;
          }
          if (updateData.resources !== undefined) {
            state.resources = updateData.resources as ExternalReference[];
          }
          if (updateData.updatedAt !== undefined) {
            state.updatedAt = updateData.updatedAt as string;
          }
          if (updateData.did !== undefined) {
            state.did = updateData.did as string;
          }
          if (updateData.layer !== undefined) {
            state.layer = updateData.layer as 'peer' | 'webvh' | 'btco';
          }
        }
        
        // Store other fields in metadata. `network` is consumed (and stored)
        // explicitly only for btco migration events, so exclude it here for
        // those events alone — for an ordinary update, an application-defined
        // `network` field must still flow through to metadata.
        const excludedKeys = ['name', 'resources', 'updatedAt', 'did', 'layer', 'creator', 'createdAt', 'sourceDid', 'targetDid', 'to', 'domain', 'migratedAt', 'txid', 'inscriptionId'];
        const isBtcoMigration = updateData.layer === 'btco' &&
          (event.type === 'migrate' || (updateData.sourceDid && updateData.migratedAt));
        if (isBtcoMigration) {
          excludedKeys.push('network');
        }
        for (const [key, value] of Object.entries(updateData)) {
          if (!excludedKeys.includes(key)) {
            state.metadata = state.metadata || {};
            state.metadata[key] = value;
          }
        }
      } else if (event.type === 'transfer') {
        // Legacy ownership hand-off (transfer events are no longer written; dual-accept read only): surface the owners; identity (did) is unchanged.
        const transferData = event.data as Record<string, unknown>;
        if (transferData.transferredAt !== undefined) {
          state.updatedAt = transferData.transferredAt as string;
        }
        state.metadata = state.metadata || {};
        if (transferData.previousOwner !== undefined) {
          state.metadata.previousOwner = transferData.previousOwner;
        }
        if (transferData.newOwner !== undefined) {
          state.metadata.newOwner = transferData.newOwner;
        }
        if (transferData.txid !== undefined) {
          state.metadata.txid = transferData.txid;
        }
      } else if (event.type === 'rotateKey') {
        // Authority hand-off: the last rotation's newController is current.
        const rotationData = event.data as Record<string, unknown>;
        if (typeof rotationData?.newController === 'string') {
          state.controller = rotationData.newController;
        }
        if (typeof rotationData?.rotatedAt === 'string') {
          state.updatedAt = rotationData.rotatedAt;
        }
      } else if (event.type === 'deactivate') {
        state.deactivated = true;
        
        const deactivateData = event.data as Record<string, unknown>;
        if (deactivateData.deactivatedAt !== undefined) {
          state.updatedAt = deactivateData.deactivatedAt as string;
        }
        if (deactivateData.reason !== undefined) {
          state.metadata = state.metadata || {};
          state.metadata.deactivationReason = deactivateData.reason;
        }
      }
    }

    return state;
  }

  /**
   * Gets the BitcoinManager instance used by this manager (undefined when the
   * manager was constructed for read-only replay without one)
   */
  get bitcoin(): BitcoinManager | undefined {
    return this.bitcoinManager;
  }
}
