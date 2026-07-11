import type { OrdinalsProvider } from '../../adapters/types.js';
import type { ResourceProviderLike } from '../BtcoDidResolver.js';

/**
 * Synthetic URL scheme for inscription content served straight from the
 * configured OrdinalsProvider. BtcoDidResolver fetches content by URL; this
 * adapter mints URLs in this scheme and answers them from the provider via
 * `fetchContent`, so resolution never touches the network on its own.
 */
const CONTENT_URL_PREFIX = 'ordinals-provider://content/';

/**
 * Adapts the SDK-wide `config.ordinalsProvider` (adapters/OrdinalsProvider —
 * the interface CLAUDE.md calls mandatory for Bitcoin operations) to the
 * `ResourceProviderLike` shape BtcoDidResolver consumes.
 *
 * Pass the instance as the resolver's `provider` AND its `fetchContent` as the
 * resolver's `fetchFn`, so both inscription lookup and content retrieval go
 * through the configured provider instead of a hardcoded HTTP endpoint.
 */
export class OrdinalsProviderResolverAdapter implements ResourceProviderLike {
  constructor(private readonly provider: OrdinalsProvider) {}

  async getSatInfo(satNumber: string): Promise<{ inscription_ids: string[] }> {
    const inscriptions = await this.provider.getInscriptionsBySatoshi(satNumber);
    return { inscription_ids: inscriptions.map((i) => i.inscriptionId) };
  }

  async resolveInscription(inscriptionId: string): Promise<{ id: string; sat: number; content_type: string; content_url: string }> {
    const inscription = await this.provider.getInscriptionById(inscriptionId);
    if (!inscription) {
      throw new Error(`Inscription ${inscriptionId} not found`);
    }
    return {
      id: inscription.inscriptionId,
      sat: Number(inscription.satoshi ?? 0),
      content_type: inscription.contentType,
      content_url: CONTENT_URL_PREFIX + encodeURIComponent(inscriptionId)
    };
  }

  // Pass through the optional sat-ownership lookup so resolution can surface
  // ownership metadata; providers without one simply omit it. Ownership is
  // resolution METADATA — never used to rewrite the inscribed document.
  async getSatOwnership(satoshi: string): Promise<{ address: string; outpoint: string } | null> {
    if (typeof this.provider.getSatOwnership !== 'function') return null;
    return this.provider.getSatOwnership(satoshi);
  }

  // The adapters/OrdinalsProvider interface exposes no metadata endpoint;
  // metadata is diagnostic-only in BtcoDidResolver, so report none.
  // eslint-disable-next-line @typescript-eslint/require-await
  async getMetadata(_inscriptionId: string): Promise<Record<string, unknown> | null> {
    return null;
  }

  /**
   * fetchFn for BtcoDidResolver: serves `ordinals-provider://content/<id>`
   * URLs from the underlying provider. Any other URL fails closed — this
   * adapter mints every content_url itself, so a foreign URL here would mean
   * inscription data trying to redirect content retrieval (SSRF).
   */
  fetchContent = async (url: string): Promise<Response> => {
    const respond = (ok: boolean, status: number, statusText: string, body: string): Response =>
      ({ ok, status, statusText, text: () => Promise.resolve(body) } as unknown as Response);

    if (!url.startsWith(CONTENT_URL_PREFIX)) {
      return respond(false, 400, 'Bad Request', `Refusing to fetch non-provider content URL: ${url}`);
    }
    const inscriptionId = decodeURIComponent(url.slice(CONTENT_URL_PREFIX.length));
    const inscription = await this.provider.getInscriptionById(inscriptionId);
    if (!inscription) {
      return respond(false, 404, 'Not Found', `Inscription ${inscriptionId} not found`);
    }
    if (inscription.content === undefined) {
      return respond(false, 404, 'Not Found', `Inscription ${inscriptionId} has no content to serve`);
    }
    return respond(true, 200, 'OK', inscription.content.toString('utf8'));
  };
}
