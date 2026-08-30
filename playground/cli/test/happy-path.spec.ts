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
  void it('defaults to 42 when --seed= is absent', () => {
    // Expected sourced from the CLI's own documented contract (`DEFAULT_SEED = 42`,
    // happy-path.ts) — not from calling parseSeed twice, which pins nothing (tester F5: the
    // old self-referential assertion passed on implementations returning 7 and 0).
    assert.equal(parseSeed([]), 42);
  });

  void it('parses a valid --seed=<n>, including negative', () => {
    assert.equal(parseSeed(['--seed=7']), 7);
    assert.equal(parseSeed(['--seed=-5']), -5);
  });

  void it('rejects a non-integer seed', () => {
    assert.throws(() => parseSeed(['--seed=abc']), /--seed must be an integer/);
    assert.throws(() => parseSeed(['--seed=1.5']), /--seed must be an integer/);
  });

  void it('rejects the textual seeds Number() would silently alias (tester F4)', () => {
    // `Number('')` is 0, `Number('0x10')` is 16, `Number('1e3')` is 1000, `Number(' 7 ')`
    // is 7 — each one a run under a seed the caller never chose. `--seed=` with an unset
    // shell variable (`--seed=$SEED`) is the fully silent case.
    for (const raw of ['', '0x10', '1e3', ' 7 ', 'Infinity']) {
      assert.throws(
        () => parseSeed([`--seed=${raw}`]),
        /--seed must be an integer/,
        `"--seed=${raw}" must be rejected`,
      );
    }
  });

  void it('rejects unrecognised arguments instead of ignoring them (tester F4: `--seed 4321` ran seed 42)', () => {
    assert.throws(() => parseSeed(['--seed', '4321']), /unrecognised argument "--seed"/);
    assert.throws(() => parseSeed(['--other=1', '--seed=99']), /unrecognised argument "--other=1"/);
  });
});

const CLI_ENTRY = join(process.cwd(), 'cli', 'happy-path.ts');

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Every spawn points `PLAYGROUND_ENDPOINT` at 127.0.0.1:9 (the discard port — nothing
 * listens there; connections are refused immediately). Two reasons, both tester F2:
 * the old spec ran against the hard-coded live endpoint, so it could never fail for its
 * stated cause while the API was up, AND it wrote real Runs into the live dev database
 * every time the suite ran with `pnpm dev` active. The premise is not assumed: the
 * unreachable-API test asserts `delivered=0` / `droppedUndeliverable>0`, which is only
 * observable when nothing answered.
 */
const UNREACHABLE_ENDPOINT = 'http://127.0.0.1:9';

function runCli(args: readonly string[], killAfterMs: number): Promise<RunResult> {
  return new Promise<RunResult>((settle, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PLAYGROUND_ENDPOINT: UNREACHABLE_ENDPOINT },
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
    // The endpoint in the banner proves which API this run actually addressed.
    assert.match(
      result.stdout,
      new RegExp(`playground:happy-path — seed=1 endpoint=${UNREACHABLE_ENDPOINT}`),
    );
    assert.match(result.stdout, /^run [^\s]+ — COMPLETED$/m);
    assert.match(result.stdout, /strategy: sequential/);
    // delivered=0 with a non-zero droppedUndeliverable is the premise made observable:
    // nothing answered, the retry budget was spent, and the process still settled and
    // printed. The old `delivered=\d+` matched the delivered and undelivered paths alike
    // (tester F2 called it "a description of the sky"). Without the `maxRetries: 0`
    // workaround this process exits 0 with ZERO stdout — every assertion here fails.
    assert.match(
      result.stdout,
      /telemetry: recorded=\d+ delivered=0 droppedUndeliverable=[1-9]\d*/,
    );
    assert.match(
      result.stdout,
      new RegExp(`note: \\d+ event\\(s\\) could not be delivered to ${UNREACHABLE_ENDPOINT}`),
    );
    // The batch was never delivered at all (connection refused, every retry exhausted), so
    // none of the four server counters — which are only populated on the `delivered` branch
    // (`platform/telemetry-sdk/src/client.ts`) — were ever touched. All four stay at their
    // initial value of 0; this is NOT the "server said 0 accepted, N duplicate" shape the
    // CLI's own "no new data was recorded" note below is for (F1/B).
    assert.match(result.stdout, /^persistence: accepted=0 duplicate=0 rejected=0 unattributed=0$/m);
    assert.equal(result.stdout.includes('no new data was recorded'), false);
  });

  void it('same seed twice produces byte-identical stdout', async () => {
    const [first, second] = await Promise.all([
      runCli(['--seed=42'], 8_000),
      runCli(['--seed=42'], 8_000),
    ]);

    assert.equal(first.code, 0);
    assert.equal(second.code, 0);

    // The persistence line reports server state (`platform/telemetry-sdk` `stats().server*`
    // counters), not the seed — the determinism claim (F1/B:
    // `.artifacts/evidence/3/phase-gate/repair-1/architect-f1-decision.md`) is about the
    // telemetry the CLI *sends*, not about a server-side counter two concurrent processes
    // could legitimately disagree on (one accepted, one duplicate) even under an unreachable
    // endpoint, if a future change made delivery partially succeed. Filtering the
    // persistence line out is therefore the correct comparison, not a weaker one — every
    // other line, including the deterministic `run ... — COMPLETED` line and the `telemetry:`
    // line, still must match byte-for-byte.
    const PERSISTENCE_LINE =
      /^persistence: accepted=\d+ duplicate=\d+ rejected=\d+ unattributed=\d+$/m;
    assert.match(first.stdout, PERSISTENCE_LINE);
    assert.match(second.stdout, PERSISTENCE_LINE);
    assert.equal(
      first.stdout.replace(PERSISTENCE_LINE, ''),
      second.stdout.replace(PERSISTENCE_LINE, ''),
    );
  });

  void it('an invalid --seed exits non-zero with a clear message, without hanging', async () => {
    const result = await runCli(['--seed=not-a-number'], 8_000);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--seed must be an integer/);
  });
});
