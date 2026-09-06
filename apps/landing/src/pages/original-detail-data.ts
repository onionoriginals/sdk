/**
 * Pure data shaping for the Original detail page ('/me/<did>') — no DOM, no
 * fetch, fully unit-testable. Turns the artifacts a published Original hosts at
 * this origin (did.jsonl, cel.json, resources/*) into view models: artifact
 * URLs derived from the DID, a lifecycle timeline folded from the CEL events,
 * and a summary of the signed did:webvh version-history log.
 */
import type { OriginalRow } from './YourOriginals';
import { claimedSignerDid } from '@originals/sdk/cel';

/* ——— CEL log shapes (what LifecycleManager publishes as cel.json) ——— */

export interface CelProof {
  type?: string;
  created?: string;
  cryptosuite?: string;
  proofPurpose?: string;
  proofValue?: string;
  verificationMethod?: string;
}

export interface CelResourceRef {
  id: string;
  mediaType?: string;
  digestMultibase?: string;
}

export interface CelEvent {
  type: string;
  data?: {
    controller?: string;
    createdAt?: string;
    name?: string;
    resources?: CelResourceRef[];
    domain?: string;
    layer?: string;
    migratedAt?: string;
    sourceDid?: string;
    targetDid?: string;
  } & Record<string, unknown>;
  proof?: CelProof[];
  previousEvent?: string;
}

export interface CelLog {
  events: CelEvent[];
}

/* ——— Artifact locations ——— */

export interface WebvhArtifacts {
  /** The DID's host (may include a port in dev). */
  host: string;
  /** Path under the host: '/<seg>/…' for pathed DIDs, '/.well-known' for domain-root. */
  path: string;
  /** URL of the signed did:webvh version-history log. */
  logUrl: string;
  /** URL of the CEL event log hosted beside it. */
  celUrl: string;
  /** URL of a hosted resource by its digest multibase. */
  resourceUrl(digestMultibase: string): string;
}

/**
 * Where a did:webvh Original's artifacts live, derived purely from the DID
 * (did:webvh:<SCID>:<host>[:<seg>…]). When `currentHost` matches the DID's
 * host, URLs are origin-relative — this keeps fetches same-origin in dev
 * (http) and prod alike; otherwise they are absolute https, the exact URLs
 * the SDK's resolver GETs.
 */
export function webvhArtifacts(did: string, currentHost?: string): WebvhArtifacts | null {
  const parts = did.split(':');
  if (parts.length < 4 || parts[0] !== 'did' || parts[1] !== 'webvh') return null;
  let host: string;
  let segs: string[];
  try {
    host = decodeURIComponent(parts[3] ?? '');
    segs = parts.slice(4).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (!host) return null;
  const path = segs.length ? `/${segs.join('/')}` : '/.well-known';
  const base = currentHost === host ? '' : `https://${host}`;
  return {
    host,
    path,
    logUrl: `${base}${path}/did.jsonl`,
    celUrl: `${base}${path}/cel.json`,
    resourceUrl: (digestMultibase: string) => `${base}${path}/resources/${digestMultibase}`
  };
}

/* ——— Lifecycle timeline (folded from the CEL) ——— */

export interface TimelineFact {
  label: string;
  value: string;
  /** Render in the mono font and shorten for display (full value in the title). */
  mono?: boolean;
}

export interface TimelineStep {
  id: 'create' | 'publish' | 'inscribe';
  layer: 'did:cel' | 'did:webvh' | 'did:btco';
  state: 'done' | 'upcoming';
  at?: string;
  facts: TimelineFact[];
  proof?: CelProof;
}

/**
 * Fold the CEL event log into the three-layer lifecycle. Every completed step
 * carries the signed proof of the event that performed it; steps the asset
 * hasn't reached yet render as 'upcoming'.
 */
export function celTimeline(cel: CelLog | null): TimelineStep[] {
  const events = cel?.events ?? [];
  const create = events.find((e) => e.type === 'create');
  const publish = events.find((e) => e.type === 'migrate' && e.data?.layer === 'webvh');
  const inscribe = events.find((e) => e.type === 'migrate' && e.data?.layer === 'btco');

  const createFacts: TimelineFact[] = [];
  if (create?.data?.controller) {
    createFacts.push({ label: 'Signed by', value: create.data.controller, mono: true });
  }
  const resourceCount = create?.data?.resources?.length ?? 0;
  if (resourceCount > 0) {
    createFacts.push({
      label: 'Resources sealed',
      value: `${resourceCount} ${resourceCount === 1 ? 'file' : 'files'}, hashed byte-for-byte`
    });
  }

  const publishFacts: TimelineFact[] = [];
  if (publish?.data?.sourceDid) {
    publishFacts.push({ label: 'Genesis', value: publish.data.sourceDid, mono: true });
  }
  if (publish?.data?.targetDid) {
    publishFacts.push({ label: 'Published as', value: publish.data.targetDid, mono: true });
  }
  if (publish?.data?.domain) {
    publishFacts.push({ label: 'Host', value: publish.data.domain, mono: true });
  }

  const inscribeFacts: TimelineFact[] = [];
  if (inscribe?.data?.targetDid) {
    inscribeFacts.push({ label: 'Inscribed as', value: inscribe.data.targetDid, mono: true });
  }

  return [
    {
      id: 'create',
      layer: 'did:cel',
      state: create ? 'done' : 'upcoming',
      at: create?.data?.createdAt,
      facts: createFacts,
      proof: create?.proof?.[0]
    },
    {
      id: 'publish',
      layer: 'did:webvh',
      state: publish ? 'done' : 'upcoming',
      at: publish?.data?.migratedAt,
      facts: publishFacts,
      proof: publish?.proof?.[0]
    },
    {
      id: 'inscribe',
      layer: 'did:btco',
      state: inscribe ? 'done' : 'upcoming',
      at: inscribe?.data?.migratedAt,
      facts: inscribeFacts,
      proof: inscribe?.proof?.[0]
    }
  ];
}

/* ——— Custody chain (holder entries), item 5 ——— */

export interface CustodyRow {
  /** The holder's claimed did:key (a display CLAIM — only verification promotes it). */
  author: string;
  statement?: string;
  occurredAt?: string;
  eventIndex: number;
}

/**
 * Fold the holder entries (post-anchor updates signed outside the creator
 * lineage) out of the CEL — the detail page's custody section. Mirrors the
 * SDK managers' defensive fold: lineage is the genesis controller plus
 * pre-anchor rotations; the anchor is the btco migrate; nothing here is
 * verified, so the page labels these as the holders' claims.
 */
export function celCustody(cel: CelLog | null): CustodyRow[] {
  const events = cel?.events ?? [];
  // Lineage is genesis `data.controller` only (the model's sole genesis
  // identity; there is no legacy shape to read) plus pre-anchor rotations.
  // The signer is read via the SDK's shared `claimedSignerDid` (author, else
  // the first NON-WITNESS proof's VM DID) — a hand-rolled proof[0] read here
  // previously mislabeled a witness-first proof array's `did:btco:witness` as
  // the author.
  const lineage = new Set<string>();
  const genesisController = events[0]?.data?.controller;
  if (typeof genesisController === 'string') lineage.add(genesisController);
  let anchored = false;
  const rows: CustodyRow[] = [];
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    const data = e.data ?? {};
    if (e.type === 'migrate' && data.layer === 'btco') {
      anchored = true;
      continue;
    }
    if (!anchored && e.type === 'rotateKey' && typeof data.newController === 'string') {
      lineage.add(data.newController);
      continue;
    }
    if (anchored && e.type === 'update') {
      const author = claimedSignerDid(e as { data?: unknown; proof?: unknown });
      if (author === undefined || !lineage.has(author)) {
        rows.push({
          author: author ?? '(unverified author)',
          ...(typeof data.statement === 'string' ? { statement: data.statement } : {}),
          ...(typeof data.occurredAt === 'string' ? { occurredAt: data.occurredAt } : {}),
          eventIndex: i,
        });
      }
    }
  }
  return rows;
}

/** The resources sealed at genesis (id + media type + content digest). */
export function celResources(cel: CelLog | null): CelResourceRef[] {
  const create = cel?.events?.find((e) => e.type === 'create');
  return create?.data?.resources ?? [];
}

/* ——— did:webvh log summary ——— */

export interface DidLogSummary {
  versions: number;
  scid?: string;
  did?: string;
  createdAt?: string;
  updatedAt?: string;
  updateKeys: string[];
  verificationMethods: Array<{ id?: string; type?: string; publicKeyMultibase?: string }>;
  /** The current DID document (the last entry's state). */
  document?: Record<string, unknown>;
}

interface DidLogEntry {
  versionId?: string;
  versionTime?: string;
  parameters?: { scid?: string; updateKeys?: string[] };
  state?: Record<string, unknown> & {
    id?: string;
    verificationMethod?: Array<{ id?: string; type?: string; publicKeyMultibase?: string }>;
  };
}

/** Parse a did.jsonl body into its entries (one JSON object per line). */
export function parseDidLog(raw: string): DidLogEntry[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DidLogEntry);
}

/**
 * Summarize a did:webvh log: SCID and update keys come from the latest entry
 * that declares them (parameters carry over between versions), the DID document
 * is the last entry's state.
 */
export function didLogSummary(entries: DidLogEntry[]): DidLogSummary | null {
  if (entries.length === 0) return null;
  let scid: string | undefined;
  let updateKeys: string[] = [];
  for (const entry of entries) {
    if (entry.parameters?.scid) scid = entry.parameters.scid;
    if (entry.parameters?.updateKeys?.length) updateKeys = entry.parameters.updateKeys;
  }
  const first = entries[0];
  const last = entries[entries.length - 1];
  return {
    versions: entries.length,
    scid,
    did: last.state?.id,
    createdAt: first.versionTime,
    updatedAt: last.versionTime,
    updateKeys,
    verificationMethods: last.state?.verificationMethod ?? [],
    document: last.state
  };
}

/* ——— Content digests ——— */

/**
 * The sha-256 hex a `digestMultibase` declares, or null when it isn't a
 * base64url multibase ('u' prefix) sha2-256 multihash (0x12 0x20 + 32 bytes).
 * Lets the page recompute a resource's hash from its fetched bytes and compare.
 */
export function digestMultibaseSha256Hex(digestMultibase: string): string | null {
  if (!digestMultibase.startsWith('u')) return null;
  const b64 = digestMultibase.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 0x20) return null;
  return Array.from(bytes.slice(2), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Rewrite an absolute artifact URL to an origin-relative one when it points at
 * `currentHost` — the store hands back canonical https URLs, which a dev http
 * origin can't load; same-host paths work on both. Foreign hosts pass through.
 */
export function sameOriginUrl(url: string, currentHost?: string): string {
  if (!currentHost) return url;
  try {
    const parsed = new URL(url);
    return parsed.host === currentHost ? `${parsed.pathname}${parsed.search}` : url;
  } catch {
    return url;
  }
}

/**
 * The multibase segment a published resource is HOSTED under: the CANONICAL
 * multibase multihash of the sha-256 (`u` + base64url-nopad(0x12 0x20 ||
 * digest), "uEi…") — the only segment form the SDK writes
 * (LifecycleManager.publishResources). Converts the CEL-declared hex back to
 * that hosted key segment.
 */
export function sha256HexToResourceMultibase(hex: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const bytes = [0x12, 0x20, ...hex.match(/../g)!.map((b) => parseInt(b, 16))];
  const b64 = btoa(String.fromCharCode(...bytes));
  return 'u' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ——— View selector ——— */

export type DetailMode = 'signed-out' | 'loading' | 'not-found' | 'ready';

/** Pure view selector for the detail page — testable without a DOM. */
export function detailMode(input: {
  /** Auth itself is still resolving (session restore) — nothing is known yet. */
  authLoading: boolean;
  authenticated: boolean;
  loaded: boolean;
  row: OriginalRow | null;
}): DetailMode {
  // R20: while auth is in flight `authenticated` is merely not-yet-true, so
  // reading it as signed-out flashes the sign-in prompt at a signed-in user
  // deep-linking or hard-refreshing this page.
  if (input.authLoading) return 'loading';
  if (!input.authenticated) return 'signed-out';
  if (!input.loaded) return 'loading';
  if (!input.row) return 'not-found';
  return 'ready';
}
