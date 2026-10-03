import assert from 'node:assert/strict';
import { assertEndpointStopped } from './assert-stopped';

// Run as a plain Bun script so SDK test preloads cannot replace native fetch.
const scenario = process.argv[2];
let ran = false;
async function runScenario(name: string, run: () => Promise<void>) {
  if (name !== scenario) return;
  ran = true;
  await run();
}

await runScenario('a listener that never responds cannot count as a stopped endpoint', async () => {
  let requests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: () => {
      requests++;
      return new Promise<Response>(() => {});
    },
  });
  const endpoint = server.url.origin;
  try {
    await assert.rejects(assertEndpointStopped(endpoint, 250), DOMException);
    assert.ok(requests > 0, 'the hanging listener must receive a real request');
  } finally { server.stop(true); }
  await assert.doesNotReject(assertEndpointStopped(endpoint));
});

await runScenario('an HTTP response also fails the stopped-endpoint check', async () => {
  let requests = 0;
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:() => {
    requests++;
    return new Response('alive');
  }});
  try {
    await assert.rejects(assertEndpointStopped(server.url.origin), /still accepts connections/);
    assert.ok(requests > 0, 'the live listener must receive a real request');
  } finally { server.stop(true); }
});

await runScenario('a redirect to a closed port cannot hide a live original endpoint', async () => {
  let requests = 0;
  const target = Bun.serve({hostname:'127.0.0.1',port:0,fetch:() => new Response('target')});
  const location = target.url.origin;
  const server = Bun.serve({hostname:'127.0.0.1',port:0,
    fetch:() => {
      requests++;
      return new Response(null, {status:302,headers:{location}});
    }});
  target.stop(true);
  try {
    await assert.rejects(assertEndpointStopped(server.url.origin), /still accepts connections/);
    assert.ok(requests > 0, 'the live listener must receive a real request');
  } finally { server.stop(true); }
});

assert.ok(ran, `Unknown network scenario: ${scenario}`);
