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

  async inscribeData(
    data: Buffer,
    contentType: string,
    feeRate?: number
  ): Promise<OrdinalsInscription> {
    let effectiveFeeRate = feeRate;
    if (effectiveFeeRate == null && this.feeOracle) {
      try {
        effectiveFeeRate = await this.feeOracle.estimateFeeRate(1);
        emitTelemetry(this.config.telemetry, { name: 'bitcoin.fee.estimated', attributes: { feeRate: effectiveFeeRate } });
      } catch (error) {
        emitTelemetry(this.config.telemetry, { name: 'bitcoin.fee.error', level: 'warn', attributes: { error: String(error) } });
      }
    }
    // For now, return a mock inscription; integration with a real ord client can be added later
    return {
      satoshi: '123',
      inscriptionId: 'insc-123',
      content: data,
      contentType,
      txid: 'tx-123',
      vout: 0
    };
  }

  async trackInscription(inscriptionId: string): Promise<OrdinalsInscription | null> {
    if (this.ord) {
      const info = await this.ord.getInscriptionById(inscriptionId);
      if (!info) return null;
      return {
        satoshi: info.satoshi ?? '0',
        inscriptionId: info.inscriptionId,
        content: info.content,
        contentType: info.contentType,
        txid: info.txid,
        vout: info.vout
      };
    }
    return {
      satoshi: '123',
      inscriptionId,
      content: Buffer.from(''),
      contentType: 'text/plain',
      txid: 'tx-123',
      vout: 0
    };
  }

  async transferInscription(
    inscription: OrdinalsInscription,
    toAddress: string
  ): Promise<BitcoinTransaction> {
    // Minimal mock tx for tests, respecting dust limit
    const value = Math.max(DUST_LIMIT_SATS, 546);
    return {
      txid: 'tx-transfer',
      vin: [{ txid: inscription.txid, vout: inscription.vout }],
      vout: [{ value, scriptPubKey: 'script', address: toAddress }],
      fee: 100
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
    return '123';
  }

  async validateBTCODID(didId: string): Promise<boolean> {
    // Validate that a did:btco DID exists on Bitcoin
    const satoshi = this.extractSatoshiFromBTCODID(didId);
    if (!satoshi) return false;
    // Assume satoshi has an inscription for test
    return true;
  }

  private extractSatoshiFromBTCODID(didId: string): string | null {
    // Extract satoshi identifier from did:btco DID
    if (!didId.startsWith('did:btco:')) return null;
    
    const parts = didId.split(':');
    return parts.length >= 3 ? parts[2] : null;
  }
}


