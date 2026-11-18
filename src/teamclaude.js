#!/usr/bin/env node

import { wrapperArgs } from './remote-client.js';

// Anthropic-mode entry point. `src/index.js` picks its provider (and therefore
// its config file and default port) from TEAMCLAUDE_PROVIDER, so the two bins
// differ only in what that variable says when the process starts. Clearing it
// here means an inherited TEAMCLAUDE_PROVIDER=codex — from a parent shell, a
// launchd plist, or a `teamcodex run` child — cannot silently point the
// `teamclaude` command at the Codex pool and its config.
delete process.env.TEAMCLAUDE_PROVIDER;
// Windows teamclaude.cmd sets TEAMCLAUDE_WRAPPER=1: the sh wrapper's argument rule, in node
// (docs/install/INSTALL-ALL.md §9-4). Dropped here so nothing Claude starts inherits it.
if (process.env.TEAMCLAUDE_WRAPPER === '1') {
  delete process.env.TEAMCLAUDE_WRAPPER;
  process.argv.splice(2, Infinity, ...wrapperArgs(process.argv.slice(2)));
}
await import('./index.js');
