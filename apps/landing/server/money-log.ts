/**
 * Structured money-path logging (R29) — the ONLY instrument the "deploy and
 * watch" posture has.
 *
 * Every state transition where a stranger's real BTC changes hands or gets
 * stuck emits one machine-readable line: an address issued, a deposit seen, a
 * shortfall, an inscribe attempt, an inscribe failure, and the periodic count
 * of bound deposit addresses still holding an unspent confirmed balance. That
 * last one is the only thing that would ever tell the operator a stranger's
 * funds are stranded.
 *
 * Identity is the Turnkey sub-org id, NEVER an email. These lines link an
 * authenticated account to on-chain activity and land in a third-party log
 * sink, so the identifier is part of the contract (and is disclosed in the
 * privacy copy). The formatter enforces it rather than trusting call sites:
 * an `email`-ish key or an email-shaped value is redacted on the way out.
 */

export type MoneyEvent =
  /** A deposit address was bound to an account for the first time. */
  | 'deposit_address_issued'
  /** First confirmed balance seen at a bound address since it last read zero. */
  | 'deposit_seen'
  /** Confirmed balance changed and still does not cover the quoted cost. */
  | 'deposit_shortfall'
  /** The read behind a deposit address could not be trusted. */
  | 'deposit_read_failed'
  /** Per-candidate ordinal classification was unavailable — selection refused. */
  | 'deposit_ordinal_check_unavailable'
  | 'deposit_ordinal_check_partial'
  /** A signed commit+reveal pair passed validation and is about to broadcast. */
  | 'inscribe_attempted'
  /** A submitted pair was refused or failed to broadcast, with the reason. */
  | 'inscribe_failed'
  /** A pair reached the network. */
  | 'inscribe_broadcast'
  /** Periodic per-address finding: a bound address still holds confirmed sats. */
  | 'deposit_balance_held'
  /** Periodic roll-up of the balance sweep, including the count that matters. */
  | 'deposit_balance_sweep';

export type MoneyFields = Record<string, string | number | boolean | undefined>;

/** Where a money line goes. Injected so tests can read what was emitted. */
export type MoneySink = (line: string) => void;

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const EMAILISH_KEY = /(^|_)e?mail(_|$)/i;

/**
 * Redact anything that could carry an email. Both halves matter: a key named
 * `email` is an obvious leak, but so is a sub-org id field that a future
 * caller fills with a login handle.
 */
function safeValue(key: string, value: unknown): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (EMAILISH_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string' && EMAIL_RE.test(value)) return '[redacted]';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

/**
 * One line, JSON after a grep-able prefix: the sink is a third-party log
 * aggregator, and `[landing][money]` is what an operator filters on when a
 * user says their BTC never moved.
 */
export function formatMoneyLog(event: MoneyEvent, fields: MoneyFields = {}, at = new Date()): string {
  const payload: Record<string, string | number | boolean> = { event, at: at.toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    const safe = safeValue(k, v);
    if (safe !== undefined) payload[k] = safe;
  }
  return `[landing][money] ${JSON.stringify(payload)}`;
}

/** The default sink: stdout, so the platform's log drain picks it up. */
export const consoleMoneySink: MoneySink = (line) => console.log(line);

export function createMoneyLogger(sink: MoneySink = consoleMoneySink, now: () => number = () => Date.now()) {
  return (event: MoneyEvent, fields: MoneyFields = {}): void => {
    try {
      sink(formatMoneyLog(event, fields, new Date(now())));
    } catch {
      // Logging must never be able to fail a money-path request.
    }
  };
}

export type MoneyLogger = ReturnType<typeof createMoneyLogger>;
