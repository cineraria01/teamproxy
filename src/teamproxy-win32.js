#!/usr/bin/env node

// Windows entry for every installed pool, run by %USERPROFILE%\.local\bin\team<pool>.cmd (scripts/install-win.mjs):
// `node teamproxy-win32.js <claude|codex|agy|grok|cursor> [args]`. Applies the sh wrapper's argument rule
// (src/win32.js wrapperArgs; teamcodex also its exec -c guard), then becomes the pool's ordinary entry —
// process.argv[1] included, so a server the CLI auto-starts is `<entry> [prefix] server`, never this file again.
// macOS/Linux use their sh wrappers and never load this file.
import { fileURLToPath } from 'node:url';
import { POOLS, codexExecConfigError, wrapperArgs } from './win32.js';

const [pool, ...rest] = process.argv.slice(2);
if (!Object.hasOwn(POOLS, pool)) {
  console.error(`usage: teamproxy-win32.js <${Object.keys(POOLS).join('|')}> [args]`);
  process.exit(2);
}
const argv = wrapperArgs(rest);
const refusal = pool === 'codex' ? codexExecConfigError(argv) : null;
if (refusal) {
  for (const line of refusal) console.error(line);
  process.exit(2);
}
const entry = pool === 'claude' ? './teamclaude.js' : './index.js';
process.argv.splice(1, Infinity, fileURLToPath(new URL(entry, import.meta.url)), ...POOLS[pool].prefix, ...argv);
await import(entry);
