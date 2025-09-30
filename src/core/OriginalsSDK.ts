import { DIDManager } from '../did/DIDManager';
import { CredentialManager } from '../vc/CredentialManager';
import { LifecycleManager } from '../lifecycle/LifecycleManager';
import { BitcoinManager } from '../bitcoin/BitcoinManager';
import { OriginalsConfig, KeyStore } from '../types';
import { emitTelemetry } from '../utils/telemetry';

export interface OriginalsSDKOptions extends Partial<OriginalsConfig> {
  keyStore?: KeyStore;
}

export class OriginalsSDK {
  public readonly did: DIDManager;
  public readonly credentials: CredentialManager;
  public readonly lifecycle: LifecycleManager;
  public readonly bitcoin: BitcoinManager;

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
    
    emitTelemetry(config.telemetry, { name: 'sdk.init', attributes: { network: config.network } });
    this.did = new DIDManager(config);
    this.credentials = new CredentialManager(config, this.did);
    this.lifecycle = new LifecycleManager(config, this.did, this.credentials, undefined, keyStore);
    this.bitcoin = new BitcoinManager(config);
  }

  static create(options?: OriginalsSDKOptions): OriginalsSDK {
    const { keyStore, ...configOptions } = options || {};
    const defaultConfig: OriginalsConfig = {
      network: 'mainnet',
      defaultKeyType: 'ES256K',
      enableLogging: false
    };
    return new OriginalsSDK({ ...defaultConfig, ...configOptions }, keyStore);
  }
}


