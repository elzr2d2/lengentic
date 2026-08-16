#!/usr/bin/env node
/**
 * Injects the newest session continuation brief into a fresh session.
 *
 * Wired to SessionStart, matcher `clear|startup`. The other sources are deliberately excluded:
 * `compact` and `resume` both keep or restore the prior context, so injecting there duplicates
 * the brief into a window that already holds the work — adding context to fix a context
 * problem. `fork` inherits the parent's context for the same reason.
 *
 * Briefs are written by the `session-handoff` skill to `.artifacts/handoffs/session/*.md`.
 * SessionStart cannot block, so this is best-effort by construction: no brief, no injection,
 * no complaint.
 *
 * Consumption is repository-wide, not session-wide — the next session to start in this repo
 * reads whatever is in that directory, which may be an unrelated brief from days ago. Two
 * guards, both env-overridable:
 *   HANDOFF_MAX_AGE_HOURS  (default 12)  older than this is stale
 *   HANDOFF_MAX_CHARS      (default 12000) injected size ceiling
 * plus a HEAD check: a brief whose `head` sha is not the current HEAD describes a tree that has
 * moved on. Stale briefs are reported and left in place, never silently eaten.
 *
 * A consumed brief moves to `consumed/` rather than being renamed in place, so the record
 * survives and the next session does not re-inject it.
 */

import { readFileSync, readdirSync, statSync, mkdirSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const MAX_AGE_HOURS = Number(process.env.HANDOFF_MAX_AGE_HOURS ?? 12);
const MAX_CHARS = Number(process.env.HANDOFF_MAX_CHARS ?? 12_000);
const INJECT_ON = new Set(['clear', 'startup']);

/** @param {string} dir */
function newestBrief(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // No directory yet is the normal case, not an error.
  }

  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => {
      const path = join(dir, e.name);
      try {
        return { path, name: e.name, mtimeMs: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files[0] ?? null;
}

/** @param {string} cwd */
function currentHead(cwd) {
  const run = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 5_000,
  });
  const sha = run.status === 0 ? run.stdout.trim() : '';
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/** @param {string} text */
function frontMatterHead(text) {
  const match = text.match(/^head:\s*([0-9a-f]{7,40})\s*$/m);
  return match ? match[1] : null;
}

/** Emit and exit. SessionStart shows `systemMessage` to the human, `additionalContext` to us. */
function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const source = input?.source;
  const cwd = input?.cwd ?? process.cwd();

  // The matcher already filters, but the exclusion is the design decision — state it in code
  // too, so a widened matcher does not silently change behaviour.
  if (typeof source === 'string' && !INJECT_ON.has(source)) process.exit(0);

  const dir = resolve(cwd, '.artifacts/handoffs/session');
  const brief = newestBrief(dir);
  if (brief === null) process.exit(0);

  const ageHours = (Date.now() - brief.mtimeMs) / 3_600_000;
  if (ageHours > MAX_AGE_HOURS) {
    emit({
      systemMessage:
        `Skipped a stale session handoff: ${brief.name} is ${ageHours.toFixed(1)}h old ` +
        `(limit ${MAX_AGE_HOURS}h). Left in place at ${dir}.`,
    });
  }

  const text = readFileSync(brief.path, 'utf8');
  const head = currentHead(cwd);
  const briefHead = frontMatterHead(text);

  if (head !== null && briefHead !== null && !head.startsWith(briefHead)) {
    emit({
      systemMessage:
        `Skipped a session handoff written against a different HEAD: ${brief.name} says ` +
        `${briefHead.slice(0, 12)}, HEAD is ${head.slice(0, 12)}. Left in place at ${dir}.`,
    });
  }

  // Move first, then cite the path it now lives at.
  const consumedDir = join(dir, 'consumed');
  let citedPath = brief.path;
  try {
    mkdirSync(consumedDir, { recursive: true });
    const target = join(consumedDir, brief.name);
    renameSync(brief.path, target);
    citedPath = target;
  } catch {
    // Could not move it: inject anyway. A brief read twice is a smaller problem than a brief
    // never read, and the human sees the path in the message either way.
  }

  const unverified =
    head === null || briefHead === null
      ? '\n(HEAD could not be verified for this brief — check it still describes this tree.)'
      : '';

  const truncated = text.length > MAX_CHARS;
  const body = truncated ? `${text.slice(0, MAX_CHARS)}\n[...truncated]` : text;

  emit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `A session handoff from a previous window was found and is reproduced below. It is a ` +
        `continuation brief, not an instruction to act — read it, then confirm with the human ` +
        `before resuming. Full file: ${citedPath}` +
        `${truncated ? ` (truncated here at ${MAX_CHARS} chars; read the file for the rest)` : ''}` +
        `${unverified}\n\n${body}`,
    },
    systemMessage: `Loaded session handoff ${brief.name} (${Math.round(ageHours * 10) / 10}h old).`,
  });
} catch {
  /* A continuation brief never breaks a session start. */
}

process.exit(0);
