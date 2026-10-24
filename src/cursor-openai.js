import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cursorCliNotFoundMessage, resolveCursorBin } from './cursor.js';

// OpenAI-compatible surface on the Cursor pool (`/openai/v1/models`, `/openai/v1/chat/completions`) for
// local apps that speak OpenAI (Selvi). Cursor has no public inference API — its agent stream is a private
// protobuf protocol — so each completion runs `cursor-agent -p --mode ask` through this pool's lane and
// maps the reply. Tool calls are asked for as JSON in the prompt and parsed back. Facts and decisions:
// docs/specs/2026-10-25-cursor-openai.md.

export const CURSOR_OPENAI_PREFIX = '/openai/v1';
// cursor-agent keeps the endpoint's path prefix, so the lane's own children are told apart by it.
export const CURSOR_LANE_PREFIX = '/teamcursor-lane';
// RPCs answered with an empty message on the lane: the account's plugins and skills would be downloaded
// into the lane home (164 MB, 4 minutes on the first run) and their hooks and rules would ride every turn; a team
// account's hooks and commands (`team-hooks-sync.ts`) would run their own commands in the lane with the prompt.
export const CURSOR_LANE_EMPTY_RPCS = new Set([
  '/aiserver.v1.DashboardService/GetEffectiveUserPlugins',
  '/aiserver.v1.DashboardService/ListMarketplaces',
  '/aiserver.v1.DashboardService/GetManagedSkills',
  '/aiserver.v1.DashboardService/GetTeamHooks',
  '/aiserver.v1.DashboardService/GetTeamCommands',
]);
// cursor-agent's hidden switches: no language server (an `npx typescript-language-server` per run, 5–50 s),
// no indexing, no self-update, no workspace rules.
export const CURSOR_LANE_FLAGS = ['--disable-codebase-ref', '--disable-indexing', '--disable-auto-update', '--disable-project-configs'];
// cursor-agent's own permission list in the lane home. Ask mode still reads any file on the machine (measured:
// Read and Grep returned a file outside the workspace), and a prompt carries text the app took from the web, so
// a prompt injection could ask for ~/.config/teamcursor.json. No reads, no writes, no shell (empty allowlist).
export const CURSOR_LANE_PERMISSIONS = Object.freeze({ allow: Object.freeze([]), deny: Object.freeze(['Read(**)', 'Write(**)']) });
const CURSOR_LANE_CONFIG = Object.freeze({ permissions: CURSOR_LANE_PERMISSIONS, approvalMode: 'allowlist', autoAcceptWebSearch: false });
// No matcher = every tool cursor-agent runs locally; exit code 2 = block (failClosed: a hook that cannot run blocks too).
export const CURSOR_LANE_HOOKS = Object.freeze({ version: 1, hooks: { preToolUse: [{ command: 'exit 2', failClosed: true }] } });
// First in /models (an OpenAI client takes the first model as its default): Cursor's own model answered text and
// tool calls in 4–7 s; `auto` may route to a model that refuses the JSON framing (measured with Claude Sonnet).
export const CURSOR_OPENAI_DEFAULT_MODEL = 'composer-2.5';
const MODELS_TTL_MS = 10 * 60 * 1000;
const CHAT_KEEP_MS = 60 * 60 * 1000;
// The same characters parseCursorModels lists (`\w` keeps `_`).
const MODEL_ID = /^[A-Za-z0-9][\w.:[\]=,-]*$/;

const stripAnsi = text => String(text || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** `{path, lane}`: the request path without the lane prefix, and whether it carried one (segment-exact). */
export function stripCursorLane(path) {
  const value = String(path || '/');
  if (value === CURSOR_LANE_PREFIX) return { path: '/', lane: true };
  if (value.startsWith(`${CURSOR_LANE_PREFIX}/`) || value.startsWith(`${CURSOR_LANE_PREFIX}?`)) {
    const rest = value.slice(CURSOR_LANE_PREFIX.length);
    return { path: rest.startsWith('?') ? `/${rest}` : rest, lane: true };
  }
  return { path: value, lane: false };
}

/** The supervisor's fence: lane paths are for this proxy's own children, never a remote peer. */
export function isCursorLanePath(path) {
  return stripCursorLane(path).lane;
}

export function isCursorOpenAIPath(path) {
  const pathname = String(path || '').split('?', 1)[0];
  return pathname === CURSOR_OPENAI_PREFIX || pathname.startsWith(`${CURSOR_OPENAI_PREFIX}/`);
}

/** An unsigned session-JWT look-alike for the lane's children: the proxy swaps every bearer for the account's. */
export function laneSessionToken(now = Date.now()) {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const sec = Math.floor(now / 1000);
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ sub: 'teamcursor|lane', type: 'session', time: String(sec), exp: sec + 365 * 24 * 3600 })}.lane`;
}

/** `cursor-agent --list-models` text → `[{id, name}]`, CURSOR_OPENAI_DEFAULT_MODEL moved first when listed. */
export function parseCursorModels(text) {
  const models = [];
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9][\w.:[\]=,-]*)\s+-\s+(.+?)\s*$/.exec(line);
    if (match) models.push({ id: match[1], name: match[2].replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim() });
  }
  const first = models.findIndex(model => model.id === CURSOR_OPENAI_DEFAULT_MODEL);
  if (first > 0) models.unshift(...models.splice(first, 1));
  return models;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  let images = 0;
  const texts = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    else if (part?.type === 'image_url' || part?.type === 'input_image') images += 1;
  }
  if (images) texts.push(`[${images} image(s) omitted: this connection cannot send images]`);
  return texts.join('\n\n');
}

function parsedArguments(raw) {
  if (typeof raw !== 'string') return raw ?? {};
  try { return JSON.parse(raw); } catch { return raw; }
}

/** OpenAI chat request → the one prompt cursor-agent gets on stdin. */
export function buildCursorPrompt(body) {
  const instructions = [];
  const conversation = [];
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const role = message?.role;
    if (role === 'system' || role === 'developer') {
      instructions.push(contentText(message.content));
    } else if (role === 'assistant') {
      const turn = { role };
      const text = contentText(message.content);
      if (text) turn.content = text;
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        turn.tool_calls = message.tool_calls.map(call => ({
          id: call?.id, name: call?.function?.name, arguments: parsedArguments(call?.function?.arguments),
        }));
      }
      conversation.push(turn);
    } else if (role === 'tool') {
      conversation.push({ role, tool_call_id: message.tool_call_id, content: contentText(message.content) });
    } else {
      conversation.push({ role: 'user', content: contentText(message?.content) });
    }
  }
  const choice = body?.tool_choice;
  const tools = choice === 'none' ? [] : (Array.isArray(body?.tools) ? body.tools : [])
    .filter(tool => tool?.type === 'function' && tool.function?.name)
    .map(tool => ({ name: tool.function.name, description: tool.function.description || '', parameters: tool.function.parameters ?? {} }));
  const forced = choice && typeof choice === 'object' ? choice.function?.name : null;
  const format = body?.response_format;
  const schema = format?.type === 'json_schema' ? format.json_schema?.schema : null;

  const lines = [
    'This turn is a structured-output task for the developer\'s own application. The application runs a chat model through you and needs your next reply as JSON it can parse. The workspace is irrelevant: do not read files or run commands, and do not add any preamble, header or explanation outside the JSON.',
    '',
  ];
  if (tools.length) {
    lines.push('The application offers the actions listed under <actions>. Choose the next step of the conversation below:');
    lines.push('- to use actions, reply exactly {"tool_calls":[{"name":"<action>","arguments":{...}}]} (arguments must match the action\'s JSON schema; several calls allowed)');
    if (forced) lines.push(`- this turn you must call the action "${forced}"`);
    else if (choice === 'required') lines.push('- this turn you must call at least one action');
    else lines.push('- to reply with text, reply exactly {"content":"<text>"}');
  } else {
    lines.push('Reply exactly {"content":"<text>"} with the assistant\'s next message.');
  }
  if (format?.type === 'json_object') lines.push('- the text in "content" must itself be a JSON object, as a string');
  if (schema) lines.push(`- the text in "content" must itself be JSON matching this schema, as a string: ${promptJson(schema)}`);
  lines.push('');
  if (instructions.length) lines.push('<instructions>', instructions.join('\n\n'), '</instructions>', '');
  if (tools.length) lines.push('<actions>', promptJson(tools), '</actions>', '');
  lines.push('<conversation>', promptJson(conversation), '</conversation>', '', 'Your reply (JSON only):');
  return lines.join('\n');
}

// JSON with `<` as < (the same value): text in the conversation cannot close or open a prompt tag.
const promptJson = value => JSON.stringify(value).replace(/</g, '\\u003c');

// At most this many balanced `{…}` spans are tried with JSON.parse (each try is linear in the span).
const JSON_CANDIDATES = 64;

/**
 * The JSON objects among text's top-level balanced `{…}` spans, last first (lazily). One pass: quotes count only
 * inside braces, so a stray `"` in a header outside them changes nothing; a span inside another closed span is not
 * top level (an unclosed `{` encloses nothing). Last first: the model's own answer follows anything it quoted. Linear
 * in the text plus at most JSON_CANDIDATES parses — the per-`{` rescan this replaces was quadratic (80 000 `{` took
 * 5 s and held the worker's event loop).
 */
function* jsonObjects(text) {
  const spans = [];
  const open = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '{') open.push(i);
    else if (!open.length) continue;
    else if (ch === '"') inString = true;
    else if (ch === '}') spans.push([open.pop(), i + 1]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const top = [];
  let coveredTo = -1;
  for (const span of spans) {
    if (span[0] < coveredTo) continue;
    top.push(span);
    coveredTo = span[1];
  }
  for (const [start, end] of top.slice(-JSON_CANDIDATES).reverse()) {
    let value;
    try { value = JSON.parse(text.slice(start, end)); } catch { continue; /* not JSON */ }
    yield value;
  }
}

/**
 * cursor-agent's reply text → `{content}` or `{toolCalls: [{name, arguments}]}`. Text around the JSON (a
 * rule-driven header, code fences) is dropped; calls to actions that were not offered are ignored; a reply
 * with no usable JSON is the text itself.
 */
export function parseCursorReply(text, toolNames = []) {
  const raw = stripAnsi(text).trim();
  const offered = new Set(toolNames);
  for (const value of jsonObjects(raw)) {
    if (Array.isArray(value?.tool_calls)) {
      const calls = value.tool_calls
        .filter(call => typeof call?.name === 'string' && offered.has(call.name))
        .map(call => ({ name: call.name, arguments: call.arguments ?? {} }));
      if (calls.length) return { toolCalls: calls };
    }
    const content = value?.content;
    if (Object.keys(value ?? {}).length <= 2 && (typeof content === 'string' || (content && typeof content === 'object'))) {
      // A JSON answer the model put in as an object instead of a string still reaches the client as JSON text.
      return { content: typeof content === 'string' ? content : JSON.stringify(content) };
    }
  }
  return { content: raw };
}

function usageOf(result) {
  const usage = result?.usage || {};
  const cached = (Number(usage.cacheReadTokens) || 0);
  const prompt = (Number(usage.inputTokens) || 0) + cached + (Number(usage.cacheWriteTokens) || 0);
  const completion = Number(usage.outputTokens) || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cached } };
}

/** The OpenAI `chat.completion` object for a parsed reply. */
export function chatCompletion({ id, created, model, reply, usage }) {
  const message = { role: 'assistant', content: reply.toolCalls ? null : reply.content };
  if (reply.toolCalls) {
    message.tool_calls = reply.toolCalls.map(call => ({
      id: `call_${randomBytes(12).toString('hex')}`, type: 'function',
      function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) },
    }));
  }
  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, finish_reason: reply.toolCalls ? 'tool_calls' : 'stop' }],
    usage,
  };
}

/** The same completion as Chat Completions SSE: one delta, the finish, usage when asked, `[DONE]`. */
export function chatCompletionSse(completion, includeUsage) {
  const { id, created, model } = completion;
  const choice = completion.choices[0];
  const delta = { role: 'assistant' };
  if (choice.message.tool_calls) delta.tool_calls = choice.message.tool_calls.map((call, index) => ({ index, ...call }));
  else delta.content = choice.message.content;
  const chunk = (choices, extra = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`;
  let out = chunk([{ index: 0, delta, finish_reason: null }]) + chunk([{ index: 0, delta: {}, finish_reason: choice.finish_reason }]);
  if (includeUsage) out += chunk([], { usage: completion.usage });
  return `${out}data: [DONE]\n\n`;
}

/** An OpenAI error status for a failed cursor-agent run (used when the pool itself looks fine). */
export function classifyCursorRunFailure(message) {
  if (/resource_exhausted|usage limit|rate limit|too many requests|exhausted/i.test(message)) return { status: 429, type: 'insufficient_quota' };
  if (/unauthenticated|authentication|sign in|log ?in again|api key/i.test(message)) return { status: 401, type: 'authentication_error' };
  return { status: 502, type: 'upstream_error' };
}

/**
 * Why no completion can run, read from the pool: `{status, type, message, retryAfter?}` or null. Checked before
 * cursor-agent starts and after it fails, because the lane's dead end answers `resource_exhausted` for a pool
 * whose logins all expired (and an empty pool) — only the pool can tell those apart.
 */
export function cursorPoolProblem(accounts, now = Date.now()) {
  const enabled = (accounts || []).filter(account => account.enabled !== false);
  if (!enabled.length) {
    return { status: 401, type: 'authentication_error', message: 'TeamCursor has no enabled account. Sign in with `teamcursor login`.' };
  }
  const working = enabled.filter(account => account.status !== 'error' && !(account.expiresAt && account.expiresAt <= now));
  if (!working.length) {
    return { status: 401, type: 'authentication_error', message: 'No TeamCursor account is signed in and working: sign in again with `teamcursor login` (see `teamcursor status`).' };
  }
  const waits = working.map(account => (account.status === 'exhausted' ? Infinity : (account.rateLimitedUntil || 0) - now));
  if (waits.some(ms => ms <= 0)) return null;
  const finite = waits.filter(Number.isFinite);
  const retryAfter = finite.length ? Math.max(1, Math.ceil(Math.min(...finite) / 1000)) : 60;
  return { status: 429, type: 'insufficient_quota', message: `Every TeamCursor account is out of usage. Retry in ${retryAfter}s.`, retryAfter };
}

/**
 * The lane's own home: cursor-agent's settings, chats and caches live here, never in the user's ~/.cursor,
 * so the user's hooks, MCP servers and plugins stay out and the user's local login is not needed.
 */
export function prepareLaneHome(dir) {
  const home = join(dir, 'home');
  const workspace = join(dir, 'workspace');
  for (const path of [home, workspace, join(home, '.config'), join(home, '.cache'), join(home, '.local', 'share'), join(home, '.local', 'state')]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const readme = join(dir, 'README.txt');
  if (!existsSync(readme)) writeFileSync(readme, 'teamcursor OpenAI lane: cursor-agent home for /openai/v1 requests. Safe to delete while the proxy is idle (the next request rebuilds it).\n');
  return { home, workspace };
}

/**
 * Drop the lane's chats and transcripts older than an hour. cursor-agent keeps one of each per run (they hold
 * the prompts): `$XDG_CONFIG_HOME/cursor/chats/<workspace hash>/<chat>` and
 * `~/.cursor/projects/<workspace>/agent-transcripts/<chat>` (measured, cursor-agent 2026.10.22).
 */
export function pruneLaneChats(home, now = Date.now(), keepMs = CHAT_KEEP_MS) {
  const children = dir => {
    try { return readdirSync(dir).map(name => join(dir, name)); } catch { return []; }
  };
  const runs = [
    ...children(join(home, '.config', 'cursor', 'chats')).flatMap(children),
    ...children(join(home, '.cursor', 'projects')).flatMap(project => children(join(project, 'agent-transcripts'))),
  ];
  for (const path of runs) {
    try {
      if (now - statSync(path).mtimeMs > keepMs) rmSync(path, { recursive: true, force: true });
    } catch { /* raced with another run */ }
  }
}

function writeIfChanged(path, text) {
  try { if (readFileSync(path, 'utf8') === text) return; } catch { /* missing */ }
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Keep the lane's tool fence in place before every run (cursor-agent keeps what it finds there, measured):
 * - `cli-config.json`: CURSOR_LANE_PERMISSIONS, `approvalMode: allowlist`, `autoAcceptWebSearch: false` — print mode
 *   cannot approve, so web fetch/search answer "User Rejected" (measured; the fetch never left the machine);
 * - `~/.cursor/hooks.json`: a preToolUse hook that blocks every local tool (exit 2). The lane needs none, and it
 *   covers what permissions do not list — the local Fetch executor runs `fetch(url)` with no permission check.
 */
export function enforceLaneConfig(home) {
  const configDir = join(home, '.config', 'cursor');
  const configPath = join(configDir, 'cli-config.json');
  let config = {};
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch { /* none yet, or mid-write: ours is enough */ }
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeIfChanged(configPath, `${JSON.stringify({ version: 1, ...config, ...CURSOR_LANE_CONFIG }, null, 2)}\n`);
  mkdirSync(join(home, '.cursor'), { recursive: true, mode: 0o700 });
  writeIfChanged(join(home, '.cursor', 'hooks.json'), `${JSON.stringify(CURSOR_LANE_HOOKS, null, 2)}\n`);
}

// Parent variables a lane child keeps (case-insensitive; LC_* by prefix); everything else is dropped. cursor-agent
// reads 100+ CURSOR_* / AGENT_CLI_* / EXEC_DAEMON_* switches, and CURSOR_CONFIG_DIR / CURSOR_DATA_DIR win over
// HOME and XDG (cursor-config/dist/paths.js): inherited, they would move the lane's config and fence elsewhere.
const LANE_ENV_KEEP = new Set([
  'path', 'tmpdir', 'tmp', 'temp', 'lang', 'language', 'tz', 'user', 'logname', 'shell',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'node_extra_ca_certs', 'ssl_cert_file', 'ssl_cert_dir',
  'systemroot', 'systemdrive', 'windir', 'comspec', 'pathext', 'programdata', 'programfiles', 'programfiles(x86)',
  'programw6432', 'number_of_processors', 'processor_architecture', 'os', 'username', 'computername',
]);

export function laneEnv(env, { port, home, apiKey, platform = process.platform }) {
  const child = {};
  for (const [key, value] of Object.entries(env)) {
    const lower = key.toLowerCase();
    if (LANE_ENV_KEEP.has(lower) || lower.startsWith('lc_')) child[key] = value;
  }
  Object.assign(child, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    CURSOR_CONFIG_DIR: join(home, '.config', 'cursor'),
    CURSOR_DATA_DIR: join(home, '.cursor'),
    CURSOR_API_ENDPOINT: `http://localhost:${port}${CURSOR_LANE_PREFIX}`,
    CURSOR_API_KEY: apiKey,
    // Keep the exchanged lane token in memory. The default store on macOS runs `/usr/bin/security
    // add-generic-password -a cursor-user …` with HOME = the lane home, where macOS finds no keychain: it shows
    // "Keychain Not Found … 'cursor-user'" ([Cancel] [Reset To Defaults]) and the run waits 30 s for it. With
    // `memory` cursor-agent 2026.10.22 never runs `security` (its only keychain path; measured with a watcher).
    AGENT_CLI_CREDENTIAL_STORE: 'memory',
    DIRENV_DISABLE: '1',
    NO_COLOR: '1',
  });
  if (platform === 'win32') Object.assign(child, { USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') });
  return child;
}

// Every cursor-agent this process started and that has not closed yet. A worker that exits (restart, crash) kills
// them: otherwise they would run on unseen, spend the pool, and sit outside the next worker's concurrency cap.
// ponytail: a worker killed with SIGKILL runs no exit handler; its children finish (or time out) on their own.
const liveChildren = new Set();
let exitHookArmed = false;

/** SIGKILL every cursor-agent still running (the worker's exit hook). */
export function killLiveCursorAgents() {
  for (const live of liveChildren) {
    try { live.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function trackChild(child) {
  liveChildren.add(child);
  child.once('close', () => liveChildren.delete(child));
  if (exitHookArmed) return;
  exitHookArmed = true;
  process.once('exit', killLiveCursorAgents);
}

/**
 * Run cursor-agent once: `{code, stdout, stderr, timedOut, tooLarge, error}`. Killed on timeout, abort, or when
 * its output passes `maxOutputBytes` (stdout + stderr; a model answer is far smaller).
 */
export function runCursorAgent({ bin, args, env, cwd, input = '', timeoutMs, signal, spawn = nodeSpawn, maxOutputBytes = 16 * 1024 * 1024 }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(bin, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error });
      return;
    }
    trackChild(child);
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let tooLarge = false;
    let timedOut = false;
    let killTimer = null;
    const kill = () => {
      if (child.exitCode != null || child.signalCode != null) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    timer.unref?.();
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    const collect = into => chunk => {
      if (tooLarge) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        tooLarge = true;
        kill();
        return;
      }
      into.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', () => {});
    child.on('error', error => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      liveChildren.delete(child);
      resolve({ code: null, stdout: '', stderr: '', error });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut, tooLarge });
    });
    child.stdin.end(input);
  });
}

function sendJson(res, status, value, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

function sendError(res, status, type, message, headers) {
  sendJson(res, status, { error: { message, type, code: null } }, headers);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    // Read to the end even when too large, so the 413 reaches the client instead of a reset.
    req.on('end', () => (size > limit
      ? reject(Object.assign(new Error('Request body too large'), { status: 413 }))
      : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
    req.on('close', () => { if (!req.complete) reject(new Error('The client went away during the body')); });
  });
}

/**
 * The lane and the OpenAI surface for one Cursor pool. `port` is the pool's public port (the lane's children
 * dial it as `localhost`, which cursor-agent needs to send the agent stream there too).
 */
export function createCursorOpenAI({ config = {}, accountManager = null, port, dir, env = process.env, spawn = nodeSpawn, now = Date.now }) {
  const options = config.cursorOpenAI || {};
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10 * 60 * 1000;
  const maxConcurrent = Number.isFinite(options.maxConcurrent) ? Math.max(1, options.maxConcurrent) : 4;
  const maxRequestBytes = Number.isFinite(config.maxRequestBytes) ? config.maxRequestBytes : 32 * 1024 * 1024;
  const bin = resolveCursorBin({ env });
  // Per process: only this proxy's children hold it, and only the lane's exchange answers to it.
  const apiKey = `key_${randomBytes(24).toString('hex')}`;
  let inflight = 0;
  let models = null;
  let modelsPending = null;
  let pruneTimer = null;

  const poolProblem = () => cursorPoolProblem(accountManager?.accounts, now());
  const sendProblem = (res, problem) => sendError(res, problem.status, problem.type, problem.message,
    problem.retryAfter ? { 'retry-after': String(problem.retryAfter) } : undefined);

  /** Lane-only answers: the API-key exchange and the emptied RPCs. Returns true when it answered. */
  function answerLane(req, res) {
    const pathname = req.url.split('?', 1)[0];
    if (req.method === 'POST' && pathname === '/auth/exchange_user_api_key') {
      req.resume();
      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        sendJson(res, 401, { error: 'invalid_api_key' });
        return true;
      }
      const token = laneSessionToken(now());
      sendJson(res, 200, { accessToken: token, refreshToken: token });
      return true;
    }
    if (req.method === 'POST' && CURSOR_LANE_EMPTY_RPCS.has(pathname)) {
      req.resume();
      const json = String(req.headers['content-type'] || '').includes('json');
      res.writeHead(200, { 'Content-Type': json ? 'application/json' : 'application/proto' });
      res.end(json ? '{}' : '');
      return true;
    }
    return false;
  }

  async function run(args, input, signal) {
    let lane;
    try {
      lane = prepareLaneHome(dir); // every run: the folder may have been deleted while the proxy was idle
      enforceLaneConfig(lane.home);
    } catch (error) {
      return { code: null, stdout: '', stderr: '', error, lane: true };
    }
    const { home, workspace } = lane;
    // Prompts in chats/transcripts must not outlive CHAT_KEEP_MS just because traffic stopped.
    pruneTimer ||= setInterval(() => pruneLaneChats(home, now()), CHAT_KEEP_MS / 6);
    pruneTimer.unref?.();
    const result = await runCursorAgent({
      bin, args: [...CURSOR_LANE_FLAGS, ...args, '--workspace', workspace], env: laneEnv(env, { port, home, apiKey }),
      cwd: workspace, input, timeoutMs, signal, spawn,
    });
    // spawn reports a missing cwd as ENOENT too: only with the workspace present is ENOENT the binary's.
    if (result.error?.code === 'ENOENT' && !existsSync(workspace)) result.lane = true;
    pruneLaneChats(home, now());
    return result;
  }

  function failure(res, result) {
    if (result.error?.code === 'ENOENT' && !result.lane) return sendError(res, 503, 'cursor_cli_not_found', cursorCliNotFoundMessage(bin, env));
    if (result.lane) return sendError(res, 502, 'upstream_error', `TeamCursor: the lane folder ${dir} is not usable: ${result.error.message}`);
    if (result.error) return sendError(res, 502, 'upstream_error', `cursor-agent could not start: ${result.error.message}`);
    if (result.tooLarge) return sendError(res, 502, 'upstream_error', 'TeamCursor: cursor-agent printed more than 16 MiB; the run was stopped.');
    if (result.timedOut) return sendError(res, 504, 'timeout_error', `cursor-agent did not answer within ${Math.round(timeoutMs / 1000)} s`);
    // The run may have parked or throttled the last account: the pool says why better than the CLI's text.
    const problem = poolProblem();
    if (problem) return sendProblem(res, problem);
    const message = stripAnsi(result.stderr || result.stdout).trim().slice(0, 2000) || `cursor-agent exited with code ${result.code}`;
    const { status, type } = classifyCursorRunFailure(message);
    return sendError(res, status, type, `TeamCursor: ${message}`);
  }

  async function listModels(res) {
    if (!models || now() - models.at > MODELS_TTL_MS) {
      const problem = poolProblem();
      if (problem?.status === 401) return sendProblem(res, problem); // an exhausted account still lists models
      modelsPending ||= run(['--list-models'], '').finally(() => { modelsPending = null; });
      const result = await modelsPending;
      const list = result.code === 0 ? parseCursorModels(result.stdout) : [];
      if (!list.length) return failure(res, result.code === 0 ? { ...result, code: 1, stderr: 'cursor-agent listed no models' } : result);
      models = { at: now(), list };
    }
    sendJson(res, 200, { object: 'list', data: models.list.map(model => ({ id: model.id, object: 'model', created: 0, owned_by: 'cursor', name: model.name })) });
  }

  async function complete(req, res) {
    // Watch for a hang-up from the start: one during the body read must not leave a run holding a slot.
    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', onClose);
    try {
      await completeWatched(req, res, abort.signal);
    } finally {
      res.off('close', onClose);
    }
  }

  async function completeWatched(req, res, signal) {
    let body;
    try {
      body = JSON.parse((await readBody(req, maxRequestBytes)).toString('utf8') || '{}');
    } catch (err) {
      return sendError(res, err.status || 400, 'invalid_request_error', err.status ? err.message : 'The body is not JSON.');
    }
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !body.messages.length) {
      return sendError(res, 400, 'invalid_request_error', 'messages is required.');
    }
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'auto';
    if (!MODEL_ID.test(model)) return sendError(res, 400, 'invalid_request_error', `Unknown model: ${model}`);
    const problem = poolProblem();
    if (problem) return sendProblem(res, problem);
    if (inflight >= maxConcurrent) {
      return sendError(res, 429, 'rate_limit_error', `TeamCursor: ${maxConcurrent} completions are already running.`, { 'retry-after': '5' });
    }
    if (signal.aborted) return;
    inflight += 1;
    try {
      const args = ['-p', '--output-format', 'json', '--mode', 'ask', '--trust'];
      if (model !== 'auto') args.push('--model', model);
      const started = now();
      const result = await run(args, buildCursorPrompt(body), signal);
      if (signal.aborted) return;
      let parsed = null;
      try { parsed = JSON.parse(result.stdout); } catch { /* fall through to failure */ }
      if (result.code !== 0 || !parsed || parsed.is_error || typeof parsed.result !== 'string') {
        return failure(res, parsed?.is_error ? { ...result, stderr: String(parsed.result || result.stderr) } : result);
      }
      const toolNames = (Array.isArray(body.tools) ? body.tools : []).map(tool => tool?.function?.name).filter(Boolean);
      const completion = chatCompletion({
        id: `chatcmpl-${randomUUID()}`, created: Math.floor(now() / 1000), model,
        reply: parseCursorReply(parsed.result, body.tool_choice === 'none' ? [] : toolNames), usage: usageOf(parsed),
      });
      // Run time vs the model's own time: the rest is cursor-agent starting up.
      const timing = { 'x-teamcursor-run-ms': String(now() - started), 'x-teamcursor-model-ms': String(Number(parsed.duration_ms) || 0) };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...timing });
        res.end(chatCompletionSse(completion, body.stream_options?.include_usage === true));
      } else {
        sendJson(res, 200, completion, timing);
      }
    } finally {
      inflight -= 1;
    }
  }

  /** The OpenAI surface. Returns after answering. */
  async function handle(req, res) {
    const pathname = req.url.split('?', 1)[0];
    if (pathname === `${CURSOR_OPENAI_PREFIX}/models` && req.method === 'GET') return listModels(res);
    if (pathname === `${CURSOR_OPENAI_PREFIX}/chat/completions` && req.method === 'POST') return complete(req, res);
    req.resume();
    return sendError(res, 404, 'not_found_error', `Not on the TeamCursor OpenAI surface: ${req.method} ${pathname}. Use GET ${CURSOR_OPENAI_PREFIX}/models or POST ${CURSOR_OPENAI_PREFIX}/chat/completions.`);
  }

  return { answerLane, handle };
}
