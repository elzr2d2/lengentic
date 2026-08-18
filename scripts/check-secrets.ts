/**
 * Secret detection before commit — OD-6 (`MVP_PLAN_V3.md:2751-2756`) and
 * `MVP_PLAN_V3.md:1534`: "No secret detection exists, though it is required before
 * commit-ready."
 *
 * Self-contained, no new dependency: `allowed_paths` for this packet is `.husky/**`
 * and `scripts/**` only, so an npm package (gitleaks/trufflehog need an external
 * binary anyway) is not an option. Every other check in this repo is a bare
 * `tsx scripts/<name>.ts` — this follows the same convention.
 *
 * Two modes:
 *
 *   (default)  scan staged additions only (`git diff --cached`). This is what
 *              `.husky/pre-commit` runs — fast, and it only ever sees what this
 *              commit is about to introduce, so pre-existing content elsewhere in
 *              the tree can never trip it.
 *   --sweep    scan the full content of every git-tracked file. Not run by the
 *              hook; this is the broad audit used to prove the pattern set has no
 *              false positive against the repository as it stands today.
 *
 * Self-detection: this file's own pattern literals are credential-shaped by
 * construction (an `AKIA` prefix, a `-----BEGIN` marker, ...). Both modes skip
 * `SELF_PATH` by an explicit path allowlist rather than trying to make the
 * patterns not match themselves — the honest fix is "don't scan the scanner",
 * not "weaken the pattern so it can't see its own definition".
 *
 * Usage:
 *   pnpm tsx scripts/check-secrets.ts            staged-diff mode (pre-commit)
 *   pnpm tsx scripts/check-secrets.ts --sweep     full-tree mode (audit / evidence)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const SELF_PATH = relative(REPO, import.meta.filename)
  .split('\\')
  .join('/');

interface Pattern {
  id: string;
  what: string;
  re: RegExp;
}

// Credential-shaped, not "looks like a password". Each pattern targets a real
// vendor token format so the false-positive rate against ordinary source stays low.
const PATTERNS: Pattern[] = [
  { id: 'aws-access-key-id', what: 'AWS access key ID', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'github-token', what: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36}/ },
  { id: 'slack-token', what: 'Slack token', re: /xox[baprs]-[0-9A-Za-z-]{10,48}/ },
  { id: 'google-api-key', what: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  {
    id: 'llm-vendor-key',
    what: 'OpenAI/Anthropic-style secret key',
    re: /sk-(ant-|proj-)?[A-Za-z0-9]{20,}/,
  },
  {
    id: 'private-key-block',
    what: 'PEM private key block',
    re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/,
  },
  {
    id: 'jwt',
    what: 'JWT-looking token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

interface Finding {
  file: string;
  line: number;
  patternId: string;
  what: string;
  text: string;
}

function scanLine(file: string, line: number, content: string, findings: Finding[]): void {
  if (file === SELF_PATH) return;
  for (const pattern of PATTERNS) {
    if (pattern.re.test(content)) {
      findings.push({
        file,
        line,
        patternId: pattern.id,
        what: pattern.what,
        text: content.trim().slice(0, 200),
      });
    }
  }
}

/** Staged additions only — parses `git diff --cached --unified=0` by hand. */
function scanStagedDiff(): Finding[] {
  const diff = execFileSync(
    'git',
    ['diff', '--cached', '--unified=0', '--no-color', '--diff-filter=ACMR'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 },
  );

  const findings: Finding[] = [];
  let currentFile = '';
  let newLine = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      currentFile = path === '/dev/null' ? '' : path.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('@@')) {
      const match = /\+(\d+)/.exec(line);
      newLine = match?.[1] ? Number.parseInt(match[1], 10) : 0;
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      if (currentFile) scanLine(currentFile, newLine, line.slice(1), findings);
      newLine++;
      continue;
    }
    // '-' lines (removed) and diff/index headers don't touch the new-file line count.
  }

  return findings;
}

/** Full content of every tracked file — the broad audit, not what the hook runs. */
function scanTree(): Finding[] {
  const files = execFileSync('git', ['ls-files'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  })
    .split('\n')
    .filter(Boolean);

  const findings: Finding[] = [];
  for (const file of files) {
    if (file === SELF_PATH) continue;
    let content: string;
    try {
      content = readFileSync(resolve(REPO, file), 'utf8');
    } catch {
      continue; // binary or unreadable — not a text secret carrier we can scan
    }
    // NUL byte is the cheap binary-file tell; skip rather than scan garbage.
    if (content.includes('\u0000')) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      scanLine(file, i + 1, lines[i] ?? '', findings);
    }
  }
  return findings;
}

function report(findings: Finding[], mode: string): void {
  if (findings.length === 0) {
    console.log(`[check-secrets] ${mode}: clean, 0 findings`);
    return;
  }
  console.error(`[check-secrets] ${mode}: ${findings.length} credential-shaped finding(s)`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.patternId}] ${f.what}`);
    console.error(`    ${f.text}`);
  }
  console.error(
    '[check-secrets] commit blocked — remove the credential-shaped string before committing.',
  );
}

function main(): void {
  const sweep = process.argv.includes('--sweep');
  const findings = sweep ? scanTree() : scanStagedDiff();
  report(findings, sweep ? '--sweep (full tree)' : 'staged diff');
  process.exit(findings.length === 0 ? 0 : 1);
}

main();
