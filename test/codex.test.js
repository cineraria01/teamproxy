import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import {
  buildCodexProxyArgs,
  resolveCodexRouter,
  codexCliNotFoundMessage,
  importCodexCredentials,
  refreshCodexAccessToken,
  resolveCodexCliBin,
} from '../src/codex.js';

function jwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.signature`;
}

test('importCodexCredentials parses the official Codex auth.json shape', async () => {
  // Given
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-auth-'));
  const authPath = join(dir, 'auth.json');
  const expiresAt = 1_900_000_000;
  await writeFile(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({
        email: 'codex@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'account-from-id-token',
          chatgpt_plan_type: 'pro',
        },
      }),
      access_token: jwt({
        exp: expiresAt,
        'https://api.openai.com/profile': { email: 'codex@example.com' },
      }),
      refresh_token: 'refresh-token',
      account_id: 'account-from-auth-json',
    },
  }));

  try {
    // When
    const credentials = await importCodexCredentials(authPath);

    // Then
    assert.deepEqual(credentials, {
      accessToken: jwt({
        exp: expiresAt,
        'https://api.openai.com/profile': { email: 'codex@example.com' },
      }),
      refreshToken: 'refresh-token',
      idToken: jwt({
        email: 'codex@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'account-from-id-token',
          chatgpt_plan_type: 'pro',
        },
      }),
      accountId: 'account-from-auth-json',
      accountUuid: 'account-from-auth-json',
      email: 'codex@example.com',
      planType: 'pro',
      expiresAt: expiresAt * 1000,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refreshCodexAccessToken uses the official Codex refresh contract', async () => {
  // Given
  let received;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      method: req.method,
      contentType: req.headers['content-type'],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      access_token: jwt({ exp: 1_900_000_100 }),
      refresh_token: 'next-refresh-token',
      id_token: jwt({
        email: 'next@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: 'next-account' },
      }),
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/oauth/token`;

  try {
    // When
    const refreshed = await refreshCodexAccessToken('old-refresh-token', endpoint);

    // Then
    assert.deepEqual(received, {
      method: 'POST',
      contentType: 'application/json',
      body: {
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        grant_type: 'refresh_token',
        refresh_token: 'old-refresh-token',
      },
    });
    assert.equal(refreshed.refreshToken, 'next-refresh-token');
    assert.equal(refreshed.accountId, 'next-account');
    assert.equal(refreshed.email, 'next@example.com');
    assert.equal(refreshed.expiresAt, 1_900_000_100_000);
  } finally {
    server.close();
  }
});

test('buildCodexProxyArgs uses a login-free HTTP-only local provider', () => {
  // Given
  const userArgs = ['exec', '--json', 'say hello'];

  // When
  const args = buildCodexProxyArgs(4567, userArgs);

  // Then
  assert.deepEqual(args.slice(-3), userArgs);
  assert.equal(args[0], '-c');
  assert.equal(args[1], 'model_provider="teamcodex_proxy"');
  assert.equal(args[2], '-c');
  assert.match(args[3], /base_url = "http:\/\/127\.0\.0\.1:4567\/codex"/);
  assert.match(args[3], /requires_openai_auth = false/);
  assert.match(args[3], /supports_websockets = false/);
  assert.doesNotMatch(args[3], /env_key/);
  // image_gen is only offered to an OpenAI-auth or actor-authorized provider
  assert.match(args[3], /http_headers = \{ "x-openai-actor-authorization" = "teamcodex" \}/);
  assert.equal(args.some(arg => arg.startsWith('chatgpt_base_url=')), false);
});

test('resolveCodexCliBin prefers env override, then the node-sibling CLI, then PATH', () => {
  // Given: an explicit override always wins
  assert.equal(
    resolveCodexCliBin({
      env: { TEAMCODEX_CODEX_BIN: '/opt/custom/codex' },
      execPath: '/nodes/v24/bin/node',
      exists: () => true,
    }),
    '/opt/custom/codex',
  );

  // Given: no override — the CLI co-installed with this Node beats a PATH
  // lookup that a shell wrapper/symlink may shadow
  assert.equal(
    resolveCodexCliBin({
      env: {},
      execPath: '/nodes/v24/bin/node',
      exists: p => p === join('/nodes/v24/bin', 'codex'),
    }),
    join('/nodes/v24/bin', 'codex'),
  );

  // Given: neither — bare PATH lookup is the legacy fallback
  assert.equal(
    resolveCodexCliBin({ env: {}, execPath: '/nodes/v24/bin/node', exists: () => false }),
    'codex',
  );

  // Given: win32 — the extension-less sibling is npm's unspawnable POSIX shim,
  // so the bare lookup (which resolves codex.exe) must win
  assert.equal(
    resolveCodexCliBin({
      env: {},
      execPath: 'C:\\nodejs\\node.exe',
      exists: p => p === 'C:\\nodejs\\codex',
      platform: 'win32',
    }),
    'codex',
  );

  // Given: win32 with @openai/codex installed beside node.exe — its native codex.exe, per arch
  // (layout checked against an installed @openai/codex tree: <pkg>/node_modules/@openai/codex-<plat>/vendor/<triple>/bin/codex)
  for (const [arch, plat, triple] of [['x64', 'x64', 'x86_64-pc-windows-msvc'], ['arm64', 'arm64', 'aarch64-pc-windows-msvc']]) {
    const m = 'C:\\nodejs\\node_modules\\@openai';
    const nested = `${m}\\codex\\node_modules\\@openai\\codex-win32-${plat}\\vendor\\${triple}\\bin\\codex.exe`;
    const hoisted = `${m}\\codex-win32-${plat}\\vendor\\${triple}\\bin\\codex.exe`;
    const legacy = `${m}\\codex\\vendor\\${triple}\\bin\\codex.exe`;
    for (const exe of [nested, hoisted, legacy]) {
      assert.equal(
        resolveCodexCliBin({ env: {}, execPath: 'C:\\nodejs\\node.exe', exists: p => p === exe, platform: 'win32', arch }),
        exe,
      );
    }
    assert.equal(resolveCodexCliBin({ env: {}, execPath: 'C:\\nodejs\\node.exe', exists: () => true, platform: 'win32', arch }), nested);
  }
  // and TEAMCODEX_CODEX_BIN still wins on win32
  assert.equal(
    resolveCodexCliBin({ env: { TEAMCODEX_CODEX_BIN: 'D:\\c\\codex.exe' }, execPath: 'C:\\nodejs\\node.exe', exists: () => true, platform: 'win32' }),
    'D:\\c\\codex.exe',
  );
});

test('codexCliNotFoundMessage names the resolved binary and the override source', () => {
  assert.equal(
    codexCliNotFoundMessage('codex', {}),
    'Codex CLI not found in PATH. Install it first.',
  );
  assert.equal(
    codexCliNotFoundMessage('/opt/custom/codex', { TEAMCODEX_CODEX_BIN: '/opt/custom/codex' }),
    'Codex CLI not found at /opt/custom/codex — check TEAMCODEX_CODEX_BIN.',
  );
  assert.equal(
    codexCliNotFoundMessage('/nodes/v24/bin/codex', {}),
    'Codex CLI not found at /nodes/v24/bin/codex. Install it first.',
  );
});

test('buildCodexProxyArgs router mode points Codex at the router capability URL, login-free', () => {
  // Given
  const userArgs = ['exec', 'say hello'];
  const routerBaseUrl = 'http://127.0.0.1:4202/_codex-router/caller-key/v1';

  // When
  const args = buildCodexProxyArgs(4567, userArgs, { routerBaseUrl });

  // Then: same provider id, so nothing else about the launch changes
  assert.deepEqual(args.slice(-2), userArgs);
  assert.equal(args[1], 'model_provider="teamcodex_proxy"');
  assert.match(args[3], /base_url = "http:\/\/127\.0\.0\.1:4202\/_codex-router\/caller-key\/v1"/);
  assert.doesNotMatch(args[3], /4567\/codex/);
  // Never the ChatGPT login and never an env_key bearer: the router ignores
  // the bearer once the capability is in the path, and a signed-in Codex sends
  // its own session token for native GPT models regardless of env_key.
  assert.match(args[3], /requires_openai_auth = false/);
  assert.doesNotMatch(args[3], /env_key/);
  assert.match(args[3], /X-TeamCodex-Invocation/);
  // The router answers a bearer-less image request with native_session_required,
  // so router mode carries a placeholder the pool replaces.
  assert.match(args[3], /http_headers = \{ "x-openai-actor-authorization" = "teamcodex", "authorization" = "Bearer teamcodex-pool" \}/);

  // And: the plain pool launch is unchanged and sends no placeholder bearer
  assert.match(buildCodexProxyArgs(4567, userArgs)[3], /base_url = "http:\/\/127\.0\.0\.1:4567\/codex"/);
  assert.doesNotMatch(buildCodexProxyArgs(4567, userArgs)[3], /"authorization"/);
});

test('resolveCodexRouter is off by default and embeds the caller key from config, env, or file', () => {
  const key = () => 'caller-key-from-file';

  // Given: nothing configured
  assert.equal(resolveCodexRouter({}, {}, key), null);
  assert.equal(resolveCodexRouter({ codexRouter: { enabled: false, baseUrl: 'http://127.0.0.1:4202/v1' } }, {}, key), null);

  // Given: config on — the key comes from the router's caller-secret file and lands in the path
  assert.deepEqual(
    resolveCodexRouter({ codexRouter: { enabled: true, baseUrl: 'http://127.0.0.1:4202/v1/' } }, {}, key),
    { baseUrl: 'http://127.0.0.1:4202/_codex-router/caller-key-from-file/v1', callerKey: 'caller-key-from-file' },
  );
  assert.equal(
    resolveCodexRouter({ codexRouter: 'http://localhost:4202/v1' }, {}, key).baseUrl,
    'http://localhost:4202/_codex-router/caller-key-from-file/v1',
  );

  // Given: an explicit key file path, with ~ expanded
  const seen = [];
  resolveCodexRouter(
    { codexRouter: { baseUrl: 'http://127.0.0.1:4202/v1', callerKeyFile: '~/x/caller-secret' } },
    {},
    p => { seen.push(p); return 'k'; },
  );
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0], /^~/);
  assert.match(seen[0], /\/x\/caller-secret$/);

  // Given: a key already in the environment wins over the file
  assert.equal(
    resolveCodexRouter({ codexRouter: 'http://127.0.0.1:4202/v1' }, { TEAMCODEX_ROUTER_KEY: 'from-env' }, () => { throw new Error('must not read'); }).baseUrl,
    'http://127.0.0.1:4202/_codex-router/from-env/v1',
  );

  // Given: env URL wins over config, and "off" disables
  assert.equal(
    resolveCodexRouter({ codexRouter: { baseUrl: 'http://127.0.0.1:4202/v1' } }, { TEAMCODEX_CODEX_ROUTER_URL: 'off' }, key),
    null,
  );
  assert.equal(
    resolveCodexRouter({}, { TEAMCODEX_CODEX_ROUTER_URL: 'http://127.0.0.1:9999/v1' }, key).baseUrl,
    'http://127.0.0.1:9999/_codex-router/caller-key-from-file/v1',
  );

  // Given: a missing key file is a loud failure, not a silent 401 later
  assert.throws(() => resolveCodexRouter({ codexRouter: 'http://127.0.0.1:4202/v1' }, {}, () => ''), /caller key not found/);

  // Given: anything that would carry the key off-box is refused
  assert.throws(() => resolveCodexRouter({ codexRouter: 'https://example.com/v1' }, {}, key), /loopback/);
  assert.throws(() => resolveCodexRouter({ codexRouter: 'http://10.0.0.5:4202/v1' }, {}, key), /loopback/);
  assert.throws(() => resolveCodexRouter({ codexRouter: 'not a url' }, {}, key), /valid URL/);
});
