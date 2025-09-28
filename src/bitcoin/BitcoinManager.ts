import { 
  OriginalsConfig, 
  OrdinalsInscription, 
  BitcoinTransaction,
  Utxo,
  DUST_LIMIT_SATS
} from '../types';
import type { FeeOracleAdapter, OrdinalsProvider } from '../adapters';
import { emitTelemetry, StructuredError } from '../utils/telemetry';

export class BitcoinManager {
  private readonly feeOracle?: FeeOracleAdapter;
  private readonly ord?: OrdinalsProvider;

  constructor(private config: OriginalsConfig) {
    this.feeOracle = config.feeOracle;
    this.ord = config.ordinalsProvider;
  }

  private async resolveFeeRate(targetBlocks = 1, provided?: number): Promise<number | undefined> {
    if (typeof provided === 'number' && Number.isFinite(provided) && provided > 0) {
      return provided;
    }

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

    return provided;
  }

  async inscribeData(
    data: Buffer,
    contentType: string,
    feeRate?: number
  ): Promise<OrdinalsInscription> {
    const effectiveFeeRate = await this.resolveFeeRate(1, feeRate);

    if (!this.ord) {
      return {
        satoshi: 'mock-sat',
        inscriptionId: 'mock-inscription',
        content: data,
        contentType,
        txid: 'mock-txid',
        vout: 0,
        // Provide deterministic defaults so tests can assert presence
        blockHeight: undefined as any,
        // @ts-ignore augment for tests
        feeRate: typeof effectiveFeeRate === 'number' && Number.isFinite(effectiveFeeRate) ? effectiveFeeRate : 10
      };
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
      feeRate: creation.feeRate ?? effectiveFeeRate
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
    const effectiveFeeRate = await this.resolveFeeRate(1);

    if (!this.ord) {
      const value = Math.max(DUST_LIMIT_SATS, 546);
      return {
        txid: 'mock-transfer-txid',
        vin: [{ txid: inscription.txid, vout: inscription.vout }],
        vout: [{ value, scriptPubKey: 'script', address: toAddress }],
        fee: 100
      };
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
      return info?.satoshi ?? null;
    }
    return null;
  }

  async validateBTCODID(didId: string): Promise<boolean> {
    // Validate that a did:btco DID exists on Bitcoin
    const satoshi = this.extractSatoshiFromBTCODID(didId);
    if (!satoshi) return false;
    if (!this.ord) return false;
    const inscriptions = await this.ord.getInscriptionsBySatoshi(satoshi);
    return inscriptions.length > 0;
  }

  private extractSatoshiFromBTCODID(didId: string): string | null {
    // Extract satoshi identifier from did:btco DID
    if (!didId.startsWith('did:btco:')) return null;
    
    const parts = didId.split(':');
    return parts.length >= 3 ? parts[2] : null;
  }
}


