/**
 * Pre-commit gate, scoped to what the commit actually stages (harness-throughput item 5).
 *
 * The old hook ran `pnpm gates:full` — minutes of full-tree work per commit, most of it
 * re-proving files the commit never touched. gates:full now belongs to the phase gate and
 * CI (`run-quality-gates` tier table); this script is Tier 2, the packet-commit gate.
 *
 * Ladder, in order, each step scoped to staged files:
 *
 *   1. secret scan            always — scripts/check-secrets.ts, staged-diff mode
 *   2. format                 always — prettier --write + re-stage; partially-staged
 *                             files get --check only (a --write would stage hunks the
 *                             author deliberately left out)
 *   3. docs-only short-circuit: if every staged file is .md and none touches the
 *      harness, secrets + format is the whole gate
 *   4. eslint                 staged js/ts only
 *   5. affected packages      map staged paths to platform/<pkg> | playground/<pkg>,
 *                             run whichever of `typecheck` / `test` the package declares
 *   6. root tsc --noEmit      only when a staged .ts lives under scripts/
 *   7. harness selftests      check:lanes + check:flow + check:kb, only when .claude/**,
 *                             scripts/{lanes,flow,oracle,kb}* or the oracle graph is staged
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');

interface StepResult {
  name: string;
  status: number;
}

const failures: StepResult[] = [];

function run(command: string, args: readonly string[], opts: { cwd?: string } = {}): number {
  const cwd = opts.cwd ?? REPO;
  // Same Windows note as check-isolation.ts: pnpm is a .cmd shim and needs a shell; one
  // joined string avoids DEP0190. Arguments here are literals or repo-relative paths.
  const quoted = [command, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
  const result =
    process.platform === 'win32'
      ? spawnSync(quoted, { cwd, stdio: 'inherit', shell: true })
      : spawnSync(command, [...args], { cwd, stdio: 'inherit' });
  if (result.error) {
    console.error(`[precommit] spawn failed: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function step(name: string, fn: () => number): void {
  console.log(`\n[precommit] ${name}`);
  const status = fn();
  if (status !== 0) failures.push({ name, status });
}

function gitLines(args: readonly string[]): string[] {
  const result = spawnSync('git', [...args], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

function main(): void {
  const staged = gitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  if (staged.length === 0) {
    console.log('[precommit] nothing staged — nothing to check');
    return;
  }

  // Partially staged = also dirty in the worktree. --write would stage the unstaged half.
  const unstaged = new Set(gitLines(['diff', '--name-only']));
  const fullyStaged = staged.filter((f) => !unstaged.has(f));
  const partiallyStaged = staged.filter((f) => unstaged.has(f));

  const harnessTouched = staged.some(
    (f) =>
      f.startsWith('.claude/') ||
      f.startsWith('scripts/lanes') ||
      f.startsWith('scripts/flow') ||
      f.startsWith('scripts/oracle') ||
      f.startsWith('scripts/kb'),
  );
  const docsOnly = !harnessTouched && staged.every((f) => f.endsWith('.md'));

  // 1. Secrets — always, before anything slower.
  step('secret scan (staged diff)', () => run('pnpm', ['tsx', 'scripts/check-secrets.ts']));
  if (failures.length > 0) {
    report(); // a staged credential ends the conversation
    return;
  }

  // 2. Format. Fully staged files are written and re-staged; partially staged files are
  // only checked, and a failure there is the author's to format by hand.
  if (fullyStaged.length > 0) {
    step('prettier --write (fully staged) + re-stage', () => {
      const status = run('pnpm', [
        'exec',
        'prettier',
        '--write',
        '--ignore-unknown',
        ...fullyStaged,
      ]);
      if (status !== 0) return status;
      return run('git', ['add', '--', ...fullyStaged]);
    });
  }
  if (partiallyStaged.length > 0) {
    step('prettier --check (partially staged — not rewritten)', () =>
      run('pnpm', ['exec', 'prettier', '--check', '--ignore-unknown', ...partiallyStaged]),
    );
  }

  if (docsOnly) {
    console.log('\n[precommit] docs-only commit — secrets + format is the whole gate');
    report();
    return;
  }

  // 4. Lint, staged js/ts only.
  const lintable = staged.filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f));
  if (lintable.length > 0) {
    step('eslint (staged js/ts)', () =>
      run('pnpm', ['exec', 'eslint', '--no-warn-ignored', ...lintable]),
    );
  }

  // 5. Affected packages: typecheck + test where the package declares them.
  for (const pkgDir of affectedPackages(staged)) {
    const manifest = JSON.parse(readFileSync(join(REPO, pkgDir, 'package.json'), 'utf8')) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    for (const script of ['typecheck', 'test'] as const) {
      if (manifest.scripts?.[script]) {
        step(`${manifest.name ?? pkgDir} ${script}`, () =>
          run('pnpm', ['run', script], { cwd: join(REPO, pkgDir) }),
        );
      }
    }
  }

  // 6. Root tsc when harness scripts changed — they compile under the root tsconfig.
  if (staged.some((f) => f.startsWith('scripts/') && f.endsWith('.ts'))) {
    step('root tsc --noEmit (scripts changed)', () => run('pnpm', ['exec', 'tsc', '--noEmit']));
  }

  // 7. Harness selftests only when the harness itself is staged.
  if (harnessTouched) {
    step('check:lanes', () => run('pnpm', ['check:lanes']));
    step('check:flow', () => run('pnpm', ['check:flow']));
    step('check:kb', () => run('pnpm', ['check:kb']));
  }

  report();
}

/** Map staged paths to workspace package dirs that actually have a package.json. */
function affectedPackages(staged: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const file of staged) {
    const match = /^(platform|playground)\/([^/]+)\//.exec(file);
    if (match) {
      const dir = `${match[1]}/${match[2]}`;
      if (existsSync(join(REPO, dir, 'package.json'))) dirs.add(dir);
    }
  }
  return [...dirs].sort();
}

function report(): void {
  if (failures.length === 0) {
    console.log('\n[precommit] PASS — all staged-scope checks green');
    return;
  }
  console.error(`\n[precommit] FAIL (${failures.length}):`);
  for (const f of failures) console.error(`  ${f.name} (exit ${f.status})`);
  process.exitCode = 1;
}

main();
