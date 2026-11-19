// The one place the CLI picks macOS/Linux or Windows behavior. Windows-only code lives in src/win32.js; common
// code asks this module instead of testing process.platform itself (2026-11-18 user: "맥이랑 윈도우 코드 섞이면
// 안된다"). Older platform checks elsewhere (config.js rename retry, codex.js binary lookup, …) predate it.
import * as win32 from './win32.js';

// Tests only (node --test, like scripts/install-app.mjs): TEAMPROXY_APP_PLATFORM=win32 takes the Windows branch
// on any OS. Ignored outside the test runner.
export const PLATFORM = (process.env.NODE_TEST_CONTEXT && process.env.TEAMPROXY_APP_PLATFORM) || process.platform;
const WIN32 = PLATFORM === 'win32';

/** ps and lsof exist (macOS/Linux), so a process's identity can be verified before it is signalled. */
export const hasProcessTools = !WIN32;

/** Lines `stop`/`restart` print instead of signalling an unverifiable server, or null (macOS/Linux: always). */
export const unverifiedServerHint = WIN32 ? win32.unverifiedServerHint : () => null;
