import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startCallbackServer } from '../src/oauth.js';

// Claude's registered redirect is http://localhost:<port>/callback; the browser may resolve it to
// 127.0.0.1 or ::1, so the loopback-only listener answers on both and on nothing else.
for (const address of ['127.0.0.1', '[::1]']) {
  test(`the Claude callback is answered on ${address}`, async () => {
    const { port, codePromise, server, v6 } = await startCallbackServer('s');
    try {
      assert.equal(server.address().address, '127.0.0.1');
      assert.equal(v6.address().address, '::1');
      assert.equal(v6.address().port, port);
      const res = await fetch(`http://${address}:${port}/callback?code=c-1&state=s`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(await codePromise, 'c-1');
    } finally {
      server.close();
      await once(v6, 'close');
    }
  });
}

test('a non-127.0.0.1 host is bound alone (no ::1 twin)', async () => {
  const { server, v6 } = await startCallbackServer('s', { host: '::1' });
  assert.equal(v6, undefined);
  server.close();
});
