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
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const REPO = resolve(import.meta.dirname, '..');
const ROOTS = ['platform', 'playground', 'spike', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
const TEST_CONFIG = /(vitest|jest|playwright)\.config\.[cm]?[jt]s$/;
const INTEGRATION_FILE = /integration/i;

type Severity = 'BLOCK' | 'WARN';

interface ScanHit {
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}

interface Rule {
  id: string;
  severity: Severity;
  what: string;
  /** Which files this rule reads. */
  applies: (path: string) => boolean;
  /**
   * Line-level detector. Return a reason to report a hit. Safe only for patterns that
   * cannot be defeated by line-wrapping or hidden inside a string literal — see `scanFile`
   * for anything that has to see a call's full, unwrapped argument list.
   */
  test?: (line: string, path: string) => string | null;
  /**
   * Whole-file, AST-based detector. Exists because a single line is the wrong shape for
   * "does this test call carry a `{ skip: true }` option": prettier is free to wrap that
   * call's arguments onto their own lines at this repo's own `printWidth`, and a test title
   * is free to contain `)` or `, { skip: true }` as ordinary text. A real parse sees past
   * both — an object literal argument's properties are unaffected by formatting and a
   * string literal's contents are never mistaken for syntax.
   */
  scanFile?: (content: string, path: string) => ScanHit[];
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
 * It also takes them as an options object — `test('name', { skip: true }, fn)` — and as a
 * runtime call inside the test body (`t.skip()` / `ctx.skip()`, node:test's own execution
 * context). All three are AST shapes, not regex-matchable line patterns: the first is
 * defeated by any `)` in the title and by prettier wrapping the call across lines, and a
 * line-scoped regex cannot distinguish an object literal's own `skip:` property from the
 * same text sitting inside a string literal.
 *
 * A parsed `ts.SourceFile` sidesteps all three at once — string contents are never syntax,
 * and node boundaries do not care how the source text is wrapped onto lines.
 */
const FOCUS_CALL_NAMES = new Set(['describe', 'it', 'test', 'bench']);
const FOCUS_DOTTED_NAMES = new Set(['only']);

const SKIP_OPTION_CALL_NAMES = new Set(['describe', 'it', 'test', 'suite']);
const SKIP_DOTTED_NAMES = new Set(['skip', 'todo', 'failing', 'skipIf']);
/** node:test's own execution-context parameter — conventionally named `t` or `ctx`. */
const RUNTIME_SKIP_RECEIVERS = new Set(['t', 'ctx']);

function parseTestFile(
  content: string,
  path: string,
): { calls: ts.CallExpression[]; sourceFile: ts.SourceFile } {
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { calls, sourceFile };
}

function identifierName(expr: ts.Expression): string | null {
  return ts.isIdentifier(expr) ? expr.text : null;
}

/** True only for the literal `false` — anything else (including a variable) is flagged, the
 *  same "unknown is not evidence of false" posture the rest of this repo takes. */
function isFalseLiteral(expr: ts.Expression): boolean {
  return expr.kind === ts.SyntaxKind.FalseKeyword;
}

/** The first own property among `keys` in any object-literal argument, whose value is not
 *  the literal `false`. Direct properties only — a property nested inside another object
 *  literal argument (e.g. `{ plan: { steps: 2 } }`) does not count as this call's own option. */
function findOptionProperty(
  call: ts.CallExpression,
  keys: ReadonlySet<string>,
): ts.ObjectLiteralElementLike | null {
  for (const arg of call.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      const name = prop.name !== undefined && ts.isIdentifier(prop.name) ? prop.name.text : null;
      if (name === null || !keys.has(name)) continue;
      if (ts.isPropertyAssignment(prop) && isFalseLiteral(prop.initializer)) continue;
      return prop;
    }
  }
  return null;
}

function lineOf(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function textOfLine(content: string, line: number): string {
  return (content.split(/\r?\n/)[line - 1] ?? '').trim();
}

export function focusedTestHits(content: string, path: string): ScanHit[] {
  const { calls, sourceFile } = parseTestFile(content, path);
  const hits: ScanHit[] = [];

  for (const call of calls) {
    const { expression } = call;

    if (
      ts.isPropertyAccessExpression(expression) &&
      FOCUS_DOTTED_NAMES.has(expression.name.text) &&
      FOCUS_CALL_NAMES.has(identifierName(expression.expression) ?? '')
    ) {
      const line = lineOf(sourceFile, expression.getStart());
      hits.push({ line, text: textOfLine(content, line), reason: 'focused' });
      continue;
    }

    const name = identifierName(expression);
    if (name !== null && FOCUS_CALL_NAMES.has(name)) {
      const prop = findOptionProperty(call, new Set(['only']));
      if (prop !== null) {
        const line = lineOf(sourceFile, prop.getStart());
        hits.push({ line, text: textOfLine(content, line), reason: 'focused' });
      }
    }
  }

  return hits;
}

export function skippedTestHits(content: string, path: string): ScanHit[] {
  const { calls, sourceFile } = parseTestFile(content, path);
  const hits: ScanHit[] = [];

  for (const call of calls) {
    const { expression } = call;

    if (ts.isPropertyAccessExpression(expression)) {
      const receiver = identifierName(expression.expression);
      const isSkipDotted =
        receiver !== null &&
        SKIP_OPTION_CALL_NAMES.has(receiver) &&
        SKIP_DOTTED_NAMES.has(expression.name.text);
      const isRuntimeSkip =
        receiver !== null &&
        RUNTIME_SKIP_RECEIVERS.has(receiver) &&
        expression.name.text === 'skip';

      if (isSkipDotted || isRuntimeSkip) {
        const line = lineOf(sourceFile, expression.getStart());
        hits.push({ line, text: textOfLine(content, line), reason: 'skipped' });
        continue;
      }
    }

    const name = identifierName(expression);
    if (name !== null && SKIP_OPTION_CALL_NAMES.has(name)) {
      const prop = findOptionProperty(call, new Set(['skip', 'todo']));
      if (prop !== null) {
        const line = lineOf(sourceFile, prop.getStart());
        hits.push({ line, text: textOfLine(content, line), reason: 'skipped' });
      }
    }
  }

  return hits;
}

const RULES: Rule[] = [
  {
    id: 'focused-test',
    severity: 'BLOCK',
    what: 'Focused test — silently hides the rest of the suite',
    applies: isTest,
    scanFile: focusedTestHits,
  },
  {
    id: 'skipped-test',
    severity: 'WARN',
    what: 'Skipped test — required coverage that does not execute is not a pass',
    applies: isTest,
    scanFile: skippedTestHits,
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

    const content = readFileSync(file, 'utf8');

    for (const rule of applicable) {
      if (rule.scanFile === undefined) continue;
      for (const hit of rule.scanFile(content, rel)) {
        hits.push({ rule, file: rel, line: hit.line, text: hit.text, reason: hit.reason });
      }
    }

    const lineRules = applicable.filter(
      (rule): rule is Rule & { test: NonNullable<Rule['test']> } => rule.test !== undefined,
    );
    if (lineRules.length > 0) {
      const lines = content.split(/\r?\n/);
      lines.forEach((text, index) => {
        for (const rule of lineRules) {
          const reason = rule.test(text, rel);
          if (reason !== null) {
            hits.push({ rule, file: rel, line: index + 1, text: text.trim(), reason });
          }
        }
      });
    }
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

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) main();
