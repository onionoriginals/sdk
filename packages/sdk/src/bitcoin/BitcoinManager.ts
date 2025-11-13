import { 
  OriginalsConfig, 
  OrdinalsInscription, 
  BitcoinTransaction,
  Utxo,
  DUST_LIMIT_SATS
} from '../types';
import type { FeeOracleAdapter, OrdinalsProvider } from '../adapters';
import { emitTelemetry, StructuredError } from '../utils/telemetry';
import { validateBitcoinAddress } from '../utils/bitcoin-address';
import { validateSatoshiNumber, parseSatoshiIdentifier } from '../utils/satoshi-validation';

export class BitcoinManager {
  private readonly feeOracle?: FeeOracleAdapter;
  private readonly ord?: OrdinalsProvider;

  constructor(private config: OriginalsConfig) {
    this.feeOracle = config.feeOracle;
    this.ord = config.ordinalsProvider;
  }

  private async resolveFeeRate(targetBlocks = 1, provided?: number): Promise<number | undefined> {
    // 1) Prefer external fee oracle
    if (this.feeOracle) {
      try {
        const estimated = await this.feeOracle.estimateFeeRate(targetBlocks);
        if (typeof estimated === 'number' && Number.isFinite(estimated) && estimated > 0) {
          emitTelemetry(this.config.telemetry, {
            name: 'bitcoin.fee.estimated',
            attributes: { feeRate: estimated, source: 'feeOracle' }
          });
          return estimated;
        }
      } catch (error) {
        emitTelemetry(this.config.telemetry, {
          name: 'bitcoin.fee.error',
          level: 'warn',
          attributes: { error: String(error), source: 'feeOracle' }
        });
      }
    }

    // 2) Fallback to ordinals provider if present
    if (this.ord) {
      try {
        const estimated = await this.ord.estimateFee(targetBlocks);
        if (typeof estimated === 'number' && Number.isFinite(estimated) && estimated > 0) {
          emitTelemetry(this.config.telemetry, {
            name: 'bitcoin.fee.estimated',
            attributes: { feeRate: estimated, source: 'ordinalsProvider' }
          });
          return estimated;
        }
      } catch (error) {
        emitTelemetry(this.config.telemetry, {
          name: 'bitcoin.fee.error',
          level: 'warn',
          attributes: { error: String(error), source: 'ordinalsProvider' }
        });
      }
    }

    // 3) If caller provided a valid non-zero fee rate, use it as last resort
    if (typeof provided === 'number' && Number.isFinite(provided) && provided > 0) {
      return provided;
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
    const MAX_REASONABLE_FEE_RATE = 10_000; // sat/vB
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

    let recordedFeeRate: number | undefined;
    if (this.feeOracle) {
      recordedFeeRate = effectiveFeeRate;
    } else if (typeof feeRate === 'number' && Number.isFinite(feeRate) && feeRate > 0) {
      recordedFeeRate = feeRate;
    } else {
      recordedFeeRate = creation.feeRate ?? effectiveFeeRate;
    }

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
          : [{ value: DUST_LIMIT_SATS, scriptPubKey: 'script', address: toAddress }],
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
    // did:btco:test:123456 or did:btco:sig:123456 - 4 parts
    if (parts.length === 3) {
      satoshi = parts[2];
    } else if (parts.length === 4) {
      // Validate network prefix - only 'test' and 'sig' are allowed
      const network = parts[2];
      if (network !== 'test' && network !== 'sig') {
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


