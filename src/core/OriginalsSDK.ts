import { DIDManager } from '../did/DIDManager';
import { CredentialManager } from '../vc/CredentialManager';
import { LifecycleManager } from '../lifecycle/LifecycleManager';
import { BitcoinManager } from '../bitcoin/BitcoinManager';
import { OriginalsConfig, KeyStore } from '../types';
import { emitTelemetry, StructuredError } from '../utils/telemetry';

export interface OriginalsSDKOptions extends Partial<OriginalsConfig> {
  keyStore?: KeyStore;
}

export class OriginalsSDK {
  public readonly did: DIDManager;
  public readonly credentials: CredentialManager;
  public readonly lifecycle: LifecycleManager;
  public readonly bitcoin: BitcoinManager;
  private config: OriginalsConfig;

  constructor(config: OriginalsConfig, keyStore?: KeyStore) {
    // Input validation
    if (!config || typeof config !== 'object') {
      throw new Error('Configuration object is required');
    }
    if (!config.network || !['mainnet', 'testnet', 'regtest', 'signet'].includes(config.network)) {
      throw new Error('Invalid network: must be mainnet, testnet, regtest, or signet');
    }
    if (!config.defaultKeyType || !['ES256K', 'Ed25519', 'ES256'].includes(config.defaultKeyType)) {
      throw new Error('Invalid defaultKeyType: must be ES256K, Ed25519, or ES256');
    }
    
    this.config = config;
    emitTelemetry(config.telemetry, { name: 'sdk.init', attributes: { network: config.network } });
    this.did = new DIDManager(config);
    this.credentials = new CredentialManager(config, this.did);
    this.lifecycle = new LifecycleManager(config, this.did, this.credentials, undefined, keyStore);
    this.bitcoin = new BitcoinManager(config);
  }


  /**
   * Validates that the SDK is properly configured for Bitcoin operations.
   * Throws a StructuredError if ordinalsProvider is not configured.
   * 
   * @throws {StructuredError} When ordinalsProvider is not configured
   */
  validateBitcoinConfig(): void {
    if (!this.config.ordinalsProvider) {
      throw new StructuredError(
        'ORD_PROVIDER_REQUIRED',
        'Bitcoin operations require an ordinalsProvider to be configured. ' +
        'Please provide an ordinalsProvider when creating the SDK. ' +
        'See README.md for configuration examples.'
      );
    }
  }

  static create(config?: Partial<OriginalsConfig>): OriginalsSDK {
    const { keyStore, ...configOptions } = options || {};
    const defaultConfig: OriginalsConfig = {
      network: 'mainnet',
      defaultKeyType: 'ES256K',
      enableLogging: false
    };
    return new OriginalsSDK({ ...defaultConfig, ...configOptions }, keyStore);
  }
}


