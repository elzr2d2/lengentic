/**
 * LenGentic knowledge base — retrieval over the repository's prose.
 *
 * Answers four questions about the documents, mechanically:
 *
 *   where is this discussed?        `pnpm kb search <words>`
 *   show me only that section       `pnpm kb show §19`
 *   what does this word mean here?  `pnpm kb term contextKey`
 *   what will a full read cost?     `pnpm kb map`
 *
 * ## Why lexical and not embeddings
 *
 * The corpus is ~200 KB of markdown across a handful of files. Ranking it with BM25 takes
 * about 50 ms from a cold start, so there is no index to persist and therefore no index that
 * can go stale — the failure mode that makes a vector store lie after a doc edit. It also
 * needs no API key, no network and no service, which keeps `pnpm kb` usable in the same
 * places `pnpm gates` is usable. And it is deterministic: the same query returns the same
 * ranking, which is the standing rule in this repository for anything that produces evidence.
 *
 * An embedding index earns its cost when the corpus is large enough that a full scan hurts,
 * or when queries and documents share no vocabulary. Neither holds here: `CONTEXT.md` exists
 * precisely so that humans, agents and code use the *same words*, which is the condition
 * under which lexical retrieval is at its strongest.
 *
 * ## What it will not do
 *
 * Ranking is not judgment. A hit is a pointer to a line, never a claim that the line is
 * current or that it answers the question. Two guards are mechanical instead of remembered:
 *
 *   - `MVP_PLAN.md` (v2) and `docs/superpowers/specs/**` are HISTORICAL and are excluded
 *     from search unless `--all`, then tagged. v3 wins on conflict, and a v2 section number
 *     quoted as a v3 one is the exact bug `CLAUDE.md` warns about.
 *   - `docs/research/**` carries a `review-by`. Past it, a hit is tagged STALE and demoted.
 *     `pnpm kb stale` exits non-zero on one, because citing it is a rule violation.
 *
 * Code is grep's job. This tool indexes `.md` only.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── corpus ────────────────────────────────────────────────────────────────────────────

/**
 * How much a hit from this file is worth trusting. Status is derived from the path, not
 * declared per file, so a new document is classified the moment it lands.
 */
export type Status = 'authoritative' | 'generated' | 'historical' | 'expiring';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  'generated',
  '.turbo',
  // A consumed session handoff is spent process residue. It reads like current instruction,
  // which is exactly why it must not surface next to the plan.
  'consumed',
]);

/** One runaway file cannot be allowed to make the whole index slow. */
const MAX_BYTES = 1_000_000;

export function classify(file: string): Status {
  const f = file.replace(/\\/g, '/');
  if (f === 'MVP_PLAN.md' || f.startsWith('docs/superpowers/') || f.startsWith('docs/archive/'))
    return 'historical';
  if (f.startsWith('.artifacts/')) return 'generated';
  if (f.startsWith('docs/research/') && !f.endsWith('README.md')) return 'expiring';
  return 'authoritative';
}

export function walkMarkdown(dir: string = ROOT, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(full, out);
    else if (e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

/** Naive on purpose: front matter in this repository is flat `key: value` lines. */
export function frontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return {};
  const out: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') break;
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (m) out[(m[1] ?? '').toLowerCase()] = (m[2] ?? '').trim();
  }
  return out;
}

function bodyStart(text: string): number {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '---') return i + 1;
  }
  return 0;
}

// ── chunking ──────────────────────────────────────────────────────────────────────────

/**
 * A chunk is one heading and the text under it, which is the unit a reader actually wants
 * back. `line` is the heading's line so every hit is a citation you can click.
 */
export interface Chunk {
  file: string;
  status: Status;
  line: number;
  endLine: number;
  level: number;
  heading: string;
  /** Ancestor headings, outermost first. The path that tells you where you landed. */
  trail: string[];
  /** `19` for `# 19. Safety Gates`, `20.1` for a sub-numbered section, else ''. */
  section: string;
  /** `5` for `# PHASE 5 — ANALYSIS ENGINE`, else ''. */
  phase: string;
  body: string;
  tokens: string[];
  tf: Map<string, number>;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE = /^\s*(?:```|~~~)/;

function numbering(heading: string): { section: string; phase: string } {
  // Both spellings the plan uses: `# 19. Safety Gates` and `## 20.1 Deterministic Candidate`.
  const sec = /^(\d+(?:\.\d+)*)[.)]?\s+/.exec(heading);
  const ph = /^PHASE\s+([0-9]+[a-z]?)/i.exec(heading);
  return { section: sec?.[1] ?? '', phase: ph?.[1]?.toLowerCase() ?? '' };
}

/**
 * Fenced blocks are skipped when looking for headings. `MVP_PLAN_V3.md` contains ```text
 * blocks with `#` lines in them, and treating one as a section boundary would split a
 * section in half and cite the wrong line.
 */
export function chunksOf(file: string, status: Status, text: string): Chunk[] {
  const lines = text.split(/\r?\n/);
  const from = bodyStart(text);
  const chunks: Chunk[] = [];
  const trail: string[] = [];

  let fenced = false;
  let open: { line: number; level: number; heading: string; trail: string[] } | null = null;
  let buffer: string[] = [];

  const close = (endLine: number): void => {
    if (!open) {
      // Preamble: text before the first heading. Kept only when it says something.
      if (buffer.join('').trim() !== '') {
        chunks.push(make(file, status, from + 1, endLine, 0, '(preamble)', [], buffer.join('\n')));
      }
      buffer = [];
      return;
    }
    chunks.push(
      make(
        file,
        status,
        open.line,
        endLine,
        open.level,
        open.heading,
        open.trail,
        [`${'#'.repeat(open.level)} ${open.heading}`, ...buffer].join('\n'),
      ),
    );
    buffer = [];
  };

  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (FENCE.test(line)) fenced = !fenced;

    const m = fenced ? null : HEADING.exec(line);
    if (!m) {
      buffer.push(line);
      continue;
    }

    close(i);
    const level = (m[1] ?? '#').length;
    const heading = m[2] ?? '';
    while (trail.length >= level) trail.pop();
    open = { line: i + 1, level, heading, trail: [...trail] };
    trail.push(heading);
  }
  close(lines.length);
  return chunks;
}

function make(
  file: string,
  status: Status,
  line: number,
  endLine: number,
  level: number,
  heading: string,
  trail: string[],
  body: string,
): Chunk {
  const trimmed = body.replace(/\s+$/, '');
  const { section, phase } = numbering(heading);
  const tokens = tokenize(`${heading} ${trimmed}`);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return {
    file,
    status,
    line,
    endLine: Math.max(line, line + trimmed.split('\n').length - 1),
    level,
    heading,
    trail,
    section,
    phase,
    body: trimmed,
    tokens,
    tf,
  };
}

// ── tokens ────────────────────────────────────────────────────────────────────────────

const STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'is',
  'it',
  'to',
  'in',
  'for',
  'on',
  'that',
  'this',
  'with',
  'as',
  'by',
  'be',
  'are',
  'not',
  'but',
  'from',
  'at',
  'if',
  'its',
  'was',
  'were',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'so',
  'than',
  'then',
  'there',
  'their',
  'what',
]);

/**
 * `contextKey` is indexed as `contextkey`, `context` and `key`, so all three spellings a
 * human might type reach the same chunk. Digits survive alone because `§19` and `G2` are
 * how sections and gates are named here.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  for (const word of input.split(/[^A-Za-z0-9]+/)) {
    if (word === '') continue;
    const joined = word.toLowerCase();
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/\s+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p !== '');
    const candidates = parts.length > 1 ? [joined, ...parts] : [joined];
    for (const c of candidates) {
      if (STOP.has(c)) continue;
      if (c.length < 2 && !/^\d$/.test(c)) continue;
      out.push(c);
    }
  }
  return out;
}

// ── ranking ───────────────────────────────────────────────────────────────────────────

export interface Index {
  chunks: Chunk[];
  df: Map<string, number>;
  avgdl: number;
}

export function buildIndex(chunks: Chunk[]): Index {
  const df = new Map<string, number>();
  let total = 0;
  for (const c of chunks) {
    total += c.tokens.length;
    for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { chunks, df, avgdl: chunks.length === 0 ? 1 : total / chunks.length };
}

const K1 = 1.2;
const B = 0.75;

/** How far a status moves a score. Historical loses half; a stale note loses a third. */
const TRUST: Record<Status, number> = {
  authoritative: 1,
  generated: 0.85,
  expiring: 0.95,
  historical: 0.45,
};

export interface Hit {
  chunk: Chunk;
  score: number;
  /** Line number of the single best line in the chunk — the tightest citation available. */
  snippetLine: number;
  snippet: string;
  stale: boolean;
}

export interface RankOptions {
  /** Include HISTORICAL documents. They are tagged, never silently mixed in. */
  all: boolean;
  limit: number;
  /** Compared against `review-by` to decide staleness. Injected so a test is not dated. */
  today: string;
}

export function rank(index: Index, query: string, opts: RankOptions): Hit[] {
  const qt = [...new Set(tokenize(query))];
  if (qt.length === 0) return [];
  const phrase = query.trim().toLowerCase();
  const usePhrase = phrase.includes(' ');
  const n = index.chunks.length;
  const hits: Hit[] = [];

  for (const c of index.chunks) {
    if (!opts.all && c.status === 'historical') continue;

    let score = 0;
    for (const t of qt) {
      const tf = c.tf.get(t);
      if (tf === undefined) continue;
      const df = index.df.get(t) ?? 1;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * c.tokens.length) / index.avgdl)));
    }
    if (score === 0) continue;

    // A query term in the heading or the breadcrumb is a much stronger signal than the same
    // term buried in prose: headings are what the author chose to call the section.
    const headTokens = new Set(tokenize([c.heading, ...c.trail].join(' ')));
    const headHits = qt.filter((t) => headTokens.has(t)).length;
    score *= Math.min(2.2, 1 + 0.35 * headHits);
    if (usePhrase && c.body.toLowerCase().includes(phrase)) score *= 1.4;

    const stale = c.status === 'expiring' && staleFile(c.file, opts.today) !== null;
    score *= stale ? 0.65 : TRUST[c.status];

    const best = bestLine(c, qt);
    hits.push({ chunk: c, score, snippetLine: best.line, snippet: best.text, stale });
  }

  return hits
    .sort((a, b) => b.score - a.score || a.chunk.file.localeCompare(b.chunk.file))
    .slice(0, opts.limit);
}

function bestLine(c: Chunk, qt: string[]): { line: number; text: string } {
  const lines = c.body.split('\n');
  // The heading is already printed above the snippet. Quoting it back adds nothing, so the
  // search starts at the body — unless the section is a heading and nothing else.
  const from = c.level > 0 && lines.length > 1 ? 1 : 0;
  let bestIdx = from;
  let bestScore = -1;
  for (let i = from; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') continue;
    const seen = new Set(tokenize(raw));
    const score = qt.filter((t) => seen.has(t)).length;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  const text = (lines[bestIdx] ?? '').replace(/\s+/g, ' ').trim();
  return {
    line: c.line + bestIdx,
    text: text.length > 150 ? `${text.slice(0, 149)}…` : text,
  };
}

// ── loading ───────────────────────────────────────────────────────────────────────────

let cached: Chunk[] | null = null;

export function corpus(): Chunk[] {
  if (cached) return cached;
  const chunks: Chunk[] = [];
  for (const abs of walkMarkdown()) {
    let size = 0;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    if (size > MAX_BYTES) continue;
    const file = relative(ROOT, abs).replace(/\\/g, '/');
    chunks.push(...chunksOf(file, classify(file), readFileSync(abs, 'utf8')));
  }
  cached = chunks;
  return chunks;
}

// ── staleness ─────────────────────────────────────────────────────────────────────────

export interface StaleNote {
  file: string;
  reviewBy: string;
  daysOver: number;
  status: string;
}

function days(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** Returns the overdue record, or `null` when the note is still inside its review window. */
export function staleFile(file: string, today: string): StaleNote | null {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) return null;
  const fm = frontmatter(readFileSync(abs, 'utf8'));
  const reviewBy = fm['review-by'] ?? '';
  if (reviewBy === '') return null;
  const over = days(reviewBy, today);
  if (over <= 0) return null;
  return { file, reviewBy, daysOver: over, status: fm['status'] ?? 'unknown' };
}

export function staleNotes(today: string): StaleNote[] {
  const files = [
    ...new Set(
      corpus()
        .filter((c) => c.status === 'expiring')
        .map((c) => c.file),
    ),
  ];
  return files
    .map((f) => staleFile(f, today))
    .filter((s): s is StaleNote => s !== null)
    .sort((a, b) => b.daysOver - a.daysOver);
}

// ── target resolution ─────────────────────────────────────────────────────────────────

/**
 * What `show` accepts, in the order it tries:
 *
 *   §19  19            a numbered plan section
 *   phase 5   5a       a phase heading
 *   FILE.md#heading    a heading inside one file
 *   safety gates       a heading substring, anywhere
 */
export function resolveTarget(chunks: Chunk[], target: string): Chunk[] {
  const t = target.trim();
  const live = chunks.filter((c) => c.status !== 'historical');
  const pool = live.length > 0 ? live : chunks;

  const hashed = /^(.+\.md)#(.+)$/i.exec(t);
  if (hashed) {
    const file = (hashed[1] ?? '').replace(/\\/g, '/').toLowerCase();
    const want = (hashed[2] ?? '').toLowerCase();
    return pool.filter(
      (c) => c.file.toLowerCase().endsWith(file) && c.heading.toLowerCase().includes(want),
    );
  }

  const sec = /^(?:§|section\s+)?(\d+(?:\.\d+)*)$/i.exec(t);
  if (sec) {
    const want = sec[1] ?? '';
    const found = pool.filter((c) => c.section === want);
    if (found.length > 0) return found;
  }

  const ph = /^(?:phase\s+)?([0-9]+[a-z]?)$/i.exec(t);
  if (ph) {
    const want = (ph[1] ?? '').toLowerCase();
    const found = pool.filter((c) => c.phase === want);
    if (found.length > 0) return found;
  }

  const want = t.toLowerCase();
  const exact = pool.filter((c) => c.heading.toLowerCase() === want);
  if (exact.length > 0) return exact;
  return pool.filter((c) => c.heading.toLowerCase().includes(want));
}

// ── glossary ──────────────────────────────────────────────────────────────────────────

export interface Entry {
  term: string;
  line: number;
  definition: string;
}

const GLOSSARY = 'CONTEXT.md';

/** `**contextKey** — a short stable string…`. The one shape `CONTEXT.md` uses. */
export function glossary(): Entry[] {
  const abs = join(ROOT, GLOSSARY);
  if (!existsSync(abs)) return [];
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  const out: Entry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\*\*(.+?)\*\*\s*(?:—|-|:)\s*(.*)$/.exec(lines[i] ?? '');
    if (!m) continue;
    const body: string[] = [m[2] ?? ''];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      if (next.trim() === '') break;
      body.push(next.trim());
    }
    for (const name of (m[1] ?? '').split(/\s*\/\s*/)) {
      out.push({ term: name.trim(), line: i + 1, definition: body.join(' ') });
    }
  }
  return out;
}

export interface Usage {
  file: string;
  status: Status;
  count: number;
  line: number;
}

export function usages(term: string): Usage[] {
  const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  const byFile = new Map<string, Usage>();
  for (const c of corpus()) {
    const lines = c.body.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const found = (lines[i] ?? '').match(pattern)?.length ?? 0;
      if (found === 0) continue;
      const prior = byFile.get(c.file);
      if (prior) prior.count += found;
      else byFile.set(c.file, { file: c.file, status: c.status, count: found, line: c.line + i });
    }
  }
  return [...byFile.values()].sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

// ── rendering ─────────────────────────────────────────────────────────────────────────

const TAG: Record<Status, string> = {
  authoritative: '',
  generated: ' [GENERATED]',
  historical: ' [HISTORICAL — v3 wins]',
  expiring: '',
};

function renderHits(hits: Hit[], query: string, index: Index): string {
  if (hits.length === 0) {
    return `  no section matches "${query}" · ${index.chunks.length} sections indexed\n`;
  }
  const out: string[] = [];
  for (const h of hits) {
    const c = h.chunk;
    const tag = h.stale ? ' [STALE — past review-by]' : TAG[c.status];
    out.push(`  ${h.score.toFixed(1).padStart(5)}  ${c.file}:${c.line}  ${c.heading}${tag}`);
    if (c.trail.length > 0) out.push(`         ${c.trail.join(' › ')}`);
    out.push(`         ${c.file}:${h.snippetLine}  ${h.snippet}`);
    out.push('');
  }
  out.push(`  ${hits.length} shown · ${index.chunks.length} sections indexed`);
  out.push(`  read one with:  pnpm kb show "${hits[0]?.chunk.heading ?? ''}"`);
  return out.join('\n');
}

function renderMap(chunks: Chunk[]): string {
  const byFile = new Map<string, { status: Status; sections: number; bytes: number }>();
  for (const c of chunks) {
    const row = byFile.get(c.file) ?? { status: c.status, sections: 0, bytes: 0 };
    row.sections += 1;
    row.bytes += c.body.length;
    byFile.set(c.file, row);
  }
  const rows = [...byFile.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  const out: string[] = ['', '  ~TOKENS  SECTIONS  STATUS         FILE'];
  const SHOWN = 20;
  let tokens = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const entry = rows[i];
    if (!entry) continue;
    const [file, row] = entry;
    const est = Math.round(row.bytes / 4);
    tokens += est;
    if (i < SHOWN) {
      out.push(
        `  ${String(est).padStart(7)}  ${String(row.sections).padStart(8)}  ` +
          `${row.status.padEnd(13)}  ${file}`,
      );
    }
  }
  const hidden = rows.length - Math.min(rows.length, SHOWN);
  if (hidden > 0) out.push(`  ${' '.repeat(24)}… ${hidden} smaller files not shown`);
  out.push('');
  out.push(
    `  ${rows.length} files · ${chunks.length} sections · ~${tokens} tokens to read all of it`,
  );
  out.push('  a section averages ~1% of that. Search first.');
  return out.join('\n');
}

// ── cli ───────────────────────────────────────────────────────────────────────────────

const USAGE = `usage: pnpm kb <command>

  search <words…>   rank sections by relevance      [--all] [--limit n] [--json]
  show <target>     print one section verbatim      §19 | phase 5 | FILE.md#heading | heading
  term <name>       CONTEXT.md definition + where the word is actually used
  map               what each document costs to read, in tokens
  stale             research notes past review-by, and generated files behind their source

  --all     include HISTORICAL documents (MVP_PLAN.md v2, docs/superpowers/**)
  --today   YYYY-MM-DD, for staleness. Defaults to the system date`;

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) main();

function main(): void {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const named = (name: string, fallback: string): string => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? fallback : hit.slice(name.length + 3);
  };
  const rest = argv.filter((a) => !a.startsWith('--'));
  const cmd = rest[0] ?? 'help';
  const args = rest.slice(1);
  const today = named('today', new Date().toISOString().slice(0, 10));
  const json = flags.has('--json');

  switch (cmd) {
    case 'search': {
      const query = args.join(' ');
      if (query === '') {
        console.error('usage: pnpm kb search <words…>');
        process.exit(1);
      }
      const index = buildIndex(corpus());
      const hits = rank(index, query, {
        all: flags.has('--all'),
        limit: Number(named('limit', '8')) || 8,
        today,
      });
      if (json) {
        console.log(
          JSON.stringify(
            hits.map((h) => ({
              score: Number(h.score.toFixed(3)),
              file: h.chunk.file,
              line: h.chunk.line,
              endLine: h.chunk.endLine,
              heading: h.chunk.heading,
              trail: h.chunk.trail,
              status: h.chunk.status,
              stale: h.stale,
              citation: `${h.chunk.file}:${h.snippetLine}`,
              snippet: h.snippet,
            })),
            null,
            2,
          ),
        );
        break;
      }
      console.log('');
      console.log(renderHits(hits, query, index));
      console.log('');
      break;
    }

    case 'show': {
      const target = args.join(' ');
      if (target === '') {
        console.error('usage: pnpm kb show <§19 | phase 5 | FILE.md#heading | heading>');
        process.exit(1);
      }
      const found = resolveTarget(corpus(), target);
      if (found.length === 0) {
        console.error(`no section matches "${target}" — try: pnpm kb search ${target}`);
        process.exit(1);
      }
      if (found.length > 1 && !json) {
        console.log(`\n  "${target}" matches ${found.length} sections:\n`);
        for (const c of found) {
          console.log(`  ${c.file}:${c.line}  ${c.heading}${TAG[c.status]}`);
        }
        console.log('\n  narrow it with FILE.md#heading\n');
        break;
      }
      if (json) {
        console.log(
          JSON.stringify(found, (k, v) => (k === 'tf' || k === 'tokens' ? undefined : v), 2),
        );
        break;
      }
      const c = found[0];
      if (!c) break;
      console.log('');
      console.log(`── ${c.file}:${c.line}-${c.endLine} · ${c.status}${TAG[c.status]} ──`);
      console.log('');
      console.log(c.body);
      console.log('');
      break;
    }

    case 'term': {
      const name = args.join(' ');
      if (name === '') {
        console.error('usage: pnpm kb term <name>');
        process.exit(1);
      }
      const wanted = name.toLowerCase();
      const entries = glossary().filter(
        (e) => e.term.toLowerCase() === wanted || e.term.toLowerCase().includes(wanted),
      );
      console.log('');
      if (entries.length === 0) {
        console.log(`  "${name}" is not in ${GLOSSARY}.`);
        console.log('  Either it is not project vocabulary, or the glossary is missing it.');
      }
      for (const e of entries) {
        console.log(`  ${GLOSSARY}:${e.line}  ${e.term}`);
        console.log(`      ${e.definition.replace(/\s+/g, ' ').slice(0, 400)}`);
        console.log('');
      }
      const used = usages(entries[0]?.term ?? name);
      console.log(`  used in ${used.length} files:`);
      for (const u of used.slice(0, 12)) {
        console.log(`  ${String(u.count).padStart(4)}×  ${u.file}:${u.line}${TAG[u.status]}`);
      }
      console.log('');
      break;
    }

    case 'map':
      console.log(renderMap(corpus()));
      console.log('');
      break;

    case 'stale': {
      const notes = staleNotes(today);
      console.log('');
      if (notes.length === 0) console.log('  every research note is inside its review window');
      for (const n of notes) {
        console.log(
          `  DUE   ${n.file}  review-by ${n.reviewBy} · ${n.daysOver} days over · status: ${n.status}`,
        );
        console.log('        revalidate, archive, or delete — do not cite it as-is');
      }
      // The generated snapshot is optional — it only exists after `pnpm oracle md` has run.
      const status = join(ROOT, '.artifacts/oracle/PROJECT_STATUS.md');
      const graph = join(ROOT, 'scripts/oracle/graph.json');
      if (existsSync(status) && existsSync(graph)) {
        if (statSync(graph).mtimeMs > statSync(status).mtimeMs) {
          console.log(
            '  DRIFT .artifacts/oracle/PROJECT_STATUS.md is older than scripts/oracle/graph.json',
          );
          console.log('        regenerate it: pnpm oracle md');
        }
      }
      console.log('');
      if (notes.length > 0) process.exit(1);
      break;
    }

    case 'help':
      console.log(USAGE);
      break;

    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(1);
  }
}
