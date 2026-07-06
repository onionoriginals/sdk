import type { ResourceProviderLike } from '../BtcoDidResolver.js';
import { OrdinalsClient } from '../../bitcoin/OrdinalsClient.js';

export interface OrdinalsClientProviderConfig {
  baseUrl: string;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  timeout?: number;
}

/**
 * Reject a candidate URL whose scheme is not http(s) or whose origin differs
 * from baseUrl's, and return its RESOLVED ABSOLUTE form. The ord endpoint's
 * JSON is attacker-controllable (a compromised/malicious indexer), so a
 * `content_url` it returns must never be followed to an arbitrary host or
 * scheme — that is a Server-Side Request Forgery vector (e.g.
 * http://169.254.169.254/… cloud metadata, file:///…). Relative URLs resolve
 * against baseUrl and stay same-origin; the resolved absolute string is
 * returned so callers store/fetch that — server-side fetch() (Node/Bun)
 * rejects relative URLs outright, so storing the raw relative form would make
 * a perfectly valid inscription unreadable. Mirrors the #265 hardening in
 * OrdHttpProvider.
 */
function resolveSameOrigin(candidate: string, baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(candidate, baseUrl);
  } catch {
    throw new Error(`OrdinalsClientProviderAdapter: malformed content_url '${candidate}'`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `OrdinalsClientProviderAdapter: refusing non-http(s) content_url scheme '${parsed.protocol}' (possible SSRF)`
    );
  }
  const baseOrigin = new URL(baseUrl).origin;
  if (parsed.origin !== baseOrigin) {
    throw new Error(
      `OrdinalsClientProviderAdapter: refusing to fetch content_url from origin ${parsed.origin}, ` +
      `which differs from baseUrl origin ${baseOrigin} (possible SSRF)`
    );
  }
  return parsed.toString();
}

export class OrdinalsClientProviderAdapter implements ResourceProviderLike {
  private readonly config: OrdinalsClientProviderConfig;

  constructor(private client: OrdinalsClient, configOrBaseUrl: string | OrdinalsClientProviderConfig) {
    if (typeof configOrBaseUrl === 'string') {
      this.config = { baseUrl: configOrBaseUrl };
    } else {
      this.config = configOrBaseUrl;
    }
  }

  async getSatInfo(satNumber: string): Promise<{ inscription_ids: string[] }> {
    return this.client.getSatInfo(satNumber);
  }

  async resolveInscription(inscriptionId: string): Promise<{ id: string; sat: number; content_type: string; content_url: string }> {
    const base = (this.config.baseUrl || '').replace(/\/$/, '');
    if (!base) {
      throw new Error('OrdinalsClientProviderAdapter requires a baseUrl');
    }

    try {
      // Use configurable fetch function or default to global fetch
      const fetchFn = this.config.fetchFn || fetch;
      const timeout = this.config.timeout || 10000; // 10 second default timeout

      const fetchOptions: RequestInit = {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeout),
        // Never follow a redirect off the pinned origin.
        redirect: 'error'
      };

      const res = await fetchFn(`${base}/inscription/${inscriptionId}`, fetchOptions);
      if (!res.ok) {
        // Log warning but don't throw - allow graceful degradation
        console.warn(`Failed to resolve inscription ${inscriptionId}: HTTP ${res.status}`);
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const info: any = await res.json();
      // content_url comes from the (untrusted) ord response: pin it to the
      // configured endpoint's origin before anyone fetches it (SSRF guard),
      // and store the RESOLVED ABSOLUTE form — a same-origin RELATIVE URL
      // (e.g. '/content/i1') is valid but server-side fetch() rejects it, so
      // storing it verbatim would make the inscription unreadable and (with
      // the fail-closed resolver) the DID unresolvable.
      const contentUrl = resolveSameOrigin(
        info.content_url || `${base}/content/${inscriptionId}`,
        base
      );
      return {
        id: info.inscription_id || inscriptionId,
        sat: typeof info.sat === 'number' ? info.sat : Number(info.sat || 0),
        content_type: info.content_type || 'text/plain',
        content_url: contentUrl
      };
    } catch (err: any) {
      // Log error for debugging but re-throw for caller to handle
      console.warn(`Failed to resolve inscription ${inscriptionId}:`, err.message || String(err));
      throw new Error(`Failed to resolve inscription: ${inscriptionId}`);
    }
  }

  async getMetadata(inscriptionId: string): Promise<any> {
    return this.client.getMetadata(inscriptionId);
  }

  /**
   * fetchFn for BtcoDidResolver: fetches inscription content while enforcing
   * the same-origin pin a second time (defense in depth — resolveInscription
   * already validated the URL it minted) and refusing to follow redirects, so
   * a same-origin URL cannot 30x-redirect resolution to an internal host.
   * Off-origin or non-http(s) URLs fail closed without any network request.
   */
  fetchContent = async (url: string, init?: { signal?: AbortSignal }): Promise<Response> => {
    let resolvedUrl: string;
    try {
      resolvedUrl = resolveSameOrigin(url, (this.config.baseUrl || '').replace(/\/$/, ''));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve(message)
      } as unknown as Response;
    }
    const fetchFn = this.config.fetchFn || fetch;
    // Fetch the resolved absolute form: server-side fetch() rejects relative
    // URLs, and resolveSameOrigin has already pinned it to baseUrl's origin.
    return fetchFn(resolvedUrl, { redirect: 'error', signal: init?.signal });
  };
}

export default OrdinalsClientProviderAdapter;
