export interface StoragePutOptions {
  contentType?: string;
  cacheControl?: string;
}

export interface StorageGetResult {
  content: Buffer;
  contentType: string;
}

export interface StorageAdapter {
  put(objectKey: string, data: Buffer | string, options?: StoragePutOptions): Promise<string>;
  get(objectKey: string): Promise<StorageGetResult | null>;
  delete?(objectKey: string): Promise<boolean>;
}

export interface FeeOracleAdapter {
  // Returns sats/vB (or feerate unit appropriate to the network) for the given target blocks
  estimateFeeRate(targetBlocks?: number): Promise<number>;
}

export interface OrdinalsProvider {
  getInscriptionById(id: string): Promise<{
    inscriptionId: string;
    content: Buffer;
    contentType: string;
    txid: string;
    vout: number;
    satoshi?: string;
    blockHeight?: number;
  } | null>;
  getInscriptionsBySatoshi(satoshi: string): Promise<Array<{ inscriptionId: string }>>;
  broadcastTransaction(txHexOrObj: unknown): Promise<string>;
  getTransactionStatus(txid: string): Promise<{ confirmed: boolean; blockHeight?: number; confirmations?: number }>;
  estimateFee(blocks?: number): Promise<number>;
}

