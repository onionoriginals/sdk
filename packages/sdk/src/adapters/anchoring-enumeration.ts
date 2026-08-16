import { StructuredError, validateSatoshiNumber } from '@originals/cel';

/** The read surface the sat-scoped enumeration needs from a provider. */
interface SatReads {
  getInscriptionsBySatoshi(satoshi: string): Promise<Array<{ inscriptionId: string }>>;
  getInscriptionById(id: string): Promise<{
    inscriptionId: string;
    content?: Uint8Array;
    contentType: string;
    satoshi?: string;
    blockHeight?: number;
    metadata?: Record<string, unknown>;
  } | null>;
}

export interface DidCelAnchoring {
  satoshi: string;
  inscriptionId: string;
  blockHeight?: number;
  didDocument?: Record<string, unknown>;
}

/**
 * SAT-SCOPED `getAnchoringsForDidCel` (#473), shared by QuickNodeProvider and
 * OrdHttpProvider. Ord exposes no did:cel back-link index, so a production
 * provider can only enumerate the anchorings on the log's OWN anchored sat
 * (passed by the verifier as `opts.satoshi`): list the sat's inscriptions,
 * fetch each, and keep those whose inscribed did:btco document back-links the
 * did:cel via `alsoKnownAs`. See the OrdinalsProvider contract for exactly
 * what this tier proves — presence/confirmation of the claimed anchoring, NOT
 * cross-sat first-anchor canonicality.
 */
export async function enumerateAnchoringsOnSat(
  provider: SatReads,
  didCel: string,
  satoshi: string | undefined,
  providerName: string
): Promise<DidCelAnchoring[]> {
  if (typeof satoshi !== 'string' || satoshi.length === 0) {
    // Fail loudly rather than fabricate an empty enumeration: an empty result
    // would read as "no anchorings exist" instead of "cannot enumerate".
    throw new StructuredError(
      'ANCHORING_ENUMERATION_UNSCOPED',
      `${providerName}.getAnchoringsForDidCel is sat-scoped: it cannot enumerate anchorings for ${didCel} without opts.satoshi (ord exposes no global did:cel back-link index)`
    );
  }
  const validation = validateSatoshiNumber(satoshi);
  if (!validation.valid) {
    throw new StructuredError('ANCHORING_ENUMERATION_INVALID_SATOSHI', `${providerName}: ${validation.error}`);
  }

  const out: DidCelAnchoring[] = [];
  for (const { inscriptionId } of await provider.getInscriptionsBySatoshi(satoshi)) {
    const insc = await provider.getInscriptionById(inscriptionId);
    // A listed-but-unfetchable id can only shrink the result — absence fails
    // the log CLOSED at the uniqueness gate, never passes it.
    if (!insc) continue;
    // An id listed on this sat whose record reports a DIFFERENT sat is
    // inconsistent indexer data — never surface it as a cross-sat competitor.
    if (typeof insc.satoshi === 'string' && insc.satoshi.length > 0 && insc.satoshi !== satoshi) continue;
    // #407 phase 2: the DID document rides in inscription metadata (content is
    // the asset media); fall back to phase-1 content-as-DID-doc JSON.
    let doc: unknown = (insc.metadata as { didDocument?: unknown } | undefined)?.didDocument;
    if (doc === undefined && insc.content !== undefined) {
      try {
        doc = JSON.parse(new TextDecoder().decode(insc.content));
      } catch {
        continue; // non-JSON media without metadata DID doc — not an anchoring
      }
    }
    if (doc === null || typeof doc !== 'object') continue;
    const aka = (doc as { alsoKnownAs?: unknown }).alsoKnownAs;
    if (!Array.isArray(aka) || !aka.includes(didCel)) continue;
    out.push({
      satoshi,
      inscriptionId: insc.inscriptionId,
      blockHeight: insc.blockHeight,
      // Surface the inscribed doc so uniqueness can authenticate it (#402).
      didDocument: doc as Record<string, unknown>
    });
  }
  return out;
}
