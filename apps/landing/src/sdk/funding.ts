/**
 * How the browser funds an inscription from a creator's deposits: which
 * confirmed outputs the commit spends, and how big the inscription it must pay
 * for is. Pure, and kept out of Demo.tsx so the inscription dry run
 * (scripts/dry-run-inscription.ts) can drive the SAME selection the page
 * ships rather than a copy of it.
 */

/** A confirmed output at the creator's own deposit address. */
export interface FundingUtxo {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: string;
}

/** What the creator's confirmed deposits can pay for right now. */
export interface FundingSelection {
  /** The inputs the commit will spend, in order. `[0]` carries the did:btco sat. */
  selected: FundingUtxo[];
  /** Their sum. */
  totalSats: number;
  /** How far the WHOLE spendable balance falls short of the target (0 when funded). */
  shortfallSats: number;
}

/**
 * Fund from the confirmed SET, not from one fat UTXO (R26). Picking a single
 * output large enough to cover the whole cost is what left a creator who
 * deposited twice — or topped up after a fee rise — permanently told to
 * deposit more with their coins sitting unspent at their own address.
 *
 * Largest-first, and the SAME order the deposit route walks when it sizes
 * `estimatedCostSats`: that quote is priced for the number of inputs this
 * walk selects, so the two cannot disagree about how many inputs the commit
 * pays for. `selected[0]` is the identity input — its first sat becomes the
 * did:btco sat — and every layer below asserts that pinning (U16).
 *
 * `utxos` must already be the ORDINAL-CHECKED spendable set: summing removed
 * the arithmetic that used to keep a 546-sat inscription output out (postage
 * is always below a single-UTXO threshold, never below a sum), so the guard
 * now lives in the server's per-candidate classification.
 */
export function selectFundingUtxos(utxos: FundingUtxo[], targetSats: number): FundingSelection {
  const largestFirst = [...utxos].sort((a, b) => b.value - a.value);
  const selected: FundingUtxo[] = [];
  let totalSats = 0;
  for (const u of largestFirst) {
    if (totalSats >= targetSats) break;
    selected.push(u);
    totalSats += u.value;
  }
  if (totalSats >= targetSats) return { selected, totalSats, shortfallSats: 0 };
  // Short: select NOTHING. A partial set cannot pay for the inscription, and
  // broadcasting a commit it cannot fund is how a reveal gets stranded.
  return { selected: [], totalSats, shortfallSats: targetSats - totalSats };
}

/**
 * A content-size hint for GET /api/btc/deposit, so the quote is sized for
 * what will actually be inscribed. The reveal carries the media bytes plus
 * CBOR metadata holding the DID document and the WHOLE CEL log — which grows
 * with every event — and the route's 8,000-byte default under-funds past
 * ~12.8 KB, stranding a creator after they have deposited (#493). Counted in
 * UTF-8 bytes, never characters, and biased UP: the excess returns as change.
 */
export function inscriptionContentBytes(asset: {
  resource: { content: string };
  metadata?: { content: string };
  celLog: unknown;
}): number {
  const utf8 = (s: string) => new TextEncoder().encode(s).length;
  // CBOR of the log is no larger than its JSON; the DID document is small and
  // bounded, so a flat allowance covers it.
  const DID_DOCUMENT_ALLOWANCE = 1_024;
  return (
    utf8(asset.resource.content) +
    utf8(asset.metadata?.content ?? '') +
    utf8(JSON.stringify(asset.celLog)) +
    DID_DOCUMENT_ALLOWANCE
  );
}
