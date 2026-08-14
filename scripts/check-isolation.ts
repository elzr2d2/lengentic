/**
 * Isolation check (MVP_PLAN.md §17, scoped per corrections doc §9).
 *
 * Two arms, deliberately asymmetric:
 *
 *   Arm 1  Platform without Playground   FULL install + build + test in a temp checkout
 *   Arm 2  Platform without .claude/     STATIC check
 *
 * Arm 1 is the claim with real content, so it keeps its full cycle: the Platform must
 * genuinely build and pass its tests with `playground/` deleted.
 *
 * Arm 2 is nearly free and already proved by dependency-cruiser's
 * `platform-not-to-claude` and `playground-not-to-claude` rules. Spending minutes on a
 * full rebuild to re-prove it would add wall clock and no information. The plan's third
 * arm ("delete both") is dropped for the same reason — it proves nothing Arm 1 and the
 * boundary rules do not already prove jointly.
 *
 * Slow by design. This belongs to the commit-ready tier (§31) and `pnpm gates:full`, not
 * to `pnpm gates`.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const SKIP_COPY = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

function main(): void {
  const failures: string[] = [];

  console.log('check:isolation — Arm 2 (static): platform and playground must not reach .claude/');
  const arm2 = checkClaudeIsolation();
  if (arm2.length > 0) {
    failures.push(...arm2);
    arm2.forEach((f) => console.error(`  FAIL  ${f}`));
  } else {
    console.log('  PASS  no source or manifest reference to .claude/');
  }

  console.log('\ncheck:isolation — Arm 1 (full): platform must build and test without playground/');
  const arm1 = checkPlaygroundIsolation();
  if (arm1 !== null) {
    failures.push(arm1);
    console.error(`  FAIL  ${arm1}`);
  } else {
    console.log('  PASS  install, build and test succeeded with playground/ removed');
  }

  if (failures.length > 0) {
    console.error(`\ncheck:isolation FAILED (${failures.length})`);
    process.exitCode = 1;
    return;
  }
  console.log('\ncheck:isolation PASSED');
}

/**
 * Arm 2. A grep, not a build.
 *
 * dependency-cruiser catches import statements. This catches the things it cannot see:
 * a package manifest pointing into `.claude/`, or a runtime path built as a string.
 */
function checkClaudeIsolation(): string[] {
  const found: string[] = [];
  const listed = git(['ls-files', 'platform', 'playground']);
  const files = listed.split('\n').filter(Boolean);

  for (const file of files) {
    const full = join(REPO, file);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    if (/(^|[^\w.])\.claude\//.test(text)) {
      found.push(`${file} references .claude/`);
    }
  }
  return found;
}

/** Arm 1. Copy, delete, rebuild. */
function checkPlaygroundIsolation(): string | null {
  const scratch = mkdtempSync(join(tmpdir(), 'lengentic-isolation-'));
  const checkout = join(scratch, 'repo');

  try {
    cpSync(REPO, checkout, {
      recursive: true,
      filter: (src) => !src.split(/[\\/]/).some((segment) => SKIP_COPY.has(segment)),
    });

    rmSync(join(checkout, 'playground'), { recursive: true, force: true });
    stripPlaygroundScripts(checkout);

    for (const args of [['install', '--no-frozen-lockfile'], ['build'], ['test']]) {
      const result = run('pnpm', args, checkout);
      if (result.status !== 0) {
        return `pnpm ${args.join(' ')} failed with exit ${result.status}\n${indent(result.output)}`;
      }
    }
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Remove root scripts that reference the deleted workspace.
 *
 * Without this the check fails on script bookkeeping rather than on imports, which is the
 * opposite of what it is meant to prove — a red result that says nothing about coupling.
 */
function stripPlaygroundScripts(checkout: string): void {
  const manifestPath = join(checkout, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };

  for (const [name, body] of Object.entries(manifest.scripts ?? {})) {
    if (name.startsWith('playground') || body.includes('playground')) {
      delete manifest.scripts?.[name];
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function run(command: string, args: readonly string[], cwd: string) {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 15 * 60 * 1000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function git(args: readonly string[]): string {
  return run('git', args, REPO).output;
}

function indent(text: string): string {
  return text
    .split('\n')
    .slice(-25)
    .map((line) => `    ${line}`)
    .join('\n');
}

main();
