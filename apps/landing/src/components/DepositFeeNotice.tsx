import { demo } from '../content';
import { depositFeeAdvice } from '../sdk/deposit-fee-advice';

/**
 * Tells a creator their pending deposit is underpriced, and what would fix it.
 *
 * Deliberately NOT a button. The app cannot replace that transaction: RBF
 * re-signs the original inputs, and those belong to whatever wallet the
 * creator paid from, not to their Turnkey wallet. Offering an action we cannot
 * perform is the same defect as telling someone to sign in again when signing
 * in is what failed — so this states the numbers and points at the wallet that
 * can actually do it.
 */
export function DepositFeeNotice({
  pending,
}: {
  pending: { feeSats: number; vsize: number; rbf: boolean; networkSatVb: number };
}) {
  const advice = depositFeeAdvice(pending);
  if (advice.kind === 'fine') return null;

  return (
    <div className="deposit-fee-notice">
      <strong className="deposit-fee-heading">{demo.deposit.feeLowHeading}</strong>
      <p className="deposit-fee-body">{demo.deposit.feeLowBody}</p>

      <dl className="deposit-fee-rates">
        <div>
          <dt>{demo.deposit.feeLowYours}</dt>
          <dd>{advice.feeRateSatVb} sat/vB</dd>
        </div>
        <div>
          <dt>{demo.deposit.feeLowNetwork}</dt>
          <dd>{advice.networkSatVb} sat/vB</dd>
        </div>
        {advice.kind === 'bumpable' && (
          <div className="deposit-fee-suggest">
            <dt>{demo.deposit.feeLowSuggest}</dt>
            <dd>{advice.suggestSatVb} sat/vB</dd>
          </div>
        )}
      </dl>

      {advice.kind === 'bumpable' ? (
        <>
          <p className="deposit-fee-body">{demo.deposit.feeLowBumpable}</p>
          <p className="deposit-fee-min">
            {demo.deposit.feeLowMinimum}:{' '}
            <code>{advice.minReplacementFeeSats.toLocaleString()} sats</code>
          </p>
        </>
      ) : (
        <p className="deposit-fee-body">{demo.deposit.feeLowUnbumpable}</p>
      )}
    </div>
  );
}
