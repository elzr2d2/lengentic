/**
 * Seam: the process boundary — the only place R1 (`MockProvider.invoke()` can exit 0
 * without settling) can actually be reproduced. Every other test in this package injects
 * `FakeScheduler` (never a real timer) or runs under `node:test`'s own runner (which holds
 * the event loop open regardless of what the code under test does), so neither shape can
 * ever see a process exit before its own timer fires. Only a real, separately spawned
 * `node` process — no test runner wrapped around it — can. Pattern:
 * `platform/telemetry-sdk/test/process-exit.spec.ts`.
 *
 * The unfixed bug (`keepProcessAlive: false` on the timer that settles the caller's own
 * `await`) is a *race*, not a deterministic failure — the validator measured 7 hangs in 10
 * runs, 3 clean. A single spawn could pass by luck against the unfixed code. Ten
 * independent trials, all required to succeed, is what turns that race into an assertion:
 * against the unfixed code, the chance all ten happen to land in the surviving ~30% is
 * `0.3^10 ≈ 0.0000059` — for all practical purposes this test cannot pass by luck against
 * the bug it exists to catch.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const FIXTURE = join(process.cwd(), 'providers', 'test', 'fixtures', 'invoke-default-scheduler.ts');

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runFixture(killAfterMs: number): Promise<RunResult> {
  return new Promise<RunResult>((settle, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
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

const TRIALS = 10;

void describe('MockProvider under the real default scheduler, in a real process', () => {
  void it(`settles both awaited invoke() calls before the process exits, across ${TRIALS} independent trials`, async () => {
    const results = await Promise.all(Array.from({ length: TRIALS }, () => runFixture(10_000)));

    const failures = results
      .map((result, index) => ({ index, result }))
      .filter(({ result }) => !result.stdout.includes('SCRIPT-COMPLETED'));

    assert.equal(
      failures.length,
      0,
      `${failures.length}/${TRIALS} trial(s) exited before settling both invoke() calls ` +
        `(unref'd timer raced the process exit) — ` +
        failures
          .map(
            ({ index, result }) =>
              `trial ${index}: code=${result.code} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
          )
          .join(' | '),
    );

    for (const result of results) {
      assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stderr}`);
    }
  });
});
