#!/usr/bin/env node
// Runs the backend, frontend and workers together for local development.
//
// Each is started with its own workspace `dev` script (tsx watch / next dev),
// so a source change restarts only the process it belongs to. Output is
// line-prefixed per service rather than interleaved raw, because three watchers
// writing to one terminal is otherwise unreadable. A SIGINT tears the whole
// group down — a half-stopped dev stack that keeps a port is the most common
// local-dev papercut, so the signal handling here is deliberate.
//
// This is a convenience launcher, not a process supervisor. For anything that
// must survive a crash (a real deployment, or the long-running workers), run
// the per-workspace `start` scripts under your own supervisor instead; see
// docs/deployment.md.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Which services to run. `npm run dev -- backend frontend` narrows the set;
// with no arguments all three start.
const ALL = ['backend', 'frontend', 'workers'];
const requested = process.argv.slice(2).filter((a) => ALL.includes(a));
const services = requested.length > 0 ? requested : ALL;

const COLORS = {
  backend: '\x1b[36m', // cyan
  frontend: '\x1b[35m', // magenta
  workers: '\x1b[33m', // yellow
};
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY;

function label(name) {
  const tag = `[${name}]`.padEnd(10);
  return useColor ? `${COLORS[name] ?? ''}${tag}${RESET}` : tag;
}

/** Prefix every line of a stream with the service name. */
function pipePrefixed(stream, name, sink) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) sink.write(`${label(name)} ${line}\n`);
  });
  stream.on('end', () => {
    if (buffer.length > 0) sink.write(`${label(name)} ${buffer}\n`);
  });
}

const children = [];
let shuttingDown = false;

function startAll() {
  for (const name of services) {
    const child = spawn('npm', ['run', 'dev', '--workspace', `@shelf/${name}`], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipePrefixed(child.stdout, name, process.stdout);
    pipePrefixed(child.stderr, name, process.stderr);

    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      process.stdout.write(
        `${label(name)} exited (${signal ?? code}). Stopping the dev stack.\n`,
      );
      shutdown(code === 0 ? 1 : (code ?? 1));
    });

    children.push({ name, child });
  }

  process.stdout.write(
    `${label('dev')} running: ${services.join(', ')}. Ctrl-C to stop all.\n`,
  );
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    child.kill('SIGTERM');
  }
  // Give children a moment to exit cleanly, then force.
  const forceTimer = setTimeout(() => {
    for (const { child } of children) child.kill('SIGKILL');
    process.exit(exitCode);
  }, 5000);
  forceTimer.unref();

  let remaining = children.length;
  for (const { child } of children) {
    child.on('exit', () => {
      remaining -= 1;
      if (remaining === 0) {
        clearTimeout(forceTimer);
        process.exit(exitCode);
      }
    });
  }
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

startAll();
