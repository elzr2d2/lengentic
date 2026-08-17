/**
 * Scenarios for the knowledge-base retriever.
 *
 * A retriever is easy to write and easy to trust wrongly: it always returns *something*, and
 * a plausible-looking hit list reads as working. `CONTEXT.md` calls that a green that lies.
 * So most scenarios below run against inline fixture text, where the expected ranking is
 * derived from the fixture rather than from whatever the real documents happen to say today.
 *
 * Four scenarios do use the live corpus, because two of the guarantees are claims about this
 * repository and not about the algorithm: that `MVP_PLAN.md` is excluded by default, and that
 * `§19` still resolves to the section the plan numbers 19. Those would silently stop being
 * true if the corpus were only ever fixtures.
 *
 *   pnpm check:kb      (or)     tsx scripts/kb/selftest.ts
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  buildIndex,
  chunksOf,
  classify,
  corpus,
  frontmatter,
  glossary,
  rank,
  resolveTarget,
  tokenize,
  type Chunk,
} from '../kb.ts';

// ── harness ───────────────────────────────────────────────────────────────────────────

interface Result {
  n: number;
  name: string;
  pass: boolean;
  detail: string;
}

const results: Result[] = [];

/** A scenario returns `null` on pass, or the disagreement — expected AND actual, both. */
function scenario(n: number, name: string, fn: () => string | null): void {
  let detail: string | null;
  try {
    detail = fn();
  } catch (e: unknown) {
    detail = `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  results.push({ n, name, pass: detail === null, detail: detail ?? '' });
}

const TODAY = '2026-08-17';

// ── fixtures ──────────────────────────────────────────────────────────────────────────

const FENCED = `# 19. Safety Gates

All five must pass.

\`\`\`text
# G1 minSampleCount
# G2 distinctContextCount
\`\`\`

## Reporting rule

Every failing gate is reported by name.
`;

const NOTED = `---
title: a note
review-by: 2026-01-01
status: current
---

# Findings

The library changed its API.
`;

function fixtureCorpus(): Chunk[] {
  return [
    ...chunksOf(
      'a.md',
      'authoritative',
      '# Gates\n\ncontext diversity is the gate that matters.\n',
    ),
    ...chunksOf('b.md', 'authoritative', '# Sampling\n\ncontext appears here without diversity.\n'),
    ...chunksOf('c.md', 'historical', '# Gates\n\ncontext diversity gate, v2 wording.\n'),
  ];
}

// ── scenarios ─────────────────────────────────────────────────────────────────────────

scenario(1, 'a `#` inside a fenced block is not a heading', () => {
  const headings = chunksOf('f.md', 'authoritative', FENCED).map((c) => c.heading);
  const expected = ['19. Safety Gates', 'Reporting rule'];
  return JSON.stringify(headings) === JSON.stringify(expected)
    ? null
    : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(headings)}`;
});

scenario(2, 'the fenced gate names stay inside their own section', () => {
  const first = chunksOf('f.md', 'authoritative', FENCED)[0];
  if (!first) return 'expected a first chunk, got none';
  return first.body.includes('G2 distinctContextCount')
    ? null
    : `expected §19's body to keep the fenced G2 line, got: ${JSON.stringify(first.body)}`;
});

scenario(3, 'the heading line is the citation, and the end line is the section end', () => {
  const chunks = chunksOf('f.md', 'authoritative', FENCED);
  const second = chunks[1];
  if (!second) return 'expected two chunks';
  // `## Reporting rule` is line 10 of FENCED; its last non-blank line is 12.
  return second.line === 10 && second.endLine === 12
    ? null
    : `expected line 10-12, got ${second.line}-${second.endLine}`;
});

scenario(4, 'the breadcrumb records the ancestors, not the section itself', () => {
  const second = chunksOf('f.md', 'authoritative', FENCED)[1];
  if (!second) return 'expected two chunks';
  return JSON.stringify(second.trail) === JSON.stringify(['19. Safety Gates'])
    ? null
    : `expected ["19. Safety Gates"], got ${JSON.stringify(second.trail)}`;
});

scenario(5, 'front matter is metadata, never a heading, and never body text', () => {
  const fm = frontmatter(NOTED);
  const chunks = chunksOf('n.md', 'expiring', NOTED);
  const first = chunks[0];
  if (!first) return 'expected one chunk';
  if (fm['review-by'] !== '2026-01-01')
    return `expected review-by 2026-01-01, got ${fm['review-by']}`;
  if (chunks.length !== 1)
    return `expected 1 chunk, got ${chunks.length}: ${chunks.map((c) => c.heading).join(', ')}`;
  return first.body.includes('title: a note')
    ? `expected the body to exclude front matter, got: ${JSON.stringify(first.body)}`
    : null;
});

scenario(6, 'a section number and a phase number are extracted from the heading', () => {
  const plan = chunksOf(
    'p.md',
    'authoritative',
    '# 20.1 Deterministic Candidate\n\nx\n\n# PHASE 5 — ANALYSIS ENGINE\n\ny\n',
  );
  const a = plan[0];
  const b = plan[1];
  if (!a || !b) return 'expected two chunks';
  if (a.section !== '20.1') return `expected section 20.1, got "${a.section}"`;
  return b.phase === '5' ? null : `expected phase 5, got "${b.phase}"`;
});

scenario(7, 'camelCase is indexed under all three spellings a human might type', () => {
  const t = new Set(tokenize('contextKey groups a Decision'));
  const missing = ['contextkey', 'context', 'key'].filter((x) => !t.has(x));
  return missing.length === 0
    ? null
    : `expected contextkey/context/key, missing ${missing.join(', ')} — got ${[...t].join(' ')}`;
});

scenario(8, 'BM25 puts the section carrying both query terms first', () => {
  const chunks = fixtureCorpus();
  const hits = rank(buildIndex(chunks), 'context diversity', {
    all: false,
    limit: 5,
    today: TODAY,
  });
  const first = hits[0];
  if (!first) return 'expected at least one hit, got none';
  return first.chunk.file === 'a.md'
    ? null
    : `expected a.md first, got ${hits.map((h) => `${h.chunk.file}:${h.score.toFixed(2)}`).join(' ')}`;
});

scenario(9, 'a historical section is excluded by default and returned under --all', () => {
  const index = buildIndex(fixtureCorpus());
  const shut = rank(index, 'context diversity gate', { all: false, limit: 9, today: TODAY });
  const open = rank(index, 'context diversity gate', { all: true, limit: 9, today: TODAY });
  if (shut.some((h) => h.chunk.file === 'c.md')) {
    return `expected c.md excluded by default, got ${shut.map((h) => h.chunk.file).join(' ')}`;
  }
  return open.some((h) => h.chunk.file === 'c.md')
    ? null
    : `expected c.md under --all, got ${open.map((h) => h.chunk.file).join(' ')}`;
});

scenario(10, 'a stale note is demoted below the same text in an authoritative file', () => {
  const fresh = chunksOf('x.md', 'authoritative', '# Gates\n\ncontext diversity gate.\n');
  const note = chunksOf(
    'docs/research/README.md',
    'expiring',
    '# Gates\n\ncontext diversity gate.\n',
  );
  const hits = rank(buildIndex([...note, ...fresh]), 'context diversity gate', {
    all: false,
    limit: 5,
    today: TODAY,
  });
  const first = hits[0];
  if (!first) return 'expected hits';
  return first.chunk.file === 'x.md'
    ? null
    : `expected the authoritative file first, got ${hits.map((h) => h.chunk.file).join(' ')}`;
});

scenario(11, 'the snippet cites the best line inside the section, not the heading line', () => {
  const chunks = chunksOf(
    'q.md',
    'authoritative',
    '# Overview\n\nfiller line.\n\nthe escape hatch is named by the recommendation.\n',
  );
  const hits = rank(buildIndex(chunks), 'escape hatch', { all: false, limit: 3, today: TODAY });
  const first = hits[0];
  if (!first) return 'expected a hit';
  return first.snippetLine === 5
    ? null
    : `expected the snippet to cite line 5, got ${first.snippetLine} ("${first.snippet}")`;
});

scenario(12, 'path decides status: v2 historical, generated generated, research expiring', () => {
  const cases: Array<[string, string]> = [
    ['MVP_PLAN.md', 'historical'],
    ['docs/superpowers/specs/x.md', 'historical'],
    ['docs/PROJECT_STATUS.md', 'generated'],
    ['.artifacts/plans/remaining-roadmap.md', 'generated'],
    ['docs/research/2026-08-16-note.md', 'expiring'],
    ['docs/research/README.md', 'authoritative'],
    ['MVP_PLAN_V3.md', 'authoritative'],
  ];
  const wrong = cases.filter(([f, want]) => classify(f) !== want);
  return wrong.length === 0
    ? null
    : wrong.map(([f, want]) => `${f}: expected ${want}, got ${classify(f)}`).join('; ');
});

scenario(13, '`show` resolves a section number, a phase, and FILE.md#heading', () => {
  const chunks = chunksOf(
    'plan.md',
    'authoritative',
    '# 19. Safety Gates\n\na\n\n# PHASE 5 — ANALYSIS ENGINE\n\nb\n\n## Objective\n\nc\n',
  );
  const bySection = resolveTarget(chunks, '§19');
  const byPhase = resolveTarget(chunks, 'phase 5');
  const byHash = resolveTarget(chunks, 'plan.md#objective');
  if (bySection[0]?.heading !== '19. Safety Gates') {
    return `§19 resolved to ${JSON.stringify(bySection.map((c) => c.heading))}`;
  }
  if (byPhase[0]?.phase !== '5') {
    return `phase 5 resolved to ${JSON.stringify(byPhase.map((c) => c.heading))}`;
  }
  return byHash[0]?.heading === 'Objective'
    ? null
    : `plan.md#objective resolved to ${JSON.stringify(byHash.map((c) => c.heading))}`;
});

scenario(
  14,
  '`show` never resolves a target to a historical section when a live one exists',
  () => {
    const chunks = [
      ...chunksOf('MVP_PLAN.md', 'historical', '# 19. Something else\n\nold\n'),
      ...chunksOf('MVP_PLAN_V3.md', 'authoritative', '# 19. Safety Gates\n\nnew\n'),
    ];
    const found = resolveTarget(chunks, '§19');
    return found.length === 1 && found[0]?.file === 'MVP_PLAN_V3.md'
      ? null
      : `expected only MVP_PLAN_V3.md, got ${JSON.stringify(found.map((c) => c.file))}`;
  },
);

// ── live corpus ───────────────────────────────────────────────────────────────────────

scenario(15, 'the live corpus indexes the plan and excludes v2 from a real search', () => {
  const chunks = corpus();
  if (!chunks.some((c) => c.file === 'MVP_PLAN_V3.md')) return 'MVP_PLAN_V3.md is not indexed';
  if (!chunks.some((c) => c.file === 'MVP_PLAN.md' && c.status === 'historical')) {
    return 'MVP_PLAN.md is indexed but not classified historical';
  }
  const hits = rank(buildIndex(chunks), 'ingestion envelope merge rules', {
    all: false,
    limit: 10,
    today: TODAY,
  });
  const leaked = hits.filter((h) => h.chunk.status === 'historical');
  return leaked.length === 0
    ? null
    : `expected no historical hits, got ${leaked.map((h) => h.chunk.file).join(' ')}`;
});

scenario(16, 'a real query lands on the section that owns the answer', () => {
  const hits = rank(buildIndex(corpus()), 'context diversity gate G2', {
    all: false,
    limit: 5,
    today: TODAY,
  });
  const hit = hits.find((h) => /gate/i.test(h.chunk.heading) || /G2/.test(h.snippet));
  return hit
    ? null
    : `expected a gate section in the top 5, got ${hits
        .map((h) => `${h.chunk.file}:${h.chunk.line} ${h.chunk.heading}`)
        .join(' | ')}`;
});

scenario(17, '`§19` on the live plan is still Safety Gates', () => {
  const found = resolveTarget(corpus(), '§19').filter((c) => c.file === 'MVP_PLAN_V3.md');
  const heading = found[0]?.heading ?? '(none)';
  return /safety gates/i.test(heading)
    ? null
    : `expected /safety gates/i in MVP_PLAN_V3.md, got "${heading}"`;
});

scenario(18, 'the glossary parses, and a known term carries its definition', () => {
  const entries = glossary();
  if (entries.length < 20) return `expected 20+ CONTEXT.md entries, got ${entries.length}`;
  const key = entries.find((e) => e.term === 'contextKey');
  if (!key)
    return `contextKey not parsed — got ${entries
      .slice(0, 8)
      .map((e) => e.term)
      .join(', ')}`;
  return /computed by the caller/i.test(key.definition)
    ? null
    : `expected contextKey's definition to say it is caller-computed, got: ${key.definition.slice(0, 120)}`;
});

// ── report ────────────────────────────────────────────────────────────────────────────

function report(): number {
  const failed = results.filter((r) => !r.pass);
  console.log('\nknowledge-base scenarios\n');
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
