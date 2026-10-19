import { demo } from '../content';
import type { HistoryEntry } from '../sdk/engine';

/**
 * The Original's asset log: a did:vh log under the Originals extension, one
 * entry per accepted change, each signed once by an author key of the author's
 * DID (P5.2). Each entry's versionId commits to the one before it, so the
 * chain shown here is the chain a verifier walks.
 */

const accent: Record<string, string> = {
  create: 'var(--cel)',
  update: 'var(--cel)',
  deactivate: 'var(--text-tertiary)',
};

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Middle-elide a digest so both ends stay comparable by eye. */
function digest(value: string): string {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

/** One-line plain-English gloss of what the signed entry records. */
export function summarize(entry: HistoryEntry): string {
  if (entry.operation === 'create') {
    const count = entry.changes.length;
    return `Started a signed history for ${count} ${count === 1 ? 'file' : 'files'}`;
  }
  if (entry.operation === 'deactivate') return 'Ended this Original; no further changes are accepted';
  if (entry.changes.length > 0) {
    return `Revises ${truncate(entry.changes.map((c) => c.resource).join(', '), 40)} — linked to the previous version`;
  }
  return `Renamed or re-described as “${truncate(entry.name, 40)}”`;
}

function Entry({ entry, index, previous }: { entry: HistoryEntry; index: number; previous?: string }) {
  const color = accent[entry.operation] ?? 'var(--text-tertiary)';
  return (
    <li className="cel-entry">
      {previous ? (
        <div className="cel-link">
          <span className="cel-link-rail" aria-hidden="true" />
          <span className="cel-link-label">
            {demo.eventLog.chainLabel}
            <code>{digest(previous)}</code>
          </span>
        </div>
      ) : null}
      <div className="cel-entry-body">
        <span className="cel-entry-index" style={{ borderColor: color, color }}>{index + 1}</span>
        <div className="cel-entry-main">
          <div className="cel-entry-head">
            <code className="cel-entry-type" style={{ color }}>
              {demo.eventLog.entryLabels[entry.operation] ?? entry.operation}
            </code>
            {index === 0 && <span className="cel-entry-genesis">{demo.eventLog.genesisLabel}</span>}
          </div>
          <p className="cel-entry-summary">{summarize(entry)}</p>
          <details>
            <summary>{demo.eventLog.detailsLabel}</summary>
            <div className="cel-entry-proof">
              <span>{demo.eventLog.versionLabel} <code>{digest(entry.versionId)}</code> · {entry.versionTime}</span>
            </div>
            <div className="cel-entry-proof">
              <span className="cel-proof-mark" style={{ background: color }} />
              <span>{demo.eventLog.signedBy} <code>{truncate(entry.authorKey, 48)}</code></span>
            </div>
          </details>
        </div>
      </div>
    </li>
  );
}

export function HistoryChain({ entries }: { entries: HistoryEntry[] }) {
  return (
    <>
      <ol className="cel-chain" aria-label={demo.eventLog.authenticityTitle}>
        {entries.map((entry, index) => (
          <Entry key={entry.versionId} entry={entry} index={index} previous={entries[index - 1]?.versionId} />
        ))}
      </ol>
      <p className="demo-log-source">{demo.eventLog.sourceNote}</p>
    </>
  );
}
