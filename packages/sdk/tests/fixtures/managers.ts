/**
 * Test fixture: the DID, credential, Bitcoin and status-list managers built
 * from one OriginalsConfig, with the defaults the managers' tests rely on
 * (mainnet / ES256K / production, and the webvhNetwork <-> network mapping).
 */
import { DIDManager } from '../../src/did/DIDManager';
import { CredentialManager } from '../../src/vc/CredentialManager';
import { BitcoinManager } from '../../src/bitcoin/BitcoinManager';
import { StatusListManager } from '../../src/vc/StatusListManager';
import { MetricsCollector } from '../../src/utils/MetricsCollector';
import { OperationLock } from '../../src/utils/OperationLock';
import { StructuredError } from '../../src/utils/telemetry';
import type { KeyStore, OriginalsConfig } from '../../src/types';
import { DEFAULT_WEBVH_NETWORK, getBitcoinNetworkForWebVH, getWebVHNetworkForBitcoin } from '../../src/types/network';

export interface ManagerOptions extends Partial<OriginalsConfig> {
  keyStore?: KeyStore;
}

export interface Managers {
  config: OriginalsConfig;
  metrics: MetricsCollector;
  did: DIDManager;
  credentials: CredentialManager;
  bitcoin: BitcoinManager;
  statusList: StatusListManager;
  validateBitcoinConfig(): void;
}

export function createManagers(options: ManagerOptions = {}): Managers {
  const config: OriginalsConfig = {
    network: 'mainnet',
    defaultKeyType: 'ES256K',
    enableLogging: false,
    webvhNetwork: DEFAULT_WEBVH_NETWORK,
    ...options,
  };
  if (options.webvhNetwork && options.network === undefined) {
    config.network = getBitcoinNetworkForWebVH(options.webvhNetwork);
  } else if (options.network && options.webvhNetwork === undefined) {
    const tier = getWebVHNetworkForBitcoin(options.network);
    if (tier) config.webvhNetwork = tier;
  }
  if (!config.operationLock) config.operationLock = new OperationLock();
  const metrics = new MetricsCollector();
  const did = new DIDManager(config, metrics);
  return {
    config,
    metrics,
    did,
    credentials: new CredentialManager(config, did, metrics),
    bitcoin: new BitcoinManager(config),
    statusList: new StatusListManager(),
    validateBitcoinConfig() {
      if (!config.ordinalsProvider) {
        throw new StructuredError('ORD_PROVIDER_REQUIRED', 'Bitcoin operations require an ordinalsProvider to be configured.');
      }
    },
  };
}
