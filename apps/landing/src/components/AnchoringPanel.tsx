/**
 * The anchoring panel (plan 011, PR 10b; behind bitcoinAnchoring). Before
 * signing it says what is terminal, which key signs what, and what Bitcoin
 * will not hold (P9.10, P9.12, P9.18). After, it shows the publication label,
 * the next step, the sat's holder and the index trust as separate lines; the
 * wording comes from anchoring-view.ts.
 */
import { demo } from '../content';
import type { DemoAssetState } from '../sdk/engine';
import { anchoringView, offChainPreview } from './anchoring-view';

export function AnchoringBeforeSign({ asset }: { asset: DemoAssetState }) {
  const copy = demo.anchoring;
  return (
    <div className="demo-anchoring-notice" data-testid="anchoring-before-sign">
      <strong>{copy.beforeHeading}</strong>
      <p className="demo-inscribe-note">{copy.terminal}</p>
      <p className="demo-inscribe-note">{copy.twoKeys}</p>
      <p className="demo-inscribe-note">{copy.offChainLead}</p>
      <ul className="demo-anchoring-offchain">
        {offChainPreview(asset).map((line) => (
          <li key={line}>
            <code>{line}</code>
          </li>
        ))}
      </ul>
      <p className="demo-inscribe-note">{copy.offChainNote}</p>
    </div>
  );
}

export function AnchoringPanel(props: {
  asset: DemoAssetState;
  busy: boolean;
  pendingHandOff: boolean;
  onInscribeNext: () => void;
  onResend: () => void;
}) {
  const { asset, busy } = props;
  const view = anchoringView(asset.anchoring);
  const copy = demo.anchoring;
  if (!view) return null;
  const offChain = asset.anchoring?.offChain;
  return (
    <div className="demo-anchoring" data-tone={view.tone} data-testid="anchoring-panel">
      <div className="demo-deposit-head">
        <strong>{view.label}</strong>
        {view.confirmations && <span className="demo-resolved-badge" data-ok={view.tone === 'ok' || undefined}>{view.confirmations}</span>}
      </div>
      <p className="demo-inscribe-note" data-testid="anchoring-label-note">{view.labelNote}</p>
      {view.actionNote && <p className="demo-inscribe-note" data-testid="anchoring-action">{view.actionNote}</p>}
      {view.neverCurrentNote && <p className="demo-inscribe-note">{view.neverCurrentNote}</p>}
      {asset.btcoDid && (
        <p className="demo-inscribe-note">
          <code>{asset.btcoDid}</code>
        </p>
      )}
      {view.holder && (
        <p className="demo-inscribe-note" data-testid="anchoring-holder">
          {copy.holderLead} <code>{view.holder.output}</code>. {view.holder.note}
        </p>
      )}
      {view.holderElsewhere && <p className="demo-error" role="alert">{copy.holderElsewhere}</p>}
      {view.indexNote && <p className="demo-inscribe-note" data-testid="anchoring-index">{view.indexNote}</p>}
      {offChain && (
        <>
          <p className="demo-inscribe-note">{copy.offChainLead}</p>
          <ul className="demo-anchoring-offchain">
            {offChain.resources.map((r) => (
              <li key={`${r.resource}-${r.version}`}>
                <code>{r.resource}</code> v{r.version}
              </li>
            ))}
            {offChain.identities.map((i) => (
              <li key={i.did}>{copy.offChainIdentity(i.did)}</li>
            ))}
          </ul>
          <p className="demo-inscribe-note">{copy.offChainNote}</p>
        </>
      )}
      {props.pendingHandOff && (
        <>
          <p className="demo-inscribe-note">{copy.resendNote}</p>
          <button type="button" className="btn demo-step-btn" disabled={busy} onClick={props.onResend}>
            {copy.resend}
          </button>
        </>
      )}
      {view.unpublishedNote && <p className="demo-inscribe-note" data-testid="anchoring-unpublished">{view.unpublishedNote}</p>}
      {view.canInscribeNext && !props.pendingHandOff && (
        <button type="button" className="btn btn-primary demo-step-btn" disabled={busy} data-busy={busy || undefined} onClick={props.onInscribeNext}>
          {busy ? copy.inscribeNextPending : copy.inscribeNext}
        </button>
      )}
    </div>
  );
}
