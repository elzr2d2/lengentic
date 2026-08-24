/**
 * QA-integrity scan.
 *
 * `CLAUDE.md`: never ask an agent to verify what a script can verify. Every pattern here
 * is lexical and has one correct fixed form, so it belongs in a script rather than in an
 * agent's attention budget. What is left for `watchdog` is the part that needs judgement:
 * confirming a hit by reading around it, and deciding what a WARN means in context.
 *
 * Two severities:
 *
 *   BLOCK   the pattern is a defect wherever it appears. Exit 1.
 *   WARN    the pattern is a prompt to look. Reported, never blocking.
 *
 * A lexical hit is not a verdict. The script's job is to make sure nobody has to remember
 * to look; a human or `watchdog` decides what each hit means.
 *
 * Usage:
 *   pnpm check:integrity          scan the repository's automation code
 *   pnpm check:integrity --json   machine-readable, for a wrapping agent
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const ROOTS = ['platform', 'playground', 'spike', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
const TEST_CONFIG = /(vitest|jest|playwright)\.config\.[cm]?[jt]s$/;
const INTEGRATION_FILE = /integration/i;

type Severity = 'BLOCK' | 'WARN';

interface Rule {
  id: string;
  severity: Severity;
  what: string;
  /** Which files this rule reads. */
  applies: (path: string) => boolean;
  /** Line-level detector. Return a reason to report a hit. */
  test: (line: string, path: string) => string | null;
}

interface Hit {
  rule: Rule;
  file: string;
  line: number;
  text: string;
  reason: string;
}

const isTest = (p: string) => TEST_FILE.test(p);
const isConfig = (p: string) => TEST_CONFIG.test(p);
const isTestOrConfig = (p: string) => isTest(p) || isConfig(p);

/**
 * `node:test` does not only spell a focus or a skip as `test.only(...)` / `test.skip(...)`.
 * It also takes them as an options object — `test('name', { skip: true }, fn)` — which the
 * dotted-form patterns below cannot see. A suite written in that idiom could carry a hidden
 * skip straight through a CLEAN scan, which is the exact failure this file exists to prevent.
 * Matches `, { … key: … }` and deliberately ignores an explicit `false`.
 */
const nodeTestOption = (keys: string) =>
  new RegExp(
    // The lookahead sits directly after the colon and swallows its own whitespace. Written as
    // `\s*(?!false)` instead, `\s*` backtracks to zero width and the lookahead then inspects a
    // space rather than the value — so `{ skip: false }` would match.
    String.raw`\b(describe|it|test|suite)\s*\([^)]*,\s*\{[^}]*\b(${keys})\s*:(?!\s*false\b)`,
  );

const NODE_TEST_ONLY = nodeTestOption('only');
const NODE_TEST_SKIP = nodeTestOption('skip|todo');

const RULES: Rule[] = [
  {
    id: 'focused-test',
    severity: 'BLOCK',
    what: 'Focused test — silently hides the rest of the suite',
    applies: isTest,
    test: (line) =>
      /\b(describe|it|test|bench)\s*\.\s*only\s*\(/.test(line) || NODE_TEST_ONLY.test(line)
        ? 'focused'
        : null,
  },
  {
    id: 'skipped-test',
    severity: 'WARN',
    what: 'Skipped test — required coverage that does not execute is not a pass',
    applies: isTest,
    test: (line) =>
      /\b(describe|it|test)\s*\.\s*(skip|todo|failing)\s*\(|\bit\s*\.\s*skipIf\s*\(/.test(line) ||
      NODE_TEST_SKIP.test(line)
        ? 'skipped'
        : null,
  },
  {
    id: 'arbitrary-sleep',
    severity: 'BLOCK',
    what: 'Arbitrary sleep — waits must land on an observable condition, not a duration',
    applies: isTestOrConfig,
    test: (line) =>
      /waitForTimeout\s*\(|\bsleep\s*\(\s*\d|setTimeout\s*\(\s*(resolve|done)\b/.test(line)
        ? 'timing-based wait'
        : null,
  },
  {
    id: 'swallowed-exception',
    severity: 'BLOCK',
    what: 'Swallowed exception — a failure that cannot be seen cannot be fixed',
    applies: isTest,
    test: (line) => (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(line) ? 'empty catch block' : null),
  },
  {
    id: 'retry-hiding-flakiness',
    severity: 'WARN',
    what: 'Retries configured — a retry buys a green and loses the diagnosis',
    applies: isConfig,
    test: (line) => (/\bretr(y|ies)\s*:/.test(line) ? 'retries configured' : null),
  },
  {
    id: 'false-green-assertion',
    severity: 'BLOCK',
    what: 'Assertion that cannot fail',
    applies: isTest,
    test: (line) => {
      if (/expect\s*\(\s*(true|1|!!)/.test(line)) return 'asserts a constant';
      if (/expect\s*\(([^)]+)\)\s*\.\s*toBe\s*\(\s*\1\s*\)/.test(line))
        return 'compares a value to itself';
      return null;
    },
  },
  {
    id: 'weak-assertion',
    severity: 'WARN',
    what: 'Presence-only assertion where the outcome is a value',
    applies: isTest,
    test: (line) =>
      /\.\s*(toBeTruthy|toBeDefined|toBeCalled|toHaveBeenCalled)\s*\(\s*\)/.test(line)
        ? 'presence-only'
        : null,
  },
  {
    id: 'mocked-integration',
    severity: 'BLOCK',
    what: 'Mocked collaborator in an integration test — mocked behaviour is not evidence',
    applies: (p) => isTest(p) && INTEGRATION_FILE.test(p),
    test: (line) =>
      /\b(vi|jest)\s*\.\s*mock\s*\(|\bnock\s*\(|\bsetupServer\s*\(|\bfetchMock\b/.test(line)
        ? 'product behaviour replaced'
        : null,
  },
];

function main(): void {
  const json = process.argv.includes('--json');
  const files = ROOTS.flatMap((root) => walk(join(REPO, root)));
  const hits: Hit[] = [];

  for (const file of files) {
    const rel = relative(REPO, file).replaceAll('\\', '/');
    const applicable = RULES.filter((rule) => rule.applies(rel));
    if (applicable.length === 0) continue;

    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, index) => {
      for (const rule of applicable) {
        const reason = rule.test(text, rel);
        if (reason !== null) {
          hits.push({ rule, file: rel, line: index + 1, text: text.trim(), reason });
        }
      }
    });
  }

  const blocking = hits.filter((h) => h.rule.severity === 'BLOCK');

  if (json) {
    console.log(
      JSON.stringify(
        {
          scanned: files.length,
          blocking: blocking.length,
          warnings: hits.length - blocking.length,
          hits: hits.map((h) => ({
            rule: h.rule.id,
            severity: h.rule.severity,
            location: `${h.file}:${h.line}`,
            reason: h.reason,
            text: h.text,
          })),
        },
        null,
        2,
      ),
    );
    process.exit(blocking.length > 0 ? 1 : 0);
  }

  console.log(`check:integrity — ${files.length} automation file(s) scanned`);

  for (const rule of RULES) {
    const found = hits.filter((h) => h.rule.id === rule.id);
    if (found.length === 0) {
      console.log(`  CLEAN ${rule.id}`);
      continue;
    }
    console.log(`  ${rule.severity === 'BLOCK' ? 'BLOCK' : 'WARN '} ${rule.id} — ${rule.what}`);
    for (const hit of found) {
      console.log(`          ${hit.file}:${hit.line}  ${hit.reason}`);
      console.log(`            ${hit.text}`);
    }
  }

  if (blocking.length > 0) {
    console.error(`\ncheck:integrity FAILED — ${blocking.length} blocking hit(s).`);
    process.exit(1);
  }
  console.log('\ncheck:integrity passed. WARN hits are prompts to look, not verdicts.');
}

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return [];
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

main();
