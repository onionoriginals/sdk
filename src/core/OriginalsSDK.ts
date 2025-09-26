import { DIDManager } from '../did/DIDManager';
import { CredentialManager } from '../vc/CredentialManager';
import { LifecycleManager } from '../lifecycle/LifecycleManager';
import { BitcoinManager } from '../bitcoin/BitcoinManager';
import { OriginalsConfig } from '../types';

export class OriginalsSDK {
  public readonly did: DIDManager;
  public readonly credentials: CredentialManager;
  public readonly lifecycle: LifecycleManager;
  public readonly bitcoin: BitcoinManager;

  constructor(config: OriginalsConfig) {
    this.did = new DIDManager(config);
    this.credentials = new CredentialManager(config, this.did);
    this.lifecycle = new LifecycleManager(config, this.did, this.credentials);
    this.bitcoin = new BitcoinManager(config);
  }

  static create(config?: Partial<OriginalsConfig>): OriginalsSDK {
    const defaultConfig: OriginalsConfig = {
      network: 'mainnet',
      defaultKeyType: 'ES256K',
      enableLogging: false
    };
    return new OriginalsSDK({ ...defaultConfig, ...config });
  }
}


