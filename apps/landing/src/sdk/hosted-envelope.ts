/**
 * Rebuild an Original from what it hosts.
 *
 * A published Original leaves three things at its origin: the signed did:webvh
 * log, the CEL (`cel.json`), and the sealed resource bytes. That is everything
 * `LifecycleManager.loadAsset` needs to reconstruct the live asset — so a
 * creator returning days later can finish an inscription instead of re-running
 * the demo and ending up with a second, different Original.
 *
 * This module is the adapter between the two shapes, and it is deliberately
 * pure: it takes already-fetched artifacts and returns an `AssetEnvelope`. No
 * network here, so the mapping is unit-testable on its own.
 *
 * Nothing here is trusted. The envelope goes through `loadAsset`, which
 * verifies the whole signed chain, the resource↔genesis binding and the
 * DID-doc↔fold cross-checks, all fail-closed. Getting a field wrong makes the
 * load fail; it cannot make an unverified asset look verified.
 */
import {
  ASSET_ENVELOPE_FORMAT,
  ASSET_ENVELOPE_VERSION,
  createCelDidDocument,
  deriveDidCel,
} from '@originals/sdk';
import type { AssetEnvelope } from '@originals/sdk';
import type { CelLog } from '../pages/original-detail-data';
import { digestMultibaseSha256Hex, sha256HexToResourceMultibase } from '../pages/original-detail-data';

/**
 * `AssetResource.type` from a media type — the same coarse split
 * `DemoEngine.create` uses when it seals the artwork and its metadata.
 */
export function resourceKind(mediaType: string | undefined): string {
  if (!mediaType) return 'data';
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.startsWith('text/')) return 'text';
  return 'data';
}

export interface HydrationProblem {
  /** Machine-readable so the UI can choose copy without matching on prose. */
  code:
    | 'NO_CEL'
    | 'NO_GENESIS'
    | 'NO_CONTROLLER'
    | 'NO_RESOURCES'
    | 'BAD_DIGEST'
    | 'MISSING_CONTENT';
  message: string;
}

/** One hosted version of one resource. */
export interface HostedResourceRef {
  id: string;
  /** 1 for genesis; ≥2 for every version a signed `update` event introduced. */
  version: number;
  /** hex sha-256 of THIS version's bytes. */
  hash: string;
  /** The segment this version is served under (`resources/<segment>`). */
  segment: string;
  mediaType?: string;
  previousVersionHash?: string;
}

/**
 * EVERY resource version the hosted CEL declares — genesis, and every version a
 * signed `update` event introduced after it.
 *
 * Reading genesis alone was a silent correctness bug: a revised Original would
 * rebuild with only its v1 bytes, `loadAsset` would accept that (v1 binds to
 * genesis perfectly well, and nothing requires an envelope to carry the LATEST
 * version), and inscribing would then anchor the SUPERSEDED artwork to Bitcoin
 * permanently. Caught by review on #515; `hosted-envelope.test.ts` reproduces
 * it.
 *
 * The caller fetches these; keeping the fetch outside makes the mapping
 * testable and lets the page report a partial failure per version.
 */
export function hostedResourceRefs(cel: CelLog | null): HostedResourceRef[] {
  const events = cel?.events ?? [];
  const refs: HostedResourceRef[] = [];

  const genesis = events[0]?.type === 'create' ? events[0] : undefined;
  for (const r of genesis?.data?.resources ?? []) {
    const hash = r.digestMultibase ? digestMultibaseSha256Hex(r.digestMultibase) : null;
    const segment = hash ? sha256HexToResourceMultibase(hash) : null;
    // A ref we cannot address is still reported, so the envelope builder can
    // name it in BAD_DIGEST rather than quietly dropping a sealed resource.
    refs.push({
      id: r.id,
      version: 1,
      hash: hash ?? '',
      segment: segment ?? '',
      ...(r.mediaType ? { mediaType: r.mediaType } : {}),
    });
  }

  // Later versions. `update` events carry the hex hash directly, and the
  // envelope's post-genesis binding requires each v≥2 to match the exact
  // `toVersion` of a verified update event — so these are emitted verbatim
  // from the log rather than inferred.
  for (const e of events) {
    if (e.type !== 'update') continue;
    const d = (e.data ?? {}) as {
      resourceId?: unknown;
      toHash?: unknown;
      toVersion?: unknown;
      contentType?: unknown;
      previousVersionHash?: unknown;
    };
    if (typeof d.resourceId !== 'string' || typeof d.toHash !== 'string') continue;
    if (typeof d.toVersion !== 'number') continue;
    const segment = sha256HexToResourceMultibase(d.toHash);
    refs.push({
      id: d.resourceId,
      version: d.toVersion,
      hash: d.toHash,
      segment: segment ?? '',
      ...(typeof d.contentType === 'string' ? { mediaType: d.contentType } : {}),
      ...(typeof d.previousVersionHash === 'string'
        ? { previousVersionHash: d.previousVersionHash }
        : {}),
    });
  }

  // Ascending version per resource: the fold expects a version chain, and a
  // v2 ahead of its v1 is not one.
  refs.sort((a, b) => (a.id === b.id ? a.version - b.version : 0));
  return refs;
}

/**
 * Turn hosted artifacts into an `AssetEnvelope`.
 *
 * `contents` is keyed by `digestMultibase` — the same segment the resource is
 * hosted under — and carries the bytes fetched back from the origin. They are
 * included so `loadAsset` can check each resource against the digest its
 * genesis event sealed, rather than taking the CEL's word for it.
 */
export function hostedAssetEnvelope(
  cel: CelLog | null,
  contents: Record<string, string>
): { envelope: AssetEnvelope } | { problem: HydrationProblem } {
  if (!cel || !Array.isArray(cel.events) || cel.events.length === 0) {
    return { problem: { code: 'NO_CEL', message: 'This Original hosts no event log.' } };
  }
  const genesis = cel.events[0];
  if (genesis?.type !== 'create') {
    return { problem: { code: 'NO_GENESIS', message: 'This Original’s event log does not begin with its genesis event.' } };
  }
  const controller = genesis.data?.controller;
  if (typeof controller !== 'string' || !controller.startsWith('did:key:')) {
    return { problem: { code: 'NO_CONTROLLER', message: 'This Original’s genesis event names no controller key.' } };
  }
  if ((genesis.data?.resources ?? []).length === 0) {
    return { problem: { code: 'NO_RESOURCES', message: 'This Original’s genesis event seals no resources.' } };
  }
  const refs = hostedResourceRefs(cel);
  if (refs.length === 0) {
    return { problem: { code: 'NO_RESOURCES', message: 'This Original’s genesis event seals no resources.' } };
  }

  const resources = [];
  for (const ref of refs) {
    if (!ref.hash || !ref.segment) {
      return {
        problem: { code: 'BAD_DIGEST', message: `Resource “${ref.id}” has no readable content digest.` },
      };
    }
    const content = contents[ref.segment];
    if (content === undefined) {
      return {
        problem: {
          code: 'MISSING_CONTENT',
          message: `Resource “${ref.id}”${ref.version > 1 ? ` v${ref.version}` : ''} could not be fetched back from this origin.`,
        },
      };
    }
    resources.push({
      id: ref.id,
      type: resourceKind(ref.mediaType),
      contentType: ref.mediaType ?? 'application/octet-stream',
      hash: ref.hash,
      version: ref.version,
      ...(ref.previousVersionHash ? { previousVersionHash: ref.previousVersionHash } : {}),
      content,
    });
  }

  // The log is the source of the identifier, never the page: deriving it here
  // means a tampered cel.json cannot point loadAsset at a different asset.
  const eventLog = { events: cel.events } as unknown as AssetEnvelope['eventLog'];
  let assetDid: string;
  try {
    assetDid = deriveDidCel(eventLog);
  } catch (e) {
    return { problem: { code: 'NO_GENESIS', message: `This Original’s genesis event is unreadable: ${(e as Error).message}` } };
  }

  const controllerPublicKey = controller.slice('did:key:'.length);
  return {
    envelope: {
      format: ASSET_ENVELOPE_FORMAT,
      version: ASSET_ENVELOPE_VERSION,
      assetDid,
      eventLog,
      didDocuments: { 'did:cel': createCelDidDocument(assetDid, controllerPublicKey) },
      resources,
    },
  };
}
