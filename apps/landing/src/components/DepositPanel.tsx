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
export function DepositPanel({ address, sats }: { address: string; sats: number }) {
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

  return (
    <div className="deposit">
      <div className="deposit-amount">
        <span className="deposit-amount-label">{demo.deposit.sendPrefix}</span>
        <strong className="deposit-amount-value">{sats.toLocaleString()}</strong>
        <span className="deposit-amount-unit">sats</span>
      </div>

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
