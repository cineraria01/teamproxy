#!/usr/bin/env node
// Build the deterministic app bundle teamproxy-app-<version>.tar.gz and print its SHA-256.
// Usage: node scripts/build-app-bundle.mjs [OUT_DIR]   (default: dist/)
// Same sources -> same bytes: sorted entries, fixed mtime/owner/mode, no gzip name or time.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['package.json', 'LICENSE', 'README.md', 'config.example.json', 'config.codex.example.json'];

function walk(dir, keep) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.name.startsWith('.')) return []; // .omc, .DS_Store, ...
    if (entry.isDirectory()) return entry.name === '__pycache__' ? [] : walk(path, keep);
    return entry.isFile() && keep(entry.name) ? [path] : [];
  });
}

// Tracked files only, so a stray .DS_Store or local note never changes the bundle. An unpacked bundle
// (no .git) falls back to walking the folder.
function tracked() {
  try {
    return execFileSync('git', ['ls-files', '-z', '--', 'src', 'scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function members() {
  const wanted = name => name.startsWith('src/') || /^scripts\/install[^/]*\.(py|mjs)$/.test(name);
  const listed = tracked();
  const found = listed
    ? listed.filter(wanted)
    : [...walk(join(ROOT, 'src'), () => true), ...walk(join(ROOT, 'scripts'), name => /^install.*\.(py|mjs)$/.test(name))]
      .map(path => relative(ROOT, path).split(sep).join('/'));
  return [...FILES, ...found.filter(name => !name.split('/').some(part => part.startsWith('.')))].sort();
}

const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`;

// ustar header; names over 100 bytes are split into prefix/name at a '/'.
function header(name, size, mode) {
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut < 1 || Buffer.byteLength(name) - cut - 1 > 100) throw new Error(`path too long for tar: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const block = Buffer.alloc(512);
  const put = (text, offset) => block.write(text, offset, 'latin1');
  put(base, 0); put(octal(mode, 8), 100); put(octal(0, 8), 108); put(octal(0, 8), 116);
  put(octal(size, 12), 124); put(octal(0, 12), 136); put('        ', 148); put('0', 156);
  put('ustar\0', 257); put('00', 263); put(prefix, 345);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

export function build(outDir) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const top = `teamproxy-app-${version}`;
  const parts = [];
  for (const name of members()) {
    const data = readFileSync(join(ROOT, name));
    const mode = statSync(join(ROOT, name)).mode & 0o111 ? 0o755 : 0o644;
    parts.push(header(`${top}/${name}`, data.length, mode), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const gz = gzipSync(Buffer.concat(parts), { level: 9 });
  gz[4] = gz[5] = gz[6] = gz[7] = 0; // mtime
  gz[9] = 3; // OS = Unix, so the bytes do not depend on the build platform
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, `${top}.tar.gz`);
  writeFileSync(target, gz);
  return { target, sha256: createHash('sha256').update(gz).digest('hex') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { target, sha256 } = build(process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'dist'));
  console.log(`${sha256}  ${target}`);
}
