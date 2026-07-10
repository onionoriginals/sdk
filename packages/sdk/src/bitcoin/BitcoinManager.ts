import {
  OriginalsConfig,
  OrdinalsInscription,
  BitcoinTransaction
} from '../types/index.js';
import type { FeeOracleAdapter, OrdinalsProvider } from '../adapters/index.js';
import { emitTelemetry, StructuredError } from '../utils/telemetry.js';
import { validateBitcoinAddress } from '../utils/bitcoin-address.js';
import { validateSatoshiNumber } from '../utils/satoshi-validation.js';

/**
 * Upper bound on any fee rate the SDK will use, whether caller-provided or
 * returned by a fee oracle / ordinals provider. Guards against a misbehaving or
 * compromised estimator draining funds via an absurd sat/vB value. Exported so
 * quote-only paths (LifecycleManager.estimateCost) apply the same cap
 * (issue #351).
 */
export const MAX_REASONABLE_FEE_RATE = 10_000; // sat/vB

export class BitcoinManager {
  private readonly feeOracle?: FeeOracleAdapter;
  private readonly ord?: OrdinalsProvider;

  constructor(private config: OriginalsConfig) {
    this.feeOracle = config.feeOracle;
    this.ord = config.ordinalsProvider;
  }

  /**
   * The Bitcoin network this manager operates on. Exposed so callers that
   * derive `did:btco` identifiers (which are network-scoped) can produce the
   * correct network prefix rather than assuming mainnet.
   */
  get network(): OriginalsConfig['network'] {
    return this.config.network;
  }

  /**
   * The configured ordinals provider, if any. Exposed so verification paths
   * (e.g. CEL bitcoin witness proof checks) can query the chain through the
   * same provider that made the inscriptions.
   */
  get ordinalsProvider(): OrdinalsProvider | undefined {
    return this.ord;
  }

  private async resolveFeeRate(targetBlocks = 1, provided?: number): Promise<number | undefined> {
    // 1) An explicitly provided fee rate always wins: estimators must not
    // silently override what the caller asked to pay.
    if (typeof provided === 'number' && Number.isFinite(provided) && provided > 0) {
      return provided;
    }

    // 2) Prefer external fee oracle
    if (this.feeOracle) {
      try {
        const estimated = await this.feeOracle.estimateFeeRate(targetBlocks);
        if (typeof estimated === 'number' && Number.isFinite(estimated) && estimated > 0) {
          if (estimated > MAX_REASONABLE_FEE_RATE) {
            // Do not silently use an absurd estimate; skip this source.
            emitTelemetry(this.config.telemetry, {
              name: 'bitcoin.fee.error',
              level: 'warn',
              attributes: { error: `Estimated fee rate ${estimated} exceeds maximum ${MAX_REASONABLE_FEE_RATE} sat/vB`, source: 'feeOracle' }
            });
          } else {
            emitTelemetry(this.config.telemetry, {
              name: 'bitcoin.fee.estimated',
              attributes: { feeRate: estimated, source: 'feeOracle' }
            });
            return estimated;
          }
        }
      } catch (error) {
        emitTelemetry(this.config.telemetry, {
          name: 'bitcoin.fee.error',
          level: 'warn',
          attributes: { error: String(error), source: 'feeOracle' }
        });
      }
    }

    // 3) Fallback to ordinals provider if present
    if (this.ord) {
      try {
        const estimated = await this.ord.estimateFee(targetBlocks);
        if (typeof estimated === 'number' && Number.isFinite(estimated) && estimated > 0) {
          if (estimated > MAX_REASONABLE_FEE_RATE) {
            emitTelemetry(this.config.telemetry, {
              name: 'bitcoin.fee.error',
              level: 'warn',
              attributes: { error: `Estimated fee rate ${estimated} exceeds maximum ${MAX_REASONABLE_FEE_RATE} sat/vB`, source: 'ordinalsProvider' }
            });
          } else {
            emitTelemetry(this.config.telemetry, {
              name: 'bitcoin.fee.estimated',
              attributes: { feeRate: estimated, source: 'ordinalsProvider' }
            });
            return estimated;
          }
        }
      } catch (error) {
        emitTelemetry(this.config.telemetry, {
          name: 'bitcoin.fee.error',
          level: 'warn',
          attributes: { error: String(error), source: 'ordinalsProvider' }
        });
      }
    }

    return undefined;
  }

  async inscribeData(
    data: any,
    contentType: string,
    feeRate?: number,
    options?: { targetSatoshi?: string }
  ): Promise<OrdinalsInscription> {
    // Input validation
    if (!data) {
      throw new StructuredError('INVALID_INPUT', 'Data to inscribe cannot be null or undefined');
    }
    if (!contentType || typeof contentType !== 'string') {
      throw new StructuredError('INVALID_INPUT', 'Content type must be a non-empty string');
    }
    // Validate contentType is a valid MIME type
    if (!/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/.test(contentType)) {
      throw new StructuredError('INVALID_INPUT', `Invalid MIME type format: ${contentType}`);
    }
    if (feeRate !== undefined && (typeof feeRate !== 'number' || feeRate <= 0 || !Number.isFinite(feeRate))) {
      throw new StructuredError('INVALID_INPUT', 'Fee rate must be a positive number');
    }
    // Security: Reject extremely high fee rates to prevent accidental fund drainage
    if (feeRate !== undefined && feeRate > MAX_REASONABLE_FEE_RATE) {
      throw new StructuredError('INVALID_INPUT', `Fee rate ${feeRate} exceeds maximum reasonable fee rate of ${MAX_REASONABLE_FEE_RATE} sat/vB`);
    }
    
    const effectiveFeeRate = await this.resolveFeeRate(1, feeRate);

    if (!this.ord) {
      throw new StructuredError(
        'ORD_PROVIDER_REQUIRED',
        'Ordinals provider must be configured to inscribe data on Bitcoin. ' +
        'Please provide an ordinalsProvider in your SDK configuration. ' +
        'For testing, use: import { OrdMockProvider } from \'@originals/sdk\';'
      );
    }

    if (typeof this.ord.createInscription !== 'function') {
      throw new StructuredError(
        'ORD_PROVIDER_UNSUPPORTED',
        'Configured ordinals provider does not support inscription creation'
      );
    }

    const creation = typeof data === 'function'
      ? await this.ord.createInscription({
          buildContent: data as (satoshi: string) => Buffer | Promise<Buffer>,
          contentType,
          feeRate: effectiveFeeRate,
          ...(options?.targetSatoshi ? { targetSatoshi: options.targetSatoshi } : {})
        })
      : await this.ord.createInscription({
          data,
          contentType,
          feeRate: effectiveFeeRate,
          ...(options?.targetSatoshi ? { targetSatoshi: options.targetSatoshi } : {})
        });
    const txid = creation.txid ?? creation.revealTxId;
    if (!creation.inscriptionId || !txid) {
      throw new StructuredError(
        'ORD_PROVIDER_INVALID_RESPONSE',
        'Ordinals provider did not return a valid inscription identifier or transaction id'
      );
    }

    let satoshi = creation.satoshi ?? '';
    if (!satoshi) {
      satoshi = (await this.getSatoshiFromInscription(creation.inscriptionId)) ?? '';
    }

    // The satoshi is the identity of a did:btco asset. If it is unknown after
    // both the creation response and the indexer lookup, fail loudly with the
    // inscription details rather than returning an empty satoshi that callers
    // would paper over with a txid/inscription-id (neither is a satoshi and
    // both produce permanently unresolvable DIDs). The inscription itself has
    // already been committed and paid for, so the error carries everything
    // needed to recover it once the indexer catches up. (issue #256)
    if (!satoshi) {
      throw new StructuredError(
        'ORD_SATOSHI_UNKNOWN',
        'Inscription was created but its satoshi could not be determined from the provider or indexer. ' +
        'The inscription exists on-chain; retry resolution later using the inscription id.',
        { inscriptionId: creation.inscriptionId, txid, commitTxId: creation.commitTxId, revealTxId: creation.revealTxId }
      );
    }

    // Validate satoshi before using it
    {
      const validation = validateSatoshiNumber(satoshi);
      if (!validation.valid) {
        throw new StructuredError(
          'INVALID_SATOSHI',
          `Ordinals provider returned invalid satoshi identifier: ${validation.error}`,
          { inscriptionId: creation.inscriptionId, txid }
        );
      }
    }

    // Record the rate that was actually used for the inscription: the
    // resolved effective rate, or whatever the provider reports when no
    // rate could be resolved beforehand.
    const recordedFeeRate: number | undefined = effectiveFeeRate ?? creation.feeRate;

    const inscription: OrdinalsInscription & {
      revealTxId?: string;
      commitTxId?: string;
      feeRate?: number;
    } = {
      satoshi,
      inscriptionId: creation.inscriptionId,
      content: creation.content ?? data,
      contentType: creation.contentType ?? contentType,
      txid,
      vout: typeof creation.vout === 'number' ? creation.vout : 0,
      blockHeight: creation.blockHeight,
      revealTxId: creation.revealTxId,
      commitTxId: creation.commitTxId,
      feeRate: recordedFeeRate
    };

    return inscription;
  }

  async trackInscription(inscriptionId: string): Promise<OrdinalsInscription | null> {
    if (this.ord) {
      const info = await this.ord.getInscriptionById(inscriptionId);
      if (!info) return null;
      return {
        satoshi: info.satoshi ?? '',
        inscriptionId: info.inscriptionId,
        content: info.content,
        contentType: info.contentType,
        txid: info.txid,
        vout: info.vout,
        blockHeight: info.blockHeight
      };
    }
    return null;
  }

  async transferInscription(
    inscription: OrdinalsInscription,
    toAddress: string
  ): Promise<BitcoinTransaction> {
    // Input validation
    if (!inscription || typeof inscription !== 'object') {
      throw new StructuredError('INVALID_INPUT', 'Inscription must be a valid OrdinalsInscription object');
    }
    if (!inscription.inscriptionId || typeof inscription.inscriptionId !== 'string') {
      throw new StructuredError('INVALID_INPUT', 'Inscription must have a valid inscriptionId');
    }
    if (!toAddress || typeof toAddress !== 'string') {
      throw new StructuredError('INVALID_INPUT', 'Destination address must be a non-empty string');
    }
    
    // Validate Bitcoin address format and checksum
    try {
      validateBitcoinAddress(toAddress, this.config.network);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Bitcoin address';
      throw new StructuredError('INVALID_ADDRESS', message);
    }
    
    const effectiveFeeRate = await this.resolveFeeRate(1);

    if (!this.ord) {
      throw new StructuredError(
        'ORD_PROVIDER_REQUIRED',
        'Ordinals provider must be configured to transfer inscriptions on Bitcoin. ' +
        'Please provide an ordinalsProvider in your SDK configuration. ' +
        'For testing, use: import { OrdMockProvider } from \'@originals/sdk\';'
      );
    }

    if (typeof this.ord.transferInscription !== 'function') {
      throw new StructuredError(
        'ORD_PROVIDER_UNSUPPORTED',
        'Configured ordinals provider does not support inscription transfers'
      );
    }

    const response = await this.ord.transferInscription(inscription.inscriptionId, toAddress, {
      feeRate: effectiveFeeRate
    });

    if (!response || !response.txid) {
      throw new StructuredError(
        'ORD_PROVIDER_INVALID_RESPONSE',
        'Ordinals provider did not return a valid transfer transaction'
      );
    }

    // Return ONLY provider-attested data. The provider is the source of truth
    // for the transfer's on-chain effects. Fabricating a `vin` from the
    // caller's (possibly stale) inscription.txid/vout, or a `vout` with a
    // made-up DUST_LIMIT_SATS value, wrote invented transaction data into
    // provenance records downstream. When the provider does not report
    // inputs/outputs they are genuinely unknown here — surface them as empty
    // rather than inventing them. We also do NOT mutate the caller's
    // inscription object (previously `inscription.satoshi = response.satoshi`).
    return {
      txid: response.txid,
      vin: response.vin ?? [],
      vout: response.vout ?? [],
      fee: response.fee,
      blockHeight: response.blockHeight,
      confirmations: response.confirmations
    };
  }

  async preventFrontRunning(satoshi: string): Promise<boolean> {
    if (!satoshi) throw new StructuredError('SATOSHI_REQUIRED', 'Satoshi identifier is required');
    // Naive implementation: check for multiple inscriptions on same satoshi via provider
    if (this.ord) {
      const list = await this.ord.getInscriptionsBySatoshi(satoshi);
      return list.length <= 1;
    }
    return true;
  }

  /**
   * Resolve the inscription id currently recorded on a satoshi, or null if the
   * provider reports none. Used to back a transfer with a real inscription id
   * instead of a fabricated placeholder when no local migration record exists.
   */
  async getInscriptionIdBySatoshi(satoshi: string): Promise<string | null> {
    if (!this.ord) {
      // Distinguish "no provider configured" from "satoshi has no inscription"
      // so callers don't report a misleading INSCRIPTION_NOT_FOUND for what is
      // actually a configuration problem.
      throw new StructuredError(
        'ORD_PROVIDER_REQUIRED',
        'Cannot look up inscriptions by satoshi: no ordinalsProvider is configured.'
      );
    }
    const list = await this.ord.getInscriptionsBySatoshi(satoshi);
    if (list.length === 0) return null;
    // Providers return inscriptions in chronological order; on a reinscribed
    // sat the last entry is the current inscription, which is what a transfer
    // should record in provenance (the genesis id would be stale).
    return list[list.length - 1].inscriptionId;
  }

  async getSatoshiFromInscription(inscriptionId: string): Promise<string | null> {
    if (this.ord) {
      const info = await this.ord.getInscriptionById(inscriptionId);
      const satoshi = info?.satoshi;
      
      // Validate satoshi before returning
      if (satoshi) {
        const validation = validateSatoshiNumber(satoshi);
        if (!validation.valid) {
          // Return null if validation fails (don't return empty or invalid string)
          return null;
        }
        return satoshi;
      }
      return null;
    }
    return null;
  }

  async validateBTCODID(didId: string): Promise<boolean> {
    // Validate that a did:btco DID exists on Bitcoin
    const satoshi = this.extractSatoshiFromBTCODID(didId);
    if (!satoshi) return false;

    // The DID's network prefix must match the configured network: the
    // satoshi lookup below runs against this.config.network's provider, so
    // validating e.g. a did:btco:reg DID against mainnet would report a
    // regtest DID as "existing" whenever the bare number happens to carry a
    // mainnet inscription.
    const prefix = didId.split(':')[2];
    const expectedPrefix =
      this.config.network === 'regtest' ? 'reg'
        : this.config.network === 'signet' ? 'sig'
          : null; // mainnet DIDs have no network prefix (did:btco:<sat>)
    const actualPrefix = prefix === 'reg' || prefix === 'sig' || prefix === 'test' ? prefix : null;
    if (actualPrefix !== expectedPrefix) return false;
    
    // Validate the extracted satoshi number
    const validation = validateSatoshiNumber(satoshi);
    if (!validation.valid) return false;
    
    if (!this.ord) return false;
    const inscriptions = await this.ord.getInscriptionsBySatoshi(satoshi);
    return inscriptions.length > 0;
  }

  private extractSatoshiFromBTCODID(didId: string): string | null {
    // Extract satoshi identifier from did:btco DID
    if (!didId.startsWith('did:btco:')) return null;
    
    const parts = didId.split(':');
    let satoshi: string | null = null;
    
    // Handle different network prefixes:
    // did:btco:123456 (mainnet) - 3 parts
    // did:btco:test:123456, did:btco:sig:123456 or did:btco:reg:123456 - 4 parts
    if (parts.length === 3) {
      satoshi = parts[2];
    } else if (parts.length === 4) {
      // Validate network prefix - only 'test', 'sig' and 'reg' are allowed
      const network = parts[2];
      if (network !== 'test' && network !== 'sig' && network !== 'reg') {
        return null;
      }
      satoshi = parts[3];
    }
    
    // Validate the extracted satoshi format
    if (satoshi) {
      const validation = validateSatoshiNumber(satoshi);
      if (!validation.valid) {
        return null;
      }
    }
    
    return satoshi;
  }
}


