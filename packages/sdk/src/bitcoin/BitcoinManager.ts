import {
  OriginalsConfig,
  OrdinalsInscription,
  BitcoinTransaction,
  DUST_LIMIT_SATS
} from '../types/index.js';
import type { FeeOracleAdapter, OrdinalsProvider } from '../adapters/index.js';
import { emitTelemetry, StructuredError } from '../utils/telemetry.js';
import { validateBitcoinAddress } from '../utils/bitcoin-address.js';
import { validateSatoshiNumber } from '../utils/satoshi-validation.js';
import { scriptPubKeyForAddress } from './transfer.js';

/**
 * Upper bound on any fee rate the SDK will use, whether caller-provided or
 * returned by a fee oracle / ordinals provider. Guards against a misbehaving or
 * compromised estimator draining funds via an absurd sat/vB value.
 */
const MAX_REASONABLE_FEE_RATE = 10_000; // sat/vB

export class BitcoinManager {
  private readonly feeOracle?: FeeOracleAdapter;
  private readonly ord?: OrdinalsProvider;

  constructor(private config: OriginalsConfig) {
    this.feeOracle = config.feeOracle;
    this.ord = config.ordinalsProvider;
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
    feeRate?: number
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

    const creation = await this.ord.createInscription({ data, contentType, feeRate: effectiveFeeRate });
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

    // Validate satoshi before using it
    if (satoshi) {
      const validation = validateSatoshiNumber(satoshi);
      if (!validation.valid) {
        throw new StructuredError(
          'INVALID_SATOSHI',
          `Ordinals provider returned invalid satoshi identifier: ${validation.error}`
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

    if (response.satoshi) {
      inscription.satoshi = response.satoshi;
    }

    return {
      txid: response.txid,
      vin: response.vin ?? [{ txid: inscription.txid, vout: inscription.vout }],
      vout:
        response.vout?.length
          ? response.vout
          : [{
              value: DUST_LIMIT_SATS,
              // Derive a valid hex-encoded scriptPubKey from the (already
              // validated) destination address so the fallback output can be
              // correctly referenced by downstream transaction construction.
              scriptPubKey: scriptPubKeyForAddress(toAddress, this.config.network),
              address: toAddress
            }],
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


