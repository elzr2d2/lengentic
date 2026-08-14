#!/usr/bin/env node
/**
 * Formats a file immediately after it is written or edited (MVP_PLAN.md §31, development
 * tier).
 *
 * Wired to PostToolUse on Edit|Write. Never blocks: a formatter that can fail a task is a
 * formatter that gets disabled. If prettier is missing, unconfigured, or unhappy, this
 * exits 0 silently and `pnpm format:check` catches it at the gate instead.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, relative, extname } from 'node:path';

const FORMATTABLE = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.css',
]);

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const filePath = payload?.tool_input?.file_path;
  const cwd = payload?.cwd ?? process.cwd();

  if (typeof filePath === 'string' && FORMATTABLE.has(extname(filePath))) {
    const absolute = resolve(cwd, filePath);
    const inRepo = !relative(cwd, absolute).startsWith('..');

    // MVP_PLAN.md is copied in verbatim as the reference document. Reformatting it would
    // make every future diff against the original unreadable.
    const isPlan = absolute.replace(/\\/g, '/').endsWith('/MVP_PLAN.md');

    if (inRepo && !isPlan && existsSync(absolute)) {
      spawnSync('npx', ['prettier', '--write', '--ignore-unknown', absolute], {
        cwd,
        stdio: 'ignore',
        shell: process.platform === 'win32',
        timeout: 20_000,
      });
    }
  }
} catch {
  /* Formatting is a convenience. It never fails a task. */
}

process.exit(0);
