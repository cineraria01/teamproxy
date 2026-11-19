// The one place the CLI picks macOS/Linux or Windows behavior. Windows-only code lives in src/win32.js and
// src/win32-update.js; common code asks this module instead of testing process.platform itself (2026-11-18 user:
// "맥이랑 윈도우 코드 섞이면 안된다"). Older platform checks elsewhere (config.js rename retry, codex.js binary
// lookup, …) predate it.
import * as win32 from './win32.js';
import { updateCommand as unixUpdateCommand } from './update.js';
import { updateCommand as win32UpdateCommand } from './win32-update.js';

// Tests only (node --test, like scripts/install-app.mjs): TEAMPROXY_APP_PLATFORM=win32 takes the Windows branch
// on any OS. Ignored outside the test runner.
export const PLATFORM = (process.env.NODE_TEST_CONTEXT && process.env.TEAMPROXY_APP_PLATFORM) || process.platform;
const WIN32 = PLATFORM === 'win32';

/** ps and lsof exist (macOS/Linux), so a process's identity can be verified before it is signalled. */
export const hasProcessTools = !WIN32;

/** Lines `stop`/`restart` print instead of signalling an unverifiable server, or null (macOS/Linux: always). */
export const unverifiedServerHint = WIN32 ? win32.unverifiedServerHint : () => null;

/**
 * `stop`/`restart` through a service the platform runs the pool as (Windows: the scheduled task the installer
 * made). null = no such service here, take the usual path (macOS/Linux: always); '' = done; else the error line.
 */
export const serviceLifecycle = WIN32 ? win32.taskLifecycle : async () => null;

/** Start the pool's server through that service (true), or false: spawn it the usual way (macOS/Linux: always). */
export const serviceStart = WIN32 ? cli => win32.taskStart(cli) : () => false;

/** `<pool> update`: macOS/Linux replace an npm-style install (src/update.js), Windows pulls its git clone. */
export const updateCommand = WIN32 ? win32UpdateCommand : unixUpdateCommand;
