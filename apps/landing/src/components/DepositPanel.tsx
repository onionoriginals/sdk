import { useState } from 'react';
import { demo } from '../content';
import { bitcoinPaymentUri } from '../sdk/bitcoin-uri';
import { DepositQr } from './DepositQr';
import './deposit.css';

/**
 * The fund-your-inscription action.
 *
 * Ordering is the whole design. Previously the amount was stated, then five
 * paragraphs of disclosure, then — finally — the address. Someone who has
 * decided to pay had to read ~250 words of terms to reach the string they
 * needed, which is how a person ends up scrolling past the terms rather than
 * reading them.
 *
 * So: pay first, in one block — amount, address, copy, scan. Then the
 * substance of the two money risks, unmissable and requiring no interaction.
 * Then the full R27 text, complete and unedited, in a <details> on the same
 * screen. Nothing was deleted and nothing moved off the page; what changed is
 * that the disclosure no longer stands between a person and the thing they
 * came here to do.
 */
export function DepositPanel({
  address,
  sats,
  pendingSats = 0,
  pendingHref,
  shortfall,
  balanceSats = 0,
  funded = false,
}: {
  address: string;
  sats: number;
  /** Sats seen at the address but not yet confirmed. */
  pendingSats?: number;
  /**
   * Where to look the payment up. Resolved by the caller and null when we have
   * no explorer for this network — passing a function that could return '' put
   * an empty href on screen, which looks like a link and goes nowhere.
   */
  pendingHref?: string | null;
  /**
   * A CONFIRMED deposit that does not cover the cost. Shown here rather than
   * only when the inscribe button is pressed: the number a creator needs is
   * the number they need BEFORE they go back to their wallet, not after.
   */
  shortfall?: { heldSats: number; shortfallSats: number } | null;
  /** Everything confirmed at the address — what the creator actually holds. */
  balanceSats?: number;
  /** That balance covers the cost, so nothing needs sending. */
  funded?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const uri = bitcoinPaymentUri(address, sats);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard can be unavailable (permissions, insecure origin) — the
      // address stays selectable, and the QR is a second way through.
    }
  };

  // The address, QR and copy button. Front and centre while funding is needed;
  // tucked into a disclosure once it is not, because a funded creator's next
  // move is to inscribe, not to send more money.
  const payBlock = (
      <div className="deposit-pay">
        <div className="deposit-pay-main">
          <span className="deposit-address-label">{demo.deposit.addressLabel}</span>
          {/* Broken into a <code> that wraps on character boundaries: a bech32
              address that overflows its box is one a person cannot read back
              to check, which is exactly when they mistrust the screen. */}
          <code className="deposit-address">{address}</code>
          <div className="deposit-actions">
            <button
              type="button"
              className="deposit-copy"
              onClick={() => void copy()}
              aria-label={demo.deposit.copyAddressAria}
              data-copied={copied || undefined}
            >
              {copied ? demo.deposit.copiedAddress : demo.deposit.copyAddress}
            </button>
            <a className="deposit-wallet" href={uri}>
              {demo.deposit.openInWallet}
            </a>
          </div>
          <p className="deposit-hint">{demo.deposit.openInWalletHint}</p>
        </div>

        <div className="deposit-scan">
          <DepositQr value={uri} />
          <p className="deposit-hint deposit-hint-center">{demo.deposit.scanHint}</p>
        </div>
      </div>
  );

  return (
    <div className="deposit">
      {funded ? (
        <>
          <div className="deposit-funded" role="status">
            <strong className="deposit-funded-heading">{demo.deposit.fundedHeading}</strong>
            <p className="deposit-funded-body">{demo.deposit.fundedBody}</p>
          </div>
          <dl className="deposit-balance">
            <div>
              <dt>{demo.deposit.balanceLabel}</dt>
              <dd>{balanceSats.toLocaleString()} sats</dd>
            </div>
            <div>
              <dt>{demo.deposit.balanceNeeded}</dt>
              <dd>{sats.toLocaleString()} sats</dd>
            </div>
          </dl>
          <p className="deposit-purpose">{demo.deposit.balanceReuse}</p>
          <details className="deposit-details">
            <summary>{demo.deposit.addMoreSummary}</summary>
            <div className="deposit-details-body">{payBlock}</div>
          </details>
        </>
      ) : (
        <>
          <div className="deposit-amount">
            <span className="deposit-amount-label">{demo.deposit.sendPrefix}</span>
            <strong className="deposit-amount-value">{sats.toLocaleString()}</strong>
            <span className="deposit-amount-unit">sats</span>
          </div>
          {balanceSats > 0 && (
            <p className="deposit-hint deposit-balance-line">
              {demo.deposit.balanceLabel}: <strong>{balanceSats.toLocaleString()} sats</strong>
            </p>
          )}
          {payBlock}
        </>
      )}

      {shortfall && (
        <p className="deposit-short" role="status">
          <strong>{shortfall.heldSats.toLocaleString()} sats</strong> confirmed.{' '}
          {demo.deposit.shortTopUpPrefix}{' '}
          <strong>{shortfall.shortfallSats.toLocaleString()} sats</strong>{' '}
          {demo.deposit.shortTopUpSuffix}
        </p>
      )}

      {/* The gap this closes: between sending and confirming, nothing on
          screen told a creator we could see their money. The badge said
          "detected", which is easy to miss and does not name an amount. */}
      {pendingSats > 0 && (
        <p className="deposit-pending" role="status">
          <span className="deposit-pending-dot" aria-hidden="true" />
          <strong>{pendingSats.toLocaleString()} sats</strong>{' '}
          {demo.deposit.pendingSeenSuffix}
          {pendingHref && (
            <>
              {' '}
              <a href={pendingHref} target="_blank" rel="noreferrer">
                {demo.deposit.pendingViewLink}
              </a>
            </>
          )}
        </p>
      )}

      <p className="deposit-purpose">{demo.deposit.purposeShort}</p>

      {/* Not a <details>: the two money risks are the one thing that must not
          need a click. */}
      <p className="deposit-risk" role="note">{demo.deposit.riskSummary}</p>

      <details className="deposit-details">
        <summary>{demo.deposit.detailsSummary}</summary>
        <div className="deposit-details-body">
          <p>{demo.deposit.purpose}</p>
          <p>{demo.deposit.addressOrigin}</p>
          <p>{demo.deposit.unspentBalance}</p>
          <p>{demo.deposit.nonRefundable}</p>
          <p>{demo.deposit.ifSomethingGoesWrong}</p>
        </div>
      </details>
    </div>
  );
}
