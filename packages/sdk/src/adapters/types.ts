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
    // Optional: deferred-content providers may not echo built content back.
    content?: Buffer;
    contentType: string;
    txid: string;
    vout: number;
    satoshi?: string;
    blockHeight?: number;
  } | null>;
  /**
   * MUST return inscription ids oldest-first (on-chain inscription order).
   * The non-cooperative rotation rule's later-than-anchor check depends on
   * this ordering; a provider violating it can make that check accept
   * earlier inscriptions.
   */
  getInscriptionsBySatoshi(satoshi: string): Promise<Array<{ inscriptionId: string }>>;
  broadcastTransaction(txHexOrObj: unknown): Promise<string>;
  getTransactionStatus(txid: string): Promise<{ confirmed: boolean; blockHeight?: number; confirmations?: number }>;
  estimateFee(blocks?: number): Promise<number>;
  createInscription(params: {
    /** Static content. Provide exactly one of data / buildContent. */
    data?: Buffer;
    /**
     * Deferred content: called with the pinned satoshi between commit and
     * reveal, so content that must embed its own sat (a did:btco DID
     * document) can be constructed. Provide exactly one of data / buildContent.
     */
    buildContent?: (satoshi: string) => Buffer | Promise<Buffer>;
    contentType: string;
    feeRate?: number;
    /** Reinscribe on an existing sat (key rotation / DID update). */
    targetSatoshi?: string;
  }): Promise<{
    inscriptionId: string;
    revealTxId: string;
    commitTxId?: string;
    satoshi?: string;
    txid?: string;
    vout?: number;
    blockHeight?: number;
    content?: Buffer;
    contentType?: string;
    feeRate?: number;
  }>;
  /**
   * Current ownership of the UTXO carrying this satoshi. Optional: providers
   * without an owner index simply omit it and resolution carries no
   * ownership metadata. Ownership is resolution METADATA — implementations
   * must never rewrite the inscribed DID document from it.
   */
  getSatOwnership?(satoshi: string): Promise<{ address: string; outpoint: string } | null>;
  /**
   * Enumerate every on-chain btco DID-doc anchoring whose `alsoKnownAs`
   * back-links this did:cel (first-anchor-wins uniqueness). Production
   * providers implement this via a content/metadata index (an `ord` instance
   * or a service such as the QuickNode Ordinals add-on). `blockHeight` is the
   * canonical ordering signal; a missing height fails uniqueness closed.
   */
  getAnchoringsForDidCel?(didCel: string): Promise<Array<{
    satoshi: string;
    inscriptionId: string;
    blockHeight?: number;
  }>>;
  transferInscription(
    inscriptionId: string,
    toAddress: string,
    options?: { feeRate?: number }
  ): Promise<{
    txid: string;
    vin: Array<{ txid: string; vout: number }>;
    vout: Array<{ value: number; scriptPubKey: string; address?: string }>;
    fee: number;
    blockHeight?: number;
    confirmations?: number;
    satoshi?: string;
  }>;
}

