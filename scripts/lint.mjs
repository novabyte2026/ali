#!/usr/bin/env node
// House-rule linter — the checks a type-checker cannot make.
//
// The project does not carry ESLint/Prettier/Biome: the dependency surface is
// kept deliberately small, and `tsc` already enforces the type rules. What is
// left are a handful of product constraints from the specification that are
// invisible to the compiler but are not negotiable, so they are enforced
// mechanically here rather than by review alone:
//
//   1. No emoji anywhere in the product. The UI is deliberately restrained
//      (no emoji, no AI-look); a stray emoji in a string or comment is a
//      regression against that, so it fails the build.
//   2. No leftover work markers (TODO / FIXME / XXX / HACK) or PLACEHOLDER
//      sentinels in shipped source. The product claims to be honest about what
//      is and is not finished through the feature-status register, not through
//      scattered comments, and an unexpanded SQL placeholder was a real bug.
//   3. No stray console.* in the server or shared libraries. They have a
//      structured logger; a bare console write bypasses redaction and levels.
//   4. No `debugger;` statements.
//
// Exit code is non-zero if any rule is violated, so `npm run verify` fails.
// The typographic marks ©, ® and ™ are allowed; they are not emoji.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_ROOTS = [
  'backend/src',
  'workers/src',
  'shared/src',
  'integrations/src',
  'database/migrations',
  'frontend/app',
  'frontend/components',
  'frontend/lib',
];

const LINTABLE = new Set(['.ts', '.tsx', '.css', '.sql', '.svg', '.mjs']);
const SKIP_DIR = /(^|\/)(node_modules|dist|\.next|out|\.turbo)(\/|$)/;

const EMOJI = /\p{Emoji_Presentation}|[\p{Emoji}]️/u;
const ALLOWED_SYMBOLS = new Set(['©', '®', '™']);
const WORK_MARKER = /\b(TODO|FIXME|XXX|HACK)\b|PLACEHOLDER/;
const CONSOLE_CALL = /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/;
const DEBUGGER = /\bdebugger\s*;/;

// console.* is only forbidden in the server and shared libraries; scripts and
// the frontend legitimately write to the console.
const CONSOLE_FORBIDDEN_ROOTS = ['backend/src', 'workers/src', 'shared/src', 'integrations/src'];

/** @type {{file: string, line: number, rule: string, text: string}[]} */
const violations = [];

function add(file, lineNo, rule, text) {
  violations.push({ file, line: lineNo, rule, text: text.trim().slice(0, 100) });
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (SKIP_DIR.test(full)) continue;
    const info = statSync(full);
    if (info.isDirectory()) {
      yield* walk(full);
    } else {
      const dot = entry.lastIndexOf('.');
      const ext = dot >= 0 ? entry.slice(dot) : '';
      if (LINTABLE.has(ext)) yield full;
    }
  }
}

function lintFile(absPath) {
  const rel = relative(root, absPath);
  const consoleForbidden = CONSOLE_FORBIDDEN_ROOTS.some((r) => rel.startsWith(r));
  const lines = readFileSync(absPath, 'utf8').split('\n');

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    const stripped = [...line].filter((c) => !ALLOWED_SYMBOLS.has(c)).join('');
    if (EMOJI.test(stripped)) add(rel, lineNo, 'no-emoji', line);

    if (WORK_MARKER.test(line)) add(rel, lineNo, 'no-work-marker', line);

    if (DEBUGGER.test(line)) add(rel, lineNo, 'no-debugger', line);

    if (consoleForbidden && CONSOLE_CALL.test(line)) add(rel, lineNo, 'no-console', line);
  });
}

let fileCount = 0;
for (const sourceRoot of SOURCE_ROOTS) {
  for (const file of walk(join(root, sourceRoot))) {
    fileCount += 1;
    lintFile(file);
  }
}

if (violations.length === 0) {
  process.stdout.write(`lint: ${fileCount} files, no house-rule violations\n`);
  process.exit(0);
}

process.stderr.write(`lint: ${violations.length} violation(s) in ${fileCount} files\n\n`);
for (const v of violations) {
  process.stderr.write(`  ${v.file}:${v.line}  [${v.rule}]  ${v.text}\n`);
}
process.stderr.write('\n');
process.exit(1);
