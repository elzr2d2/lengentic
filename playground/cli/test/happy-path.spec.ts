/**
 * Seams under test:
 *
 *   1. `parseSeed` — the CLI's one argument: default when `--seed=` is absent, parses a
 *      valid integer, rejects a non-integer.
 *   2. The process boundary — `pnpm playground:happy-path` must actually exit, not hang or
 *      silently abandon its own `await`, when the LenGentic API is not running (the normal
 *      case for this repo's validation commands, none of which start it). This is a direct
 *      regression test for the defect the module doc's "`maxRetries: 0`" section
 *      reproduces and works around: before that fix, the unparameterised script exited 0
 *      with zero stdout and `agent.run()` never resolved — indistinguishable from success
 *      by exit code alone. Spawned as a real, separate `node` process (not `node:test`,
 *      which holds the event loop open on its own regardless of what the code under test
 *      does) — same pattern as `playground/providers/test/process-exit.spec.ts`. Unlike
 *      that test's race, this fix removes the unref'd timer entirely (`maxRetries: 0`
 *      means no backoff is ever scheduled), so the outcome is deterministic and one trial
 *      is sufficient.
 *
 * Runner: Node's built-in `node:test`/`node:assert/strict`, matching every other
 * `playground/**` package (`playground/package.json`'s `test` script globs `**\/*.spec.ts`).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseSeed } from '../happy-path';

void describe('parseSeed', () => {
  void it('defaults when --seed= is absent', () => {
    assert.equal(parseSeed([]), parseSeed([]));
    assert.equal(typeof parseSeed([]), 'number');
  });

  void it('parses a valid --seed=<n>', () => {
    assert.equal(parseSeed(['--seed=7']), 7);
    assert.equal(parseSeed(['--other=1', '--seed=99']), 99);
  });

  void it('rejects a non-integer seed', () => {
    assert.throws(() => parseSeed(['--seed=abc']), /--seed must be an integer/);
    assert.throws(() => parseSeed(['--seed=1.5']), /--seed must be an integer/);
  });
});

const CLI_ENTRY = join(process.cwd(), 'cli', 'happy-path.ts');

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[], killAfterMs: number): Promise<RunResult> {
  return new Promise<RunResult>((settle, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

    const guard = setTimeout(() => {
      child.kill('SIGKILL');
    }, killAfterMs);

    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(guard);
      settle({ code, stdout, stderr });
    });
  });
}

void describe('playground:happy-path — process boundary', () => {
  void it('exits 0 and prints a full summary against an unreachable API, well inside the timeout bound', async () => {
    const result = await runCli(['--seed=1'], 8_000);

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /playground:happy-path — seed=1 endpoint=/);
    assert.match(result.stdout, /^run [^\s]+ — COMPLETED$/m);
    assert.match(result.stdout, /strategy: sequential/);
    assert.match(result.stdout, /telemetry: recorded=\d+ delivered=\d+/);
  });

  void it('same seed twice produces byte-identical stdout', async () => {
    const [first, second] = await Promise.all([
      runCli(['--seed=42'], 8_000),
      runCli(['--seed=42'], 8_000),
    ]);

    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    assert.equal(first.stdout, second.stdout);
  });

  void it('an invalid --seed exits non-zero with a clear message, without hanging', async () => {
    const result = await runCli(['--seed=not-a-number'], 8_000);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--seed must be an integer/);
  });
});
