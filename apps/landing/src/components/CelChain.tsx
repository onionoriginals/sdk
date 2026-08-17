import { demo } from '../content';
import type { CelEntry } from '../sdk/engine';

/**
 * The asset's Cryptographic Event Log, rendered as the hash-chained record it
 * is. This deliberately replaced the SDK's emitter-event stream: those are
 * app-level notifications, whereas these entries ARE the asset's provenance —
 * each one signed, and each committing to the digest of the entry before it.
 */

/** Layer each event type moves the asset to, for the accent colour. */
const typeAccent: Record<string, string> = {
  create: 'var(--cel)',
  migrate: 'var(--webvh)',
  rotateKey: 'var(--btco)',
  update: 'var(--cel)'
};

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A migrate event names its destination as `layer` ('webvh' | 'btco'), never a
 * bare `to`. The full destination DID is `targetDid` on a webvh migrate but
 * `to` on a btco one, so read both.
 */
function targetDidOf(entry: CelEntry): string | undefined {
  return str(entry.data.targetDid) ?? str(entry.data.to);
}

/** Colour by destination so the chain reads in the pipeline's palette. */
export function accentFor(entry: CelEntry): string {
  if (entry.type === 'migrate') {
    const layer = str(entry.data.layer) ?? targetDidOf(entry) ?? '';
    if (layer.includes('btco')) return 'var(--btco)';
    if (layer.includes('webvh')) return 'var(--webvh)';
  }
  return typeAccent[entry.type] ?? 'var(--text-tertiary)';
}

/** One-line plain-English gloss of what the signed body asserts. */
export function summarize(entry: CelEntry): string {
  const data = entry.data;
  if (entry.type === 'create') {
    const count = Array.isArray(data.resources) ? data.resources.length : 0;
    const noun = count === 1 ? 'resource' : 'resources';
    return count > 0
      ? `Genesis — binds ${count} ${noun} to a new identifier`
      : 'Genesis — establishes a new identifier';
  }
  if (entry.type === 'migrate') {
    const target = targetDidOf(entry);
    const layer = str(data.layer) ?? '';
    const where = layer.includes('btco')
      ? 'Bitcoin'
      : layer.includes('webvh')
        ? `the web${str(data.domain) ? ` at ${str(data.domain)}` : ''}`
        : 'a new layer';
    return target ? `Moves to ${where} — ${truncate(target, 46)}` : `Moves to ${where}`;
  }
  if (entry.type === 'rotateKey') return 'Rotates the controlling key';
  if (entry.type === 'update') {
    // The body is reference-shaped: it carries the signed toHash, never bytes.
    const id = str(data.resourceId);
    const to = typeof data.toVersion === 'number' ? data.toVersion : undefined;
    if (id && to) return `New version — ${truncate(id, 28)} → v${to}, chained to the bytes before it`;
    return 'Records a new resource version';
  }
  return entry.type;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Middle-elide a digest so both ends stay comparable by eye. */
function digest(value: string): string {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

export function CelChain({ entries }: { entries: CelEntry[] }) {
  return (
    <>
      <ol className="cel-chain" aria-label="Cryptographic event log">
        {entries.map((entry, i) => {
          const accent = accentFor(entry);
          const proof = entry.proof[0];
          const vm = proof?.verificationMethod;
          return (
            <li key={i} className="cel-entry">
              {/* The link renders ABOVE its entry: an entry's previousEvent is a
                  claim about its parent, so the digest belongs between them. */}
              {entry.previousEvent ? (
                <div className="cel-link">
                  <span className="cel-link-rail" aria-hidden="true" />
                  <span className="cel-link-label">
                    {demo.eventLog.chainLabel}
                    <code>{digest(entry.previousEvent)}</code>
                  </span>
                </div>
              ) : null}

              <div className="cel-entry-body">
                <span className="cel-entry-index" style={{ borderColor: accent, color: accent }}>
                  {i + 1}
                </span>
                <div className="cel-entry-main">
                  <div className="cel-entry-head">
                    <code className="cel-entry-type" style={{ color: accent }}>
                      {entry.type}
                    </code>
                    {!entry.previousEvent && (
                      <span className="cel-entry-genesis">{demo.eventLog.genesisLabel}</span>
                    )}
                  </div>
                  <p className="cel-entry-summary">{summarize(entry)}</p>
                  <div className="cel-entry-proof">
                    {proof?.proofValue ? (
                      <>
                        <span className="cel-proof-mark" style={{ background: accent }} />
                        <span>
                          {demo.eventLog.signedBy} <code>{vm ? truncate(vm, 34) : 'controller'}</code>
                        </span>
                        <code className="cel-proof-value">{digest(proof.proofValue)}</code>
                      </>
                    ) : (
                      <span className="cel-entry-unsigned">{demo.eventLog.unsigned}</span>
                    )}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="demo-log-source">{demo.eventLog.sourceNote}</p>
    </>
  );
}
