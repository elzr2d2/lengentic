import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Seam: the process boundary. This is the only place the Phase 2 DoD checkbox — "running
 * the script with the API down does not crash the script" — can actually be checked, and
 * the only place "no dangling timer keeps the event loop alive" is more than an assertion
 * about a test double. Real SDK, real HTTP transport, real timers, real exit code.
 *
 * Expected values: exit code 0 (POSIX success), an empty stderr (§16 "Silent"), and a
 * wall-clock bound the test sets. None of them can be produced by the code under test.
 */
// `import.meta` is unavailable under this package's CommonJS tsconfig, and `__dirname` is
// unavailable under Vitest's ESM transform. The runner sets the package directory as the
// cwd (`pnpm test`, `pnpm -r test` and a bare `vitest run` all do), and the assertion below
// turns a wrong cwd into a named failure instead of a mysterious spawn error.
const here = join(process.cwd(), 'test');
const FIXTURES_DIR = join(here, 'fixtures');

/** A port that was bound and released, so a connection to it is refused rather than hung. */
async function closedPort(): Promise<number> {
  return new Promise<number>((settle, fail) => {
    const server = createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        fail(new Error('could not determine an ephemeral port'));
        return;
      }
      const { port } = address;
      server.close(() => {
        settle(port);
      });
    });
  });
}

if (!existsSync(join(FIXTURES_DIR, 'api-down.ts'))) {
  throw new Error(`fixtures not found at ${FIXTURES_DIR} — run this suite from the package root`);
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
}

function runFixture(fixture: string, port: number, killAfterMs: number): Promise<RunResult> {
  const startedAt = Date.now();
  return new Promise<RunResult>((settle, fail) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(FIXTURES_DIR, fixture), String(port)],
      { cwd: here, stdio: ['ignore', 'pipe', 'pipe'] },
    );

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
      settle({ code, stdout, stderr, elapsedMs: Date.now() - startedAt });
    });
  });
}

describe('a host process using the SDK for real', () => {
  it('runs to completion and exits 0 with the API down, saying nothing on stderr', async () => {
    const result = await runFixture('api-down.ts', await closedPort(), 30_000);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('SCRIPT-COMPLETED');
    // Four events recorded, none delivered, all four eventually given up on: the SDK
    // absorbed a dead API completely and the script still finished its own work.
    expect(result.stdout).toContain('recorded=4 delivered=0 undeliverable=4');
  }, 40_000);

  it('exits immediately when the host forgets to shut down, despite a 60s flush interval', async () => {
    const result = await runFixture('no-shutdown.ts', await closedPort(), 20_000);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('SCRIPT-COMPLETED-WITHOUT-SHUTDOWN');
    // Well under the 60s interval the fixture armed. Without unref() on the SDK's timers
    // this process would sit here until the guard killed it.
    expect(result.elapsedMs).toBeLessThan(15_000);
  }, 40_000);
});
