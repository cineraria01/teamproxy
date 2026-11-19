#!/usr/bin/env node

// Windows entry, run by scripts/win32/teamclaude.cmd: the sh wrapper's argument rule (src/win32.js wrapperArgs),
// then the ordinary teamclaude entry. macOS/Linux use their sh wrapper and src/teamclaude.js, never this file.
import { wrapperArgs } from './win32.js';

process.argv.splice(2, Infinity, ...wrapperArgs(process.argv.slice(2)));
await import('./teamclaude.js');
