/**
 * Fixture scenarios for `check-integrity.ts`'s `focused-test` / `skipped-test` detectors.
 *
 * Every scenario here is an evading spelling the Phase 3 wave-2 gate found by attacking the
 * scanner directly (`.artifacts/evidence/3/wave2-gate/reviewer/review-diff.md` S6,
 * `.artifacts/evidence/3/wave2-gate/validator/README.md`): a real `it`/`describe`/`test`
 * call, or a real `t.skip()`/`ctx.skip()` runtime call, in the exact shape that used to slip
 * a line-scoped regex — a `)` in the title, a prettier-wrapped options object, a nested
 * object literal before the real `skip:` key, or the option text sitting inside a string
 * literal instead of real syntax. Each is checked against the source text directly
 * (`focusedTestHits` / `skippedTestHits`), not against files on disk, so this file has no
 * fixture files of its own to keep in sync.
 *
 *   pnpm check:integrity-self
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { focusedTestHits, skippedTestHits } from '../check-integrity.ts';

interface Result {
  n: number;
  name: string;
  pass: boolean;
  detail: string;
}

const results: Result[] = [];

function scenario(n: number, name: string, fn: () => string | null): void {
  let detail: string | null;
  try {
    detail = fn();
  } catch (e: unknown) {
    detail = `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  results.push({ n, name, pass: detail === null, detail: detail ?? 'ok' });
}

function expect(cond: boolean, message: string): string | null {
  return cond ? null : message;
}

const PATH = 'fixture.spec.ts';

// ── skipped-test: must hit ───────────────────────────────────────────────────────────────

scenario(1, 'baseline: single-line { skip: true }', () => {
  const hits = skippedTestHits(`it('plain name', { skip: true }, fn);`, PATH);
  return expect(hits.length === 1, `expected 1 hit, got ${hits.length}`);
});

scenario(2, 'title containing ")" no longer defeats the scan', () => {
  const hits = skippedTestHits(`it('resolves (eventually)', { skip: true }, fn);`, PATH);
  return expect(hits.length === 1, `expected 1 hit, got ${hits.length}`);
});

scenario(3, 'describe title containing "—" and ")"', () => {
  const hits = skippedTestHits(
    `describe('MockProvider — invoke() delay', { skip: true }, fn);`,
    PATH,
  );
  return expect(hits.length === 1, `expected 1 hit, got ${hits.length}`);
});

scenario(4, 'prettier-wrapped options object, one property per line', () => {
  const hits = skippedTestHits(
    [
      `void it(`,
      `  'NEGATIVE — with the default delay (0ms), invoke() resolves without the scheduler advancing',`,
      `  { skip: true },`,
      `  async () => { /* body */ },`,
      `);`,
    ].join('\n'),
    PATH,
  );
  return expect(hits.length === 1, `expected 1 hit, got ${hits.length}`);
});

scenario(5, 'nested object literal before the real skip key', () => {
  const hits = skippedTestHits(`it('x', { plan: { steps: 2 }, skip: true }, fn);`, PATH);
  return expect(hits.length === 1, `expected 1 hit, got ${hits.length}`);
});

scenario(6, 'runtime t.skip() inside the test body', () => {
  const hits = skippedTestHits(
    [`it('x', (t) => {`, `  t.skip('not ready');`, `});`].join('\n'),
    PATH,
  );
  return expect(hits.length === 1, `expected 1 hit, got ${hits.length}`);
});

scenario(7, 'runtime ctx.skip() inside the test body', () => {
  const hits = skippedTestHits([`it('x', (ctx) => {`, `  ctx.skip();`, `});`].join('\n'), PATH);
  return expect(hits.length === 1, `expected 1 hit, got ${hits.length}`);
});

scenario(8, 'todo option with a string reason', () => {
  const hits = skippedTestHits(`it('x', { todo: 'later' }, fn);`, PATH);
  return expect(hits.length === 1, `expected 1 hit, got ${hits.length}`);
});

scenario(9, 'dotted it.skip(...) form (regression: must still work)', () => {
  const hits = skippedTestHits(`it.skip('x', fn);`, PATH);
  return expect(hits.length === 1, `expected 1 hit, got ${hits.length}`);
});

scenario(10, 'dotted it.skipIf(...) form (regression: must still work)', () => {
  const hits = skippedTestHits(`it.skipIf(cond)('x', fn);`, PATH);
  return expect(hits.length === 1, `expected 1 hit, got ${hits.length}`);
});

// ── skipped-test: must NOT hit ────────────────────────────────────────────────────────────

scenario(11, 'false positive: ", { skip: true }" inside a string literal', () => {
  const hits = skippedTestHits(`it('rejects a config, { skip: true } style', fn);`, PATH);
  return expect(hits.length === 0, `expected 0 hits, got ${hits.length}: ${JSON.stringify(hits)}`);
});

scenario(12, 'skip: false is not a skip', () => {
  const hits = skippedTestHits(`it('x', { skip: false }, fn);`, PATH);
  return expect(hits.length === 0, `expected 0 hits, got ${hits.length}: ${JSON.stringify(hits)}`);
});

scenario(13, 'skip:false with no space is not a skip', () => {
  const hits = skippedTestHits(`it('x', { skip:false }, fn);`, PATH);
  return expect(hits.length === 0, `expected 0 hits, got ${hits.length}: ${JSON.stringify(hits)}`);
});

scenario(14, 'a plain call with no options object at all', () => {
  const hits = skippedTestHits(`it('x', async () => { doSomething(); });`, PATH);
  return expect(hits.length === 0, `expected 0 hits, got ${hits.length}: ${JSON.stringify(hits)}`);
});

// ── focused-test: must hit ────────────────────────────────────────────────────────────────

scenario(15, 'only: true option with a ")" in the title', () => {
  const hits = focusedTestHits(`it('invoke() resolves', { only: true }, fn);`, PATH);
  return expect(hits.length === 1, `expected 1 hit, got ${hits.length}`);
});

scenario(16, 'dotted it.only(...) form (regression: must still work)', () => {
  const hits = focusedTestHits(`it.only('x', fn);`, PATH);
  return expect(hits.length === 1, `expected 1 hit, got ${hits.length}`);
});

scenario(17, 'dotted describe.only(...) form (regression: must still work)', () => {
  const hits = focusedTestHits(`describe.only('x', fn);`, PATH);
  return expect(hits.length === 1, `expected 1 hit, got ${hits.length}`);
});

// ── focused-test: must NOT hit ────────────────────────────────────────────────────────────

scenario(18, 'only: false is not a focus', () => {
  const hits = focusedTestHits(`it('x', { only: false }, fn);`, PATH);
  return expect(hits.length === 0, `expected 0 hits, got ${hits.length}: ${JSON.stringify(hits)}`);
});

scenario(19, 'skipped-test detector does not also fire on an only-only call', () => {
  const hits = skippedTestHits(`it('x', { only: true }, fn);`, PATH);
  return expect(hits.length === 0, `expected 0 hits, got ${hits.length}: ${JSON.stringify(hits)}`);
});

function report(): number {
  const failed = results.filter((r) => !r.pass);
  console.log('\ncheck-integrity scanner scenarios\n');
  for (const r of results.sort((a, b) => a.n - b.n)) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${String(r.n).padStart(2)}  ${r.name}`);
    if (!r.pass) console.log(`              ${r.detail}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  return failed.length === 0 ? 0 : 1;
}

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) process.exit(report());
