import { demo } from '../content';
import type { CelEntry } from '../sdk/engine';

/**
 * The asset's Cryptographic Event Log, rendered as the hash-chained record it
 * is — split into TWO sections that carry different weight:
 *
 *  - the AUTHENTICITY chain: creator entries — this is my work, this is what
 *    it is, these are its resources;
 *  - the CUSTODY chain: holder entries — I held it, here is what I added.
 *
 * One hash chain runs through both (each entry still shows the digest of the
 * entry before it, whatever section that entry rendered in). Entries whose
 * author class is absent or unattributed render in the custody section with an
 * explicit "unverified author" label — never in the authenticity section.
 */

/** Layer each CREATOR event type moves the asset to, for the accent colour. */
const typeAccent: Record<string, string> = {
  create: 'var(--cel)',
  migrate: 'var(--webvh)',
  rotateKey: 'var(--btco)',
  update: 'var(--cel)'
};

/** Holder entries get their own accent — custody, not the creator palette. */
const HOLDER_ACCENT = 'var(--holder, var(--text-secondary))';

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

function isHolder(entry: CelEntry): boolean {
  return entry.authorClass === 'holder';
}

/** Custody section membership: holder entries plus anything unattributable. */
export function isCustodyEntry(entry: CelEntry): boolean {
  return entry.authorClass !== 'creator';
}
const isCustody = isCustodyEntry;

/** Colour by destination so the chain reads in the pipeline's palette. */
export function accentFor(entry: CelEntry): string {
  if (isHolder(entry)) return HOLDER_ACCENT;
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
  if (isHolder(entry)) {
    // A holder entry is custody, never an authenticity claim: render its
    // statement and its author, never a name or resource counts.
    const statement = str(data.statement);
    const author = str(data.author) ?? entry.authorKey;
    const who = author ? truncate(author, 28) : demo.eventLog.unverifiedAuthor;
    return statement
      ? `${demo.eventLog.heldBy} ${who} — “${truncate(statement, 60)}”`
      : `${demo.eventLog.heldBy} ${who}`;
  }
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
    const statement = str(data.statement);
    if (statement) return `Statement — “${truncate(statement, 60)}”`;
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

function CelEntryItem({ entry, index }: { entry: CelEntry; index: number }) {
  const accent = accentFor(entry);
  const proof = entry.proof[0];
  const vm = proof?.verificationMethod;
  const unattributed = isCustody(entry) && !isHolder(entry);
  return (
    <li className="cel-entry">
      {/* The link renders ABOVE its entry: an entry's previousEvent is a
          claim about its parent, so the digest belongs between them — the
          ONE hash chain stays visible across both sections. */}
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
          {index + 1}
        </span>
        <div className="cel-entry-main">
          <div className="cel-entry-head">
            <code className="cel-entry-type" style={{ color: accent }}>
              {entry.type}
            </code>
            {!entry.previousEvent && (
              <span className="cel-entry-genesis">{demo.eventLog.genesisLabel}</span>
            )}
            {unattributed && (
              <span className="cel-entry-unattributed">{demo.eventLog.unverifiedAuthor}</span>
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
}

export function CelChain({ entries }: { entries: CelEntry[] }) {
  const indexed = entries.map((entry, index) => ({ entry, index }));
  const authenticity = indexed.filter(({ entry }) => !isCustody(entry));
  const custody = indexed.filter(({ entry }) => isCustody(entry));
  return (
    <>
      <ol className="cel-chain" aria-label={demo.eventLog.authenticityTitle}>
        {custody.length > 0 && (
          <li className="cel-section-label" aria-hidden="true">
            {demo.eventLog.authenticityTitle}
          </li>
        )}
        {authenticity.map(({ entry, index }) => (
          <CelEntryItem key={index} entry={entry} index={index} />
        ))}
      </ol>
      {custody.length > 0 && (
        <ol className="cel-chain cel-chain-custody" aria-label={demo.eventLog.custodyTitle}>
          <li className="cel-section-label" aria-hidden="true">
            {demo.eventLog.custodyTitle}
          </li>
          {custody.map(({ entry, index }) => (
            <CelEntryItem key={index} entry={entry} index={index} />
          ))}
        </ol>
      )}
      <p className="demo-log-source">{demo.eventLog.sourceNote}</p>
    </>
  );
}
