/**
 * Deferred inscription build result (#407 phase 2): either bare content bytes,
 * or content plus the CBOR metadata to attach.
 */
export type InscriptionParts = Uint8Array | { content: Uint8Array; metadata?: Record<string, unknown> };

export interface StoragePutOptions {
  contentType?: string;
  cacheControl?: string;
}

export interface StorageGetResult {
  content: Uint8Array;
  contentType: string;
}

export interface StorageAdapter {
  put(objectKey: string, data: Uint8Array | string, options?: StoragePutOptions): Promise<string>;
  get(objectKey: string): Promise<StorageGetResult | null>;
  delete?(objectKey: string): Promise<boolean>;
}

export interface FeeOracleAdapter {
  // Returns sats/vB (or feerate unit appropriate to the network) for the given target blocks
  estimateFeeRate(targetBlocks?: number): Promise<number>;
}

export interface OrdinalsProvider {
  /** Complete, stable observation of one sat; omission means the provider cannot supply one. */
  getSatSnapshot?(satoshi: string, options?: import('./providers/sat-snapshot.js').SatSnapshotOptions): Promise<import('../bitcoin/sat-snapshot-types.js').SatSnapshot>;
  getInscriptionById(id: string): Promise<{
    inscriptionId: string;
    // Optional: deferred-content providers may not echo built content back.
    content?: Uint8Array;
    contentType: string;
    txid: string;
    vout: number;
    satoshi?: string;
    blockHeight?: number;
    // Inscription CBOR metadata (#407 phase 2). Absent for content-only inscriptions.
    metadata?: Record<string, unknown>;
  } | null>;
  /**
   * The first (lowest-offset) satoshi contained in the given output, per the
   * provider's sat index. This is the sat an inscription funded by this output
   * lands on (no pointer). Used to derive the did:btco identity BEFORE building
   * the inscription. Providers without a sat index omit it; the sat-selected
   * genesis path then fails closed with SAT_INDEX_UNSUPPORTED.
   */
  getFirstSatOfOutput?(outpoint: { txid: string; vout: number }): Promise<string>;
  /**
   * MUST return inscription ids oldest-first (on-chain inscription order).
   * The verifier's on-chain ordering checks (head freshness, the anchoring
   * walk) depend on this ordering as a same-block tiebreak; a provider
   * violating it can make those checks accept earlier inscriptions.
   */
  getInscriptionsBySatoshi(satoshi: string): Promise<Array<{ inscriptionId: string }>>;
  broadcastTransaction(txHexOrObj: unknown): Promise<string>;
  /**
   * Atomically submit a signed commit + reveal pair for broadcast. Optional:
   * when present, the sat-selected inscribe path (inscribe-on-sat.ts) calls
   * this ONCE instead of two broadcastTransaction calls, so an implementation
   * can persist both signed transactions durably BEFORE anything is broadcast
   * — the stranded-funds fix: if the caller dies between commit and reveal,
   * the reveal can still be rebroadcast from the persisted copy. The
   * implementation must broadcast the commit first, then the reveal, and
   * treat an already-known transaction as success (idempotent).
   *
   * `status` reports how far broadcasting got: 'reveal_broadcast' means both
   * landed; 'commit_broadcast' means the commit is on-chain and the reveal is
   * persisted for later rebroadcast (still a success — the inscription will
   * complete without the caller re-signing anything).
   */
  submitInscription?(params: {
    signedCommitHex: string;
    revealTxHex: string;
    /**
     * Every funding UTXO the commit spends, in input order. `[0]` is the
     * identity input (its first sat is the did:btco sat). An implementation
     * that persists for recovery must claim ALL of these, not just the first:
     * two pairs with overlapping-but-unequal sets both spend the overlap.
     */
    fundingUtxos: Array<{ txid: string; vout: number; value: number; scriptPubKey?: string }>;
    /**
     * Singular mirror of `fundingUtxos[0]`, for pre-multi-input implementations.
     * Stays REQUIRED: relaxing a method parameter's property to optional is a
     * source-breaking change for any external `implements OrdinalsProvider`
     * (`Property 'fundingUtxo' is optional in ... but required in ...`), which
     * method bivariance does not forgive. The SDK always populates it.
     */
    fundingUtxo: { txid: string; vout: number; value: number; scriptPubKey?: string };
    changeAddress: string;
  }): Promise<{ commitTxId: string; revealTxId: string; status: 'commit_broadcast' | 'reveal_broadcast' }>;
  /**
   * `blockHash` is the identity of the block the tx last confirmed in, not
   * merely its height: a one-block reorg can replace the block at a given
   * height with a different one, and a consumer comparing heights alone
   * cannot tell that apart from uninterrupted confirmation. Providers that
   * cannot supply it (no block-hash source, or a not-yet-updated
   * implementation) omit it; a consumer should treat that as "identity
   * unknown", not "unchanged".
   *
   * `inMempool`, for an unconfirmed transaction: true when the node holds it
   * in its mempool, false when the node knows it is in neither its mempool
   * nor its active chain (rejected, evicted, never sent, or reorganised out
   * and not readmitted). Omitted when the provider cannot tell; a consumer
   * must then not infer either.
   */
  getTransactionStatus(txid: string): Promise<{ confirmed: boolean; blockHeight?: number; blockHash?: string; confirmations?: number; inMempool?: boolean }>;
  estimateFee(blocks?: number): Promise<number>;
  createInscription(params: {
    /** Static content. Provide exactly one of data / buildContent. */
    data?: Uint8Array;
    /**
     * Deferred content: called with the pinned satoshi between commit and
     * reveal, so content (and metadata) that must embed its own sat (e.g. a
     * did:btco DID document) can be constructed. Provide exactly
     * one of data / buildContent. May return bare bytes (content only) or
     * `{ content, metadata }` — the returned metadata wins over the static
     * `metadata` param below (#407 phase 2).
     */
    buildContent?: (satoshi: string) => InscriptionParts | Promise<InscriptionParts>;
    contentType: string;
    feeRate?: number;
    /**
     * Inscription CBOR metadata (#407 phase 2). Threaded to the `metadata`
     * envelope tag. Ignored when `buildContent` returns its own metadata.
     */
    metadata?: Record<string, unknown>;
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
    content?: Uint8Array;
    contentType?: string;
    feeRate?: number;
    metadata?: Record<string, unknown>;
  }>;
  /**
   * Current ownership of the UTXO carrying this satoshi. Optional: providers
   * without an owner index simply omit it and resolution carries no
   * ownership metadata. Ownership is resolution METADATA — implementations
   * must never rewrite the inscribed DID document from it.
   */
  getSatOwnership?(satoshi: string): Promise<{ address: string; outpoint: string } | null>;
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

/**
 * Compile-time guard: `submitInscription`'s `fundingUtxo` must stay REQUIRED.
 * Making it optional is source-breaking for any external
 * `implements OrdinalsProvider` written against the earlier shape, and nothing
 * in this repo implements the method, so only a consumer's `tsc` would notice.
 * Kept in src/ so `bun run build` fails on the regression.
 */
type _AssertTrue<T extends true> = T;
type _SubmitInscriptionParams = Parameters<NonNullable<OrdinalsProvider['submitInscription']>>[0];
export type _FundingUtxoStaysRequired = _AssertTrue<
  undefined extends _SubmitInscriptionParams['fundingUtxo'] ? false : true
>;

