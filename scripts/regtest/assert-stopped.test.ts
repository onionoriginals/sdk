import { test, expect } from 'bun:test';
import { assertEndpointStopped } from './assert-stopped';

test('a listener that never responds cannot count as a stopped endpoint', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  const endpoint = server.url.origin;
  try {
    await expect(assertEndpointStopped(endpoint, 50)).rejects.toBeInstanceOf(DOMException);
  } finally { server.stop(true); }
  await expect(assertEndpointStopped(endpoint)).resolves.toBeUndefined();
});

test('an HTTP response also fails the stopped-endpoint check', async () => {
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:() => new Response('alive')});
  try {
    await expect(assertEndpointStopped(server.url.origin)).rejects.toThrow('still accepts connections');
  } finally { server.stop(true); }
});


test('a redirect to a closed port cannot hide a live original endpoint', async () => {
  const target = Bun.serve({hostname:'127.0.0.1',port:0,fetch:() => new Response('target')});
  const location = target.url.origin;
  const server = Bun.serve({hostname:'127.0.0.1',port:0,
    fetch:() => new Response(null, {status:302,headers:{location}})});
  target.stop(true);
  try {
    await expect(assertEndpointStopped(server.url.origin)).rejects.toThrow('still accepts connections');
  } finally { server.stop(true); }
});
