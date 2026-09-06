/**
 * What to tell a creator whose deposit is sitting in the mempool underpriced.
 *
 * The app CANNOT fix this itself. Replace-by-fee means re-signing the original
 * inputs, and those belong to whatever wallet the creator sent from — not to
 * their Turnkey wallet. Only the sending wallet can replace that transaction.
 * So the honest job here is to notice, say so, and say what would work.
 *
 * Pure, because the arithmetic is the part worth testing: a naive bump is
 * REJECTED by the network for a reason almost nobody expects (see below).
 */

export type DepositFeeAdvice =
  /** At or above what the network is clearing — nothing to say. */
  | { kind: 'fine' }
  /**
   * Underpriced, and the sender did not signal RBF, so it cannot be replaced
   * at all. Waiting is the only option and pretending otherwise wastes their
   * time in a wallet that will refuse.
   */
  | { kind: 'slow'; feeRateSatVb: number; networkSatVb: number }
  /** Underpriced and replaceable — the case where advice is actionable. */
  | {
      kind: 'bumpable';
      feeRateSatVb: number;
      networkSatVb: number;
      /**
       * A LOWER BOUND on the fee a replacement must pay to be relayed, and
       * only exact when the replacement is the same size as the original.
       * BIP-125 rule 4 charges for the REPLACEMENT's bandwidth, so a wallet
       * that adds an input to cover the higher fee owes more than this. That
       * is why `suggestSatVb` is the number the copy leads with: a rate scales
       * with whatever size the wallet actually builds, an absolute fee does
       * not.
       */
      minReplacementFeeSats: number;
      /** The rate to aim for: relayable AND likely to clear. */
      suggestSatVb: number;
    };

/**
 * BIP-125 rule 4: a replacement must pay for its own bandwidth on top of the
 * original fee, at the minimum relay rate (1 sat/vB). So the floor is not
 * "slightly more than before" — it is `originalFee + vsize`, which for a
 * typical 164 vB payment roughly TRIPLES a 1 sat/vB fee before the network
 * will even accept the replacement.
 *
 * This is the trap: a wallet nudged from 1.0 to 1.2 sat/vB looks like a bump
 * and is rejected, and the creator concludes fee bumping is broken.
 */
const MIN_RELAY_SAT_VB = 1;

export function depositFeeAdvice(tx: {
  feeSats: number;
  vsize: number;
  rbf: boolean;
  networkSatVb: number;
}): DepositFeeAdvice {
  const feeRateSatVb = tx.vsize > 0 ? tx.feeSats / tx.vsize : 0;
  // Round to the same precision we display, so we never warn about a
  // difference the creator cannot see on screen.
  const shown = Math.round(feeRateSatVb * 100) / 100;
  if (shown >= tx.networkSatVb) return { kind: 'fine' };
  if (!tx.rbf) return { kind: 'slow', feeRateSatVb: shown, networkSatVb: tx.networkSatVb };

  const minReplacementFeeSats = tx.feeSats + Math.ceil(tx.vsize * MIN_RELAY_SAT_VB);
  const minRelayableRate = minReplacementFeeSats / tx.vsize;
  return {
    kind: 'bumpable',
    feeRateSatVb: shown,
    networkSatVb: tx.networkSatVb,
    minReplacementFeeSats,
    // Whichever is higher: the rate that clears, or the rate that is merely
    // legal to broadcast. Suggesting the lower of the two is how you send
    // someone to make a bump that fails.
    suggestSatVb: Math.ceil(Math.max(tx.networkSatVb, minRelayableRate)),
  };
}
