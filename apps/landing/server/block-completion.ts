/** Wake the persisted-reveal sweep on Bitcoin blocks, retaining an offline request path. */
interface BlockSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
interface BlockCompletionOptions {
  url?: string;
  complete: () => Promise<unknown>;
  onError: (error: Error) => void;
  createSocket?: (url: string) => BlockSocket;
  setTimer?: (fn: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export function startBlockCompletion(options: BlockCompletionOptions) {
  const schedule = options.setTimer ?? ((fn, delay) => setTimeout(fn, delay));
  const cancel = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const createSocket = options.createSocket ?? (url => new WebSocket(url) as unknown as BlockSocket);
  let stopped = false;
  let pending = false;
  let active: Promise<void> | undefined;
  let socket: BlockSocket | undefined;
  let timer: unknown;
  let retryMs = 1000;
  const seen = new Set<string>();
  const report = (kind: 'connection' | 'completion' = 'connection') => {
    // Socket errors can contain credentials from the configured endpoint.
    try {
      options.onError(new Error(kind === 'connection'
        ? 'Bitcoin block feed unavailable; hourly completion remains active'
        : 'Inscription completion pass failed; retrying on the next block or hourly pass'));
    } catch {}
  };
  function request(): Promise<void> {
    if (stopped) return Promise.resolve();
    pending = true;
    if (!active) {
      // Defer execution so even a synchronous throw cannot race assignment.
      active = Promise.resolve().then(async () => {
        while (pending && !stopped) {
          pending = false;
          try { await options.complete(); } catch { report('completion'); }
        }
      }).finally(() => {
        active = undefined;
        // A request can arrive between the loop settling and this microtask.
        if (pending && !stopped) return request();
      });
    }
    return active;
  }
  function clear() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  }
  function disconnect(current: BlockSocket) {
    if (socket !== current) return;
    socket = undefined;
    clear();
    current.onopen = current.onmessage = current.onclose = current.onerror = null;
    try { current.close(); } catch {}
    reconnect();
  }
  function reconnect() {
    if (stopped) return;
    timer = schedule(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 60_000);
  }
  function heartbeat(current: BlockSocket) {
    clear();
    timer = schedule(() => {
      if (socket !== current || stopped) return;
      try { current.send(JSON.stringify({ action: 'ping' })); } catch { report(); disconnect(current); return; }
      timer = schedule(() => { report(); disconnect(current); }, 15_000);
    }, 30_000);
  }
  function connect() {
    timer = undefined;
    if (stopped || !options.url) return;
    let current: BlockSocket;
    try { current = createSocket(options.url); } catch { report(); reconnect(); return; }
    socket = current;
    // A TCP/WebSocket handshake can also stall without producing close/error.
    timer = schedule(() => { report(); disconnect(current); }, 15_000);
    current.onopen = () => {
      if (stopped || socket !== current) return;
      try { current.send(JSON.stringify({ action: 'want', data: ['blocks'] })); }
      catch { report(); disconnect(current); return; }
      heartbeat(current);
      void request(); // Recover blocks missed while disconnected.
    };
    current.onmessage = event => {
      if (stopped || socket !== current || typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (message.pong === true || message.pong === 'true') { retryMs = 1000; heartbeat(current); }
      const id = message.block?.id;
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/i.test(id)) return;
      retryMs = 1000;
      heartbeat(current);
      const normalized = id.toLowerCase();
      if (seen.has(normalized)) return;
      seen.add(normalized);
      if (seen.size > 144) seen.delete(seen.values().next().value!);
      void request();
    };
    current.onclose = () => disconnect(current);
    current.onerror = () => { report(); disconnect(current); };
  }
  connect();
  return {
    request,
    stop() {
      stopped = true;
      pending = false;
      clear();
      if (socket) disconnect(socket);
    },
  };
}
