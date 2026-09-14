import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createBitcoinCoreChainValidator } from '../packages/sdk/dist/index.js';
test('Node fetch authenticates a Core RPC endpoint using headers', async () => {
  const hash = 'a'.repeat(64); let requests = 0;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Basic dXNlcjpwYXNz');
    let body = ''; req.on('data', data => { body += data; });
    req.on('end', () => { assert.equal(JSON.parse(body).method, 'getblockchaininfo'); requests++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: { chain: 'regtest', blocks: 0, bestblockhash: hash }, error: null })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    await createBitcoinCoreChainValidator({ endpoint, rpcAuth: { username: 'user', password: 'pass' } })({
      network: 'regtest', tipBefore: { height: 0, hash }, tipAfter: { height: 0, hash }, blocks: [] });
    assert.equal(requests, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
