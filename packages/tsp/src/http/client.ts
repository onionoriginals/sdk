const TSP_CONTENT_TYPE = 'application/tsp+cesr';

export async function postTspWire(
  transportUrl: string,
  wire: Uint8Array,
  options?: { fetch?: typeof fetch; signal?: AbortSignal },
): Promise<void> {
  const fetchFn = options?.fetch ?? globalThis.fetch;
  if (!fetchFn) throw new Error('fetch is not available');
  const res = await fetchFn(transportUrl, {
    method: 'POST',
    headers: {
      'Content-Type': TSP_CONTENT_TYPE,
      Accept: TSP_CONTENT_TYPE,
    },
    body: wire,
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(`TSP HTTP POST failed (${res.status})`);
  }
}