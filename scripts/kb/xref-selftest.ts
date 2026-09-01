/**
 * Scenarios for the cross-reference checker. Every scenario runs on inline fixture text and a
 * fixture graph, so the expected value comes from the fixture, not from what the repository
 * happens to say today. The two live-corpus scenarios at the end are claims about this repo.
 *
 *   pnpm check:kb      (or)     tsx scripts/kb/xref-selftest.ts
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  applyFixes,
  blockAt,
  blocksOf,
  checkC,
  checkPartition,
  ignoreReason,
  isHistorical,
  lineOfIndex,
  normalize,
  parseCitations,
  resolvePath,
} from './xref.ts';
import type { Graph, Node } from '../oracle.ts';

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

// ── fixtures ──────────────────────────────────────────────────────────────────────────

const DOC = `# 19. Safety Gates

All five must pass. A gate that
wraps across lines is one block.

- first item, with a wrap
  that continues here
- second item

| a | b |
| - | - |
| 1 | 2 |

\`\`\`text
code p5.spike-deleted at the 5a gate
\`\`\`

Last paragraph.
`;

function node(id: string, phase: number, title: string, note = ''): Node {
  return {
    id,
    phase,
    lane: 'engine',
    title,
    owner: 'builder',
    needs: [],
    probes: [],
    note,
  };
}
const G: Graph = {
  planRef: 'MVP_PLAN_V3.md',
  executionOrder: ['4', '5a', '5b'],
  segments: { '5a': ['p5.det-candidate'], '5b': ['p5.spike-deleted'] },
  segmentSections: { '5a': ['18', '19', '20'], '5b': ['21', '22'] },
  lanePolicy: {} as Graph['lanePolicy'],
  decisions: [],
  sections: { 'p5.det-candidate': ['18', '19', '21'], 'p5.spike-deleted': ['PHASE 0'] },
  nodes: [
    node('p4.attestation', 4, 'Cross-process attestOutcome (§14)'),
    node(
      'p5.det-candidate',
      5,
      'Deterministic candidate analyzer — §18 aggregation, §19 gates (§21 output is 5b)',
    ),
    node('p5.spike-deleted', 5, 'spike/ deleted — 5b wave 4, NOT 5a'),
  ],
};
const exists = (s: string): boolean => ['14', '18', '19', '20', '21', '22'].includes(s);

// ── blocks ────────────────────────────────────────────────────────────────────────────

scenario(
  1,
  'blocksOf: paragraph, list items, table rows, fence, heading are separate blocks',
  () => {
    const b = blocksOf(DOC);
    const got = b.map((x) => `${x.line}-${x.endLine}${x.fenced ? 'F' : ''}`).join(' ');
    const want = '1-1 3-4 6-7 8-8 10-10 11-11 12-12 14-16F 18-18';
    return got === want ? null : `expected ${want}, got ${got}`;
  },
);

scenario(2, 'blockAt finds the block covering a wrapped line', () => {
  const b = blockAt(blocksOf(DOC), 7);
  return b && b.line === 6 && /continues here/.test(b.text)
    ? null
    : `expected the first list item, got ${JSON.stringify(b)}`;
});

scenario(3, 'normalize strips formatting and collapses whitespace', () => {
  const got = normalize('owns deleting `spike/`   (**5b**),\n  *not* 5a <!-- x -->');
  const want = 'owns deleting spike/ (5b), not 5a';
  return got === want ? null : `expected "${want}", got "${got}"`;
});

// ── citations ─────────────────────────────────────────────────────────────────────────

scenario(4, 'parseCitations: bare, range, bound (both quote styles), @commit, basename', () => {
  const text = [
    'see `MVP_PLAN_V3.md:2262` and `x/merge-rules.ts:56-60` for the rule.',
    'bound: `CLAUDE.md:291` "owns deleting spike/" and note.md:12 \'twelve chars ok\'',
    'historical `CLAUDE.md:278@8ce66d5`; not bound: (`a.md:3`) "quoted prose later"',
  ].join('\n');
  const got = parseCitations(text).map(
    (c) => `${c.path}:${c.line}-${c.endLine}${c.commit ? '@' : ''}${c.fragment ? 'B' : ''}`,
  );
  const want = [
    'MVP_PLAN_V3.md:2262-2262',
    'x/merge-rules.ts:56-60',
    'CLAUDE.md:291-291B',
    'note.md:12-12B',
    'CLAUDE.md:278-278@',
    'a.md:3-3',
  ];
  return got.join(' ') === want.join(' ')
    ? null
    : `expected ${want.join(' ')}, got ${got.join(' ')}`;
});

scenario(5, 'parseCitations records where the number sits, for --fix', () => {
  const text = 'x `docs/a.md:10-12` y';
  const c = parseCitations(text)[0];
  if (!c) return 'no citation parsed';
  const slice = text.slice(c.numberIndex, c.numberIndex + c.numberLength);
  return slice === '10-12' ? null : `expected "10-12", got "${slice}"`;
});

scenario(6, 'resolvePath: repo-relative, unique basename, ambiguous, missing', () => {
  const tracked = ['CLAUDE.md', 'a/merge-rules.ts', 'b/validator.md', 'c/validator.md'];
  const r = (p: string): string => {
    const x = resolvePath(p, tracked);
    return x.kind === 'ok' ? x.file : x.kind;
  };
  const got = [r('CLAUDE.md'), r('merge-rules.ts'), r('validator.md'), r('nope.md')].join(' ');
  const want = 'CLAUDE.md a/merge-rules.ts ambiguous missing';
  return got === want ? null : `expected ${want}, got ${got}`;
});

scenario(7, 'lineOfIndex maps a text offset to its 1-based line number', () => {
  const text = 'first\nsecond\nthird';
  const idx = text.indexOf('third');
  const got = lineOfIndex(text, idx);
  return got === 3 ? null : `expected 3, got ${got}`;
});

// ── check C ───────────────────────────────────────────────────────────────────────────

const PLAN = `# PART III

- [ ] R4 and R5 both emit.
- [ ] \`spike/\` is deleted.

**Validation gate.** GREEN advances.
`;
const targets = (files: Record<string, string>) => (f: string) => files[f] ?? null;

scenario(8, 'FC: a bound citation whose fragment left the block is RED', () => {
  const src = 'owns deleting `spike/` (`MVP_PLAN_V3.md:3` "R1 and R2 both emit").';
  const f = checkC(
    {
      file: 'CLAUDE.md',
      text: src,
      tracked: ['MVP_PLAN_V3.md'],
      readTarget: targets({ 'MVP_PLAN_V3.md': PLAN }),
    },
    'RED',
  );
  return f.length === 1 && f[0]?.severity === 'RED' && /no longer in/.test(f[0].message)
    ? null
    : `expected one RED "no longer in", got ${JSON.stringify(f)}`;
});

scenario(9, 'FC-bare: the same citation without a fragment stays green', () => {
  const src = 'owns deleting `spike/` (`MVP_PLAN_V3.md:3`).';
  const f = checkC(
    {
      file: 'CLAUDE.md',
      text: src,
      tracked: ['MVP_PLAN_V3.md'],
      readTarget: targets({ 'MVP_PLAN_V3.md': PLAN }),
    },
    'RED',
  );
  return f.length === 0 ? null : `expected no finding, got ${JSON.stringify(f)}`;
});

scenario(
  10,
  'FC-fix: a fragment found in exactly one other block is repairable, and --fix rewrites',
  () => {
    const src = 'owns deleting `spike/` (`MVP_PLAN_V3.md:3` "spike/ is deleted").';
    const f = checkC(
      {
        file: 'CLAUDE.md',
        text: src,
        tracked: ['MVP_PLAN_V3.md'],
        readTarget: targets({ 'MVP_PLAN_V3.md': PLAN }),
      },
      'RED',
    );
    if (f.length !== 1 || !f[0]?.fix)
      return `expected one fixable finding, got ${JSON.stringify(f)}`;
    const { text, applied } = applyFixes(src, f);
    return applied === 1 && text.includes('`MVP_PLAN_V3.md:4` "spike/ is deleted"')
      ? null
      : `expected the line rewritten to 4, got ${text}`;
  },
);

scenario(
  11,
  'a block carrying a commit hash, or an @commit citation, is historical and skipped',
  () => {
    const src = [
      'At `8ce66d5` line 278 said `CLAUDE.md:999` "nothing about spike".',
      '',
      'And `CLAUDE.md:999@8ce66d5` too.',
    ].join('\n');
    const f = checkC(
      {
        file: 'spec.md',
        text: src,
        tracked: ['CLAUDE.md'],
        readTarget: targets({ 'CLAUDE.md': 'one line' }),
      },
      'RED',
    );
    const hist =
      isHistorical('defaced facade decade') === false && isHistorical('see 130c43a') === true;
    return f.length === 0 && hist
      ? null
      : `expected no findings and hex-word safety, got ${JSON.stringify(f)} ${hist}`;
  },
);

scenario(12, 'an xref-ignore needs a reason of at least 20 characters', () => {
  const ok = ignoreReason('x <!-- xref-ignore: restates the 08-18 contradiction on purpose -->');
  const short = ignoreReason('x <!-- xref-ignore: history -->');
  return ok !== null && short === null ? null : `expected reason/null, got ${ok}/${short}`;
});

// ── check C: five previously-uncovered branches ──────────────────────────────────────

scenario(
  13,
  'checkC on a .json source scopes history per line, not per file (linesAsBlocks)',
  () => {
    // No blank line separates these two lines, so blocksOf would merge them into one
    // block and the commit hash on line 1 would exempt the citation on line 2. A .json
    // source must use linesAsBlocks instead, keeping each line its own block.
    const src = [
      'historical: fixed at 8ce66d5',
      'cite: MVP_PLAN_V3.md:3 "R1 and R2 both emit"',
    ].join('\n');
    const f = checkC(
      {
        file: 'data/notes.json',
        text: src,
        tracked: ['MVP_PLAN_V3.md'],
        readTarget: targets({ 'MVP_PLAN_V3.md': PLAN }),
      },
      'RED',
    );
    return f.length === 1 && f[0]?.line === 2 && /no longer in/.test(f[0].message)
      ? null
      : `expected one RED "no longer in" at line 2, got ${JSON.stringify(f)}`;
  },
);

scenario(
  14,
  'checkC: citing an untracked file, and citing an ambiguous basename, are both RED',
  () => {
    const src = ['missing: `nope.md:5`', 'ambiguous: `validator.md:2`'].join('\n');
    const f = checkC(
      {
        file: 'CLAUDE.md',
        text: src,
        tracked: ['a/validator.md', 'b/validator.md'],
        readTarget: () => null,
      },
      'RED',
    );
    const missing = f.find((x) => /is not tracked/.test(x.message));
    const ambiguous = f.find((x) => /ambiguous/.test(x.message));
    return f.length === 2 && missing && ambiguous
      ? null
      : `expected one "is not tracked" and one "ambiguous", got ${JSON.stringify(f)}`;
  },
);

scenario(
  15,
  'checkC: a bare citation beyond the target file length is RED with the line count',
  () => {
    const src = 'see `MVP_PLAN_V3.md:99`.';
    const f = checkC(
      {
        file: 'CLAUDE.md',
        text: src,
        tracked: ['MVP_PLAN_V3.md'],
        readTarget: targets({ 'MVP_PLAN_V3.md': PLAN }),
      },
      'RED',
    );
    const total = PLAN.split(/\r?\n/).length;
    const want = `MVP_PLAN_V3.md:99: MVP_PLAN_V3.md has ${total} lines`;
    return f.length === 1 && f[0]?.message === want
      ? null
      : `expected "${want}", got ${JSON.stringify(f)}`;
  },
);

scenario(
  16,
  "checkC fix: a range citation whose fragment moved uses the target block's endLine",
  () => {
    // DOC's paragraph block spans lines 3-4 (see scenario 1): line !== endLine there, so
    // this only passes if the fix math actually reads b.endLine and not b.line.
    const src = 'see `MVP_PLAN_V3.md:10-11` "wraps across lines is one block."';
    const f = checkC(
      {
        file: 'CLAUDE.md',
        text: src,
        tracked: ['MVP_PLAN_V3.md'],
        readTarget: targets({ 'MVP_PLAN_V3.md': DOC }),
      },
      'RED',
    );
    const fix = f[0]?.fix;
    return f.length === 1 && fix && fix.line === 3 && fix.endLine === 4
      ? null
      : `expected one fix {line:3,endLine:4}, got ${JSON.stringify(f)}`;
  },
);

scenario(17, 'checkC: a fragment found in more than one block asks to bind a longer one', () => {
  const target = [
    'Intro paragraph.',
    '',
    'alpha shared phrase beta.',
    '',
    'gamma shared phrase delta.',
  ].join('\n');
  const src = 'moved: `notes.md:1` "shared phrase"';
  const f = checkC(
    {
      file: 'CLAUDE.md',
      text: src,
      tracked: ['notes.md'],
      readTarget: targets({ 'notes.md': target }),
    },
    'RED',
  );
  const want = 'notes.md:1: fragment is in 2 blocks of notes.md — bind a longer one';
  return f.length === 1 && f[0]?.message === want
    ? null
    : `expected "${want}", got ${JSON.stringify(f)}`;
});

// ── check C: the gitignore exemption (Task 4's added requirement) ───────────────────────

scenario(
  18,
  'checkC: a citation into a gitignored path is not RED even though the file is untracked',
  () => {
    const src = 'see `.artifacts/evidence/xref/run-log.md:5` for the run.';
    const notIgnored = checkC(
      { file: 'BACKLOG.md', text: src, tracked: ['CLAUDE.md'], readTarget: () => null },
      'RED',
    );
    const ignored = checkC(
      {
        file: 'BACKLOG.md',
        text: src,
        tracked: ['CLAUDE.md'],
        readTarget: () => null,
        isIgnored: (p) => p === '.artifacts/evidence/xref/run-log.md',
      },
      'RED',
    );
    return notIgnored.length === 1 &&
      /is not tracked/.test(notIgnored[0]?.message ?? '') &&
      ignored.length === 0
      ? null
      : `expected RED without the exemption and none with it, got ${JSON.stringify(notIgnored)} / ${JSON.stringify(ignored)}`;
  },
);

scenario(
  19,
  'checkC: a gitignored path whose basename collides with tracked files stays exempt, not ambiguous',
  () => {
    const src = 'see `.artifacts/evidence/2/tester-human-repair/README.md:188` for detail.';
    const tracked = ['a/README.md', 'b/README.md'];
    const notIgnored = checkC(
      { file: 'BACKLOG.md', text: src, tracked, readTarget: () => null },
      'RED',
    );
    const ignored = checkC(
      {
        file: 'BACKLOG.md',
        text: src,
        tracked,
        readTarget: () => null,
        isIgnored: (p) => p === '.artifacts/evidence/2/tester-human-repair/README.md',
      },
      'RED',
    );
    return notIgnored.length === 1 &&
      /ambiguous/.test(notIgnored[0]?.message ?? '') &&
      ignored.length === 0
      ? null
      : `expected ambiguous without the exemption and none with it, got ${JSON.stringify(notIgnored)} / ${JSON.stringify(ignored)}`;
  },
);

// ── citation grammar: the closing quote must match the opening class ────────────────────

scenario(
  20,
  'parseCitations: a possessive apostrophe does not open a fragment a later " closes',
  () => {
    const text = [
      'graph note: spike/aggregate.ts:100\'s blended rate lands on opposite sides."',
      'mirror image: `notes.md:7` "an opening double quote closed by an apostrophe\'',
    ].join('\n');
    const got = parseCitations(text).map((c) => `${c.path}:${c.line}=${c.fragment ?? '<bare>'}`);
    const want = ['spike/aggregate.ts:100=<bare>', 'notes.md:7=<bare>'];
    return got.join(' ') === want.join(' ')
      ? null
      : `expected ${want.join(' ')}, got ${got.join(' ')}`;
  },
);

scenario(21, 'parseCitations: matched quote pairs still bind — straight and curly', () => {
  const text = [
    'a `a.md:1` "straight double fragment"',
    "b `b.md:2` 'straight single fragment'",
    'c `c.md:3` “curly double fragment”',
    'd `d.md:4` ‘curly single fragment’',
  ].join('\n');
  const got = parseCitations(text).map((c) => c.fragment ?? '<bare>');
  const want = [
    'straight double fragment',
    'straight single fragment',
    'curly double fragment',
    'curly single fragment',
  ];
  return got.join(' | ') === want.join(' | ')
    ? null
    : `expected ${want.join(' | ')}, got ${got.join(' | ')}`;
});

scenario(22, 'partition: the fixture table is complete', () => {
  const f = checkPartition(G, exists);
  return f.length === 0 ? null : `expected none, got ${f.map((x) => x.message).join(' | ')}`;
});

scenario(23, 'partition: missing segment, unknown §, and an unmapped cited § are each RED', () => {
  const has = (msgs: string[], want: string[]): string | null => {
    const missing = want.filter((w) => !msgs.some((m) => m.includes(w)));
    return missing.length === 0 && msgs.length === want.length
      ? null
      : `expected exactly [${want.join(' | ')}], got [${msgs.join(' | ')}]`;
  };
  // (i) 5b has no row; §99 is not in the plan. §21 is mapped (to 5a), so nothing about it fires.
  const a = has(
    checkPartition({ ...G, segmentSections: { '5a': ['18', '19', '21', '99'] } }, exists).map(
      (x) => x.message,
    ),
    ['no entry for segment "5b"', '§99 is mapped to 5a but is not a section'],
  );
  // (ii) both rows present, but §21 — cited by p5.det-candidate's title and slice — is unmapped.
  //      §20 is unmapped too and cited by nobody, so it must stay silent.
  const b = has(
    checkPartition({ ...G, segmentSections: { '5a': ['18', '19'], '5b': ['22'] } }, exists).map(
      (x) => x.message,
    ),
    ['p5.det-candidate (5a) cites §21, which segmentSections does not map'],
  );
  return a ?? b;
});

// ── report ────────────────────────────────────────────────────────────────────────────

function report(): number {
  const failed = results.filter((r) => !r.pass);
  console.log('\ncross-reference scenarios\n');
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
