import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { startCallbackServer } from '../src/oauth.js';

// Does this machine have an IPv6 loopback? (Some CI runners and containers do not.)
const hasV6 = await new Promise(done => {
  const probe = net.createServer();
  probe.once('error', () => done(false));
  probe.listen(0, '::1', () => probe.close(() => done(true)));
});

// Claude's registered redirect is http://localhost:<port>/callback; the browser may resolve it to
// 127.0.0.1 or ::1, so the loopback-only listener answers on both and on nothing else.
for (const address of ['127.0.0.1', '[::1]']) {
  test(`the Claude callback is answered on ${address}`, { skip: address === '[::1]' && !hasV6 && 'no IPv6 loopback here' }, async () => {
    const { port, codePromise, server, v6 } = await startCallbackServer('s');
    try {
      assert.equal(server.address().address, '127.0.0.1');
      if (hasV6) {
        assert.equal(v6.address().address, '::1');
        assert.equal(v6.address().port, port);
      } else {
        assert.equal(v6, undefined, 'without ::1 the IPv4 listener carries on alone');
      }
      const res = await fetch(`http://${address}:${port}/callback?code=c-1&state=s`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(await codePromise, 'c-1');
    } finally {
      server.close();
      if (v6) await once(v6, 'close');
    }
  });
}

test('a non-127.0.0.1 host is bound alone (no ::1 twin)', async () => {
  const { server, v6 } = await startCallbackServer('s', { host: 'localhost' });
  assert.equal(v6, undefined);
  server.close();
});
