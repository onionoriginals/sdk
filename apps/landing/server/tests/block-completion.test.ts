import { expect, test } from 'bun:test';
import { startBlockCompletion } from '../block-completion';
import { createInscriptionCompletionSweep } from '../inscription-completion-sweep';
import type { InscriptionRecord } from '../inscriptions-store';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function harness(complete = async () => {}) {
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, { fn: () => void; delay: number }>();
  const errors: unknown[] = [];
  let id = 0;
  const listener = startBlockCompletion({
    url: 'wss://secret@example.test/ws', complete, onError: e => errors.push(e),
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    setTimer: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    clearTimer: key => { timers.delete(key as number); },
  });
  const tick = () => {
    const entry = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0];
    if (!entry) throw new Error('No timer');
    timers.delete(entry[0]); entry[1].fn();
  };
  return { listener, sockets, timers, errors, tick };
}
class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.onclose?.(); }
  block(id: string) { this.onmessage?.({ data: JSON.stringify({ block: { id } }) }); }
}

test('subscribes only to blocks, catches up, validates and deduplicates block ids', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; });
  const s = h.sockets[0];
  s.onopen!(); await flush();
  expect(s.sent).toEqual([JSON.stringify({ action: 'want', data: ['blocks'] })]);
  expect(calls).toBe(1);
  for (const data of ['no json', 'null', '{}', '{"block":{"id":123}}']) s.onmessage!({ data });
  s.block('not-a-hash'); await flush(); expect(calls).toBe(1);
  s.block('a'.repeat(64)); await flush();
  s.block('A'.repeat(64)); await flush(); expect(calls).toBe(2);
  s.block('b'.repeat(64)); await flush(); expect(calls).toBe(3);
  h.listener.stop(); expect(h.timers.size).toBe(0);
});

test('coalesces requests during a pass, serializes followup, and stops pending work', async () => {
  let calls = 0;
  let release!: () => void;
  const h = harness(async () => { calls++; await new Promise<void>(r => { release = r; }); });
  const first = h.listener.request(); await flush();
  const second = h.listener.request(); void h.listener.request();
  expect(calls).toBe(1);
  release(); await flush(); expect(calls).toBe(2);
  void h.listener.request(); h.listener.stop(); release();
  await Promise.all([first, second]); expect(calls).toBe(2);
  await h.listener.request(); expect(calls).toBe(2);
});

test('reconnects after close and heartbeat timeout and catches up on reconnect', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; });
  h.sockets[0].onopen!(); await flush();
  h.tick(); expect(JSON.parse(h.sockets[0].sent[1])).toEqual({ action: 'ping' });
  h.tick(); expect(h.sockets[0].closed).toBe(true);
  h.tick(); expect(h.sockets.length).toBe(2);
  h.sockets[1].onopen!(); await flush(); expect(calls).toBe(2);
  h.sockets[1].onclose!(); h.tick(); expect(h.sockets.length).toBe(3);
  h.listener.stop(); expect(h.timers.size).toBe(0);
  h.sockets[2].block('c'.repeat(64)); await flush(); expect(calls).toBe(2);
});

test.each([true, 'true'])('pong %j keeps a healthy connection alive without extra sweeps', async pong => {
  let calls = 0;
  const h = harness(async () => { calls++; });
  const socket = h.sockets[0];
  socket.onopen!(); await flush();
  for (let i = 0; i < 3; i++) {
    h.tick();
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ action: 'ping' });
    socket.onmessage!({ data: JSON.stringify({ pong }) });
    expect([...h.timers.values()].map(timer => timer.delay)).toEqual([30_000]);
  }
  await flush();
  expect(socket.closed).toBe(false);
  expect(h.sockets.length).toBe(1);
  expect(calls).toBe(1);
  expect(h.errors).toEqual([]);
  h.listener.stop();
});

test.each([false, 'false', 1, null])('invalid pong %j does not cancel the heartbeat timeout', pong => {
  const h = harness();
  const socket = h.sockets[0];
  socket.onopen!(); h.tick();
  socket.onmessage!({ data: JSON.stringify({ pong }) });
  h.tick();
  expect(socket.closed).toBe(true);
  h.listener.stop();
});

test('pong keeps the connection alive; failures are handled without exposing URL credentials', async () => {
  const h = harness(async () => { throw new Error('wss://secret@example.test/ws'); });
  h.sockets[0].onopen!(); await flush();
  h.tick(); h.sockets[0].onmessage!({ data: '{"pong":true}' });
  h.tick(); expect(h.sockets[0].closed).toBe(false);
  h.sockets[0].onerror!();
  expect(String(h.errors[0])).toContain('Inscription completion pass failed');
  expect(String(h.errors.at(-1))).toContain('Bitcoin block feed unavailable');
  expect(h.errors.map(String).join()).not.toContain('secret');
  h.listener.stop();
});

test('real WebSocket block checks commit confirmation and broadcasts persisted reveal', async () => {
  let peer: { send(data: string): unknown } | undefined;
  let subscribed = false;
  let confirmed = false;
  let checks = 0;
  const pushed: string[] = [];
  const record = { commitTxId: 'c'.repeat(64), revealTxId: 'd'.repeat(64), revealTxHex: '0200000000', status: 'commit_broadcast' } as InscriptionRecord;
  const complete = createInscriptionCompletionSweep({
    store: {
      pendingRevealBroadcasts: () => ({ pending: record.status === 'commit_broadcast' ? [{ subOrgId: 'creator', record }] : [], unreadable: [] }),
      setStatus: (_sub, _tx, status) => { record.status = status; },
    },
    provider: {
      getTransactionStatus: async () => { checks++; return { confirmed }; },
      broadcastTransaction: async hex => { pushed.push(hex); return record.revealTxId; },
    }, moneyLog: () => {},
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response('upgrade required', { status: 400 }); },
    websocket: {
      open(ws) { peer = ws; },
      message(_ws, message) { subscribed = String(message) === JSON.stringify({ action: 'want', data: ['blocks'] }); },
    },
  });
  const errors: unknown[] = [];
  const listener = startBlockCompletion({ url: `ws://127.0.0.1:${server.port}`, complete, onError: e => errors.push(e) });
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!condition() && Date.now() < deadline) await Bun.sleep(5);
    expect(condition()).toBe(true);
  };
  try {
    await until(() => subscribed && checks === 1);
    expect(pushed).toEqual([]);
    confirmed = true;
    peer!.send(JSON.stringify({ block: { id: 'f'.repeat(64) } }));
    await until(() => record.status === 'reveal_broadcast');
    expect(checks).toBe(2); expect(pushed).toEqual(['0200000000']); expect(errors).toEqual([]);
  } finally { listener.stop(); await server.stop(true); }
});

test('disabled listener still accepts startup and fallback sweep requests', async () => {
  let calls = 0;
  const listener = startBlockCompletion({ complete: async () => { calls++; }, onError: () => {} });
  await listener.request(); await listener.request();
  expect(calls).toBe(2);
  listener.stop(); await listener.request(); expect(calls).toBe(2);
});

test('stalled handshakes retry with bounded backoff and stop cancels retry', () => {
  const h = harness();
  const delays: number[] = [];
  for (let i = 0; i < 9; i++) {
    h.tick(); // handshake timeout
    delays.push([...h.timers.values()][0].delay);
    h.tick(); // reconnect
  }
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  h.sockets.at(-1)!.onclose!();
  h.listener.stop(); expect(h.timers.size).toBe(0);
});
