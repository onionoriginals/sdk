export interface TransactionStatus {
  confirmed: boolean;
  confirmations?: number;
}

export interface Broadcaster {
  (txHex: string): Promise<string>; // returns txid
}

export interface StatusProvider {
  (txid: string): Promise<TransactionStatus>;
}

export interface BroadcastOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
}

/**
 * Broadcast client with idempotency and confirmation polling.
 * Designed to be predictable and simple, honoring behavior expected by the
 * ordinalsplus legacy components which are finicky about retries.
 */
export class BroadcastClient {
  private inflight = new Map<string, Promise<string>>();

  constructor(private readonly broadcaster: Broadcaster, private readonly statusProvider: StatusProvider) {}

  broadcastIdempotent(txidKey: string, create: () => Promise<string>): Promise<string> {
    if (this.inflight.has(txidKey)) return this.inflight.get(txidKey)!;
    const p = (async () => create())();
    this.inflight.set(txidKey, p);
    return p.finally(() => this.inflight.delete(txidKey));
  }

  async broadcastAndConfirm(txHex: string, options: BroadcastOptions = {}): Promise<{ txid: string; confirmations: number }>
  {
    const txid = await this.broadcastIdempotent(txHex, () => this.broadcaster(txHex));
    const interval = Math.max(100, options.pollIntervalMs ?? 500);
    const maxAttempts = Math.max(1, options.maxAttempts ?? 20);
    let attempts = 0;
    let last: TransactionStatus = { confirmed: false };
    while (attempts < maxAttempts) {
      // Once the broadcast succeeded, this method must resolve with the txid
      // no matter what the status endpoint does (issue #271). A transient
      // status failure that rejected here made callers treat the whole
      // operation as failed and rebuild/rebroadcast a second commit tx over
      // the same UTXOs — a double-spend race that can strand funds at a
      // commit address whose reveal key was discarded. Count a throwing poll
      // as an unconfirmed attempt instead.
      try {
        last = await this.statusProvider(txid);
        if (last.confirmed) {
          return { txid, confirmations: last.confirmations ?? 1 };
        }
      } catch {
        // Transient status-provider failure: treat as "not yet confirmed".
      }
      await new Promise(r => setTimeout(r, interval));
      attempts++;
    }
    return { txid, confirmations: last.confirmations ?? 0 };
  }
}

