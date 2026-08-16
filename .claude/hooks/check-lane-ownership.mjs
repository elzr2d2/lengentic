#!/usr/bin/env node
/**
 * Blocks a write outside the active lane's declared surface.
 *
 * Wired to PreToolUse on Edit|Write|NotebookEdit. The whole gate hangs on one file:
 *
 *   <repo>/.artifacts/lanes/current.json
 *     { "task_id": "...", "allowed_paths": ["..."], "forbidden_paths": ["..."] }
 *
 * written into a lane's worktree by whoever set the lane up (`pnpm lanes worktrees` prints
 * it). **No lane file means no lane, and no lane means allow.** That default is deliberate:
 * the main session is not a lane, and a hook that blocked ordinary editing because a config
 * file was missing would be turned off within the hour.
 *
 *   no lane file          -> allow
 *   path inside allowed   -> allow
 *   path in forbidden     -> exit 2, refusal names the rule
 *   path outside allowed  -> exit 2, refusal names the surface
 *   anything unexpected   -> allow, and say so on stderr
 *
 * Fail-open on error, not fail-closed. A bug in this file must not be able to stop every
 * edit in the repository; the deterministic gate that cannot be bypassed is
 * `pnpm lanes check <id>` at commit time, and that one fails closed.
 *
 * Also runnable standalone, which is how `pnpm check:lanes` proves it works:
 *   node .claude/hooks/check-lane-ownership.mjs --lane <lane.json> --path <file>
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { anyMatch, matchPath, normalise } from './lib/match-path.mjs';

const LANE_FILE = '.artifacts/lanes/current.json';

function main() {
  const laneFlag = argValue('--lane');
  if (laneFlag) {
    const path = argValue('--path');
    if (!path) bail('--path is required with --lane');
    const lane = readLane(laneFlag);
    if (!lane) bail(`could not read lane file: ${laneFlag}`);
    return decide(lane, normalise(path), laneFlag);
  }

  const payload = readStdinJson();
  if (payload === null) process.exit(0);

  const file = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  if (typeof file !== 'string' || file === '') process.exit(0);

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const found = findLaneFile(cwd);
  if (!found) process.exit(0); // Not in a lane. Nothing to enforce.

  const lane = readLane(found.file);
  if (!lane) {
    process.stderr.write(`lane file at ${found.file} is unreadable; not enforcing ownership\n`);
    process.exit(0);
  }

  const rel = isAbsolute(file) ? relative(found.root, file) : file;
  decide(lane, normalise(rel), found.file);
}

/**
 * @param {{task_id?: string, allowed_paths?: string[], forbidden_paths?: string[]}} lane
 * @param {string} rel repository-relative, forward-slashed
 * @param {string} source
 */
function decide(lane, rel, source) {
  const allowed = Array.isArray(lane.allowed_paths) ? lane.allowed_paths : [];
  const forbidden = Array.isArray(lane.forbidden_paths) ? lane.forbidden_paths : [];
  const id = lane.task_id ?? '(unnamed lane)';

  // A lane has to be able to write its own handoff and telemetry, or it would have to
  // choose between the ownership gate and the handoff contract.
  if (matchPath(rel, '.artifacts/**')) process.exit(0);

  // A path that escapes the repository escapes the gate. Refuse rather than guess.
  if (rel.startsWith('../')) {
    refuse(id, rel, `outside the repository (${rel})`, allowed, source);
  }

  const hitForbidden = anyMatch(rel, forbidden);
  if (hitForbidden !== null) {
    refuse(id, rel, `matches forbidden_paths rule \`${hitForbidden}\``, allowed, source);
  }

  if (allowed.length === 0) {
    refuse(id, rel, 'this lane declares no allowed_paths', allowed, source);
  }

  if (anyMatch(rel, allowed) === null) {
    refuse(id, rel, 'outside allowed_paths', allowed, source);
  }

  process.exit(0);
}

/**
 * @param {string} id
 * @param {string} rel
 * @param {string} why
 * @param {string[]} allowed
 * @param {string} source
 */
function refuse(id, rel, why, allowed, source) {
  process.stderr.write(
    [
      `Lane ${id} may not write ${rel}: ${why}.`,
      '',
      `allowed_paths: ${allowed.length > 0 ? allowed.join(', ') : '(none declared)'}`,
      `declared in:   ${source}`,
      '',
      'Do not widen your own boundary. If this file genuinely has to change for the task,',
      'stop and report BLOCKED naming the path — another lane may own it, and two lanes',
      'writing one file is the failure this gate exists to prevent.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

/** Walk up from cwd looking for a lane file, so a subdirectory cwd still resolves. */
function findLaneFile(start) {
  let dir = resolve(start);
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, LANE_FILE);
    if (existsSync(candidate)) return { file: candidate, root: dir };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readLane(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() === '' ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function bail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

try {
  main();
} catch (error) {
  // Fail open. A defect here must never become an unbypassable editing block.
  process.stderr.write(`check-lane-ownership: ${error?.message ?? error}; not enforcing\n`);
  process.exit(0);
}
