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
import type { CelLog, CelResourceRef } from '../pages/original-detail-data';
import { digestMultibaseSha256Hex } from '../pages/original-detail-data';

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

/**
 * The resources a hosted CEL declares, with the URL segment each is served
 * under. The caller fetches these; keeping the fetch outside makes the mapping
 * testable and lets the page report a partial failure per resource.
 */
export function hostedResourceRefs(cel: CelLog | null): CelResourceRef[] {
  const genesis = cel?.events?.find((e) => e.type === 'create');
  return genesis?.data?.resources ?? [];
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
  const refs = genesis.data?.resources ?? [];
  if (refs.length === 0) {
    return { problem: { code: 'NO_RESOURCES', message: 'This Original’s genesis event seals no resources.' } };
  }

  const resources = [];
  for (const ref of refs) {
    const hash = ref.digestMultibase ? digestMultibaseSha256Hex(ref.digestMultibase) : null;
    if (!hash) {
      return {
        problem: { code: 'BAD_DIGEST', message: `Resource “${ref.id}” has no readable content digest.` },
      };
    }
    const content = contents[ref.digestMultibase!];
    if (content === undefined) {
      return {
        problem: { code: 'MISSING_CONTENT', message: `Resource “${ref.id}” could not be fetched back from this origin.` },
      };
    }
    resources.push({
      id: ref.id,
      type: resourceKind(ref.mediaType),
      contentType: ref.mediaType ?? 'application/octet-stream',
      hash,
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
