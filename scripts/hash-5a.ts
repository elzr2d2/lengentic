/**
 * Hashes the Phase 5a files that an analyzer packet must not change.
 *
 * `pnpm lanes check` validates paths. It cannot see an edit that stayed inside a path the
 * lane was allowed to touch, and one file in the protected set — the threshold-binding spec
 * — sits in `test/analyzer/**`, which BOTH wave-3 packets own. Nothing but a hash catches
 * `p5.repeated-failed` gutting the spec `p5.det-candidate` landed.
 *
 *   pnpm hash:5a before-det-candidate
 *   pnpm hash:5a after-det-candidate --compare before-det-candidate
 *
 * Writes `.artifacts/evidence/5a/hashes-<label>.txt`, one `sha256  path` line per file,
 * sorted by path. `--compare` exits non-zero and names every added, removed or changed file.
 * A missing protected file is recorded as `ABSENT`, not skipped: the whole point is that the
 * set is the same before and after, and deletion is the loudest way to fail that.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

const ROOT = process.cwd();
const EVIDENCE_DIR = join(ROOT, '.artifacts', 'evidence', '5a');

/** Directories hashed whole, recursively. */
const PROTECTED_DIRS = ['platform/analysis-engine/fixtures', 'platform/analysis-engine/test/grid'];

/** Individual files hashed by name, recorded as ABSENT when missing. */
const PROTECTED_FILES = ['platform/analysis-engine/test/analyzer/threshold-binding.spec.ts'];

function walk(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function toPosix(absolute: string): string {
  return relative(ROOT, absolute).split(sep).join(posix.sep);
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function collect(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const dir of PROTECTED_DIRS) {
    const absolute = join(ROOT, ...dir.split('/'));
    if (!existsSync(absolute)) {
      entries.set(`${dir}/`, 'ABSENT');
      continue;
    }
    for (const file of walk(absolute, [])) entries.set(toPosix(file), sha256(file));
  }
  for (const file of PROTECTED_FILES) {
    const absolute = join(ROOT, ...file.split('/'));
    entries.set(file, existsSync(absolute) ? sha256(absolute) : 'ABSENT');
  }
  return new Map([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function render(entries: Map<string, string>): string {
  return [...entries].map(([path, hash]) => `${hash}  ${path}`).join('\n') + '\n';
}

function parse(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+) {2}(.+)$/.exec(line);
    if (match?.[1] && match[2]) entries.set(match[2], match[1]);
  }
  return entries;
}

function main(): void {
  const args = process.argv.slice(2);
  const label = args.find((a) => !a.startsWith('--'));
  if (!label) {
    console.error('usage: pnpm hash:5a <label> [--compare <earlier-label>]');
    process.exit(2);
  }

  const compareIndex = args.indexOf('--compare');
  const baseline = compareIndex === -1 ? undefined : args[compareIndex + 1];

  const entries = collect();
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const target = join(EVIDENCE_DIR, `hashes-${label}.txt`);
  writeFileSync(target, render(entries), 'utf8');
  console.log(`hashed ${entries.size} protected path(s) -> ${toPosix(target)}`);

  if (!baseline) return;

  const baselineFile = join(EVIDENCE_DIR, `hashes-${baseline}.txt`);
  if (!existsSync(baselineFile)) {
    console.error(`no baseline to compare against: ${toPosix(baselineFile)}`);
    process.exit(2);
  }

  const before = parse(readFileSync(baselineFile, 'utf8'));
  const drift: string[] = [];
  for (const [path, hash] of entries) {
    const previous = before.get(path);
    if (previous === undefined) drift.push(`ADDED    ${path}`);
    else if (previous !== hash) drift.push(`CHANGED  ${path}`);
  }
  for (const path of before.keys()) {
    if (!entries.has(path)) drift.push(`REMOVED  ${path}`);
  }

  if (drift.length === 0) {
    console.log(`unchanged against ${baseline}: every protected path matches`);
    return;
  }
  console.error(`protected paths drifted against ${baseline}:`);
  for (const line of drift.sort()) console.error(`  ${line}`);
  process.exit(1);
}

main();
