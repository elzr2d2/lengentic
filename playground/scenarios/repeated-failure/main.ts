/**
 * `pnpm playground:repeated-failure` — Scenario 2's entry point (`MVP_PLAN_V3.md` Phase 6,
 * work package 1).
 *
 * ```text
 * Generate → Test → FAIL
 * Modify   → Test → FAIL
 * Modify   → Test → FAIL
 *
 * Expected: REPEATED_FAILED_ACTION
 * ```
 *
 * `./scenario.ts` owns the emission; this file owns argv, the endpoint, and the summary a
 * human reads. Split the same way `../deterministic-decision/main.ts` splits them, so the
 * scenario stays testable at its own seam without a process.
 *
 * It prints **what was emitted**, never a verdict. The runId, the toolName and the one
 * `inputFingerprint` shared by all three attempts are §20.2's grouping key, so printing them
 * is what lets a reader check the analyzer's conditions against this run's data rather than
 * take this command's word for it. `./scenario.ts`'s "What this file does NOT do" is why
 * there is no `REPEATED_FAILED_ACTION` decision made anywhere in this directory.
 *
 * The scenario's run completes `FAILED` by design — the simulated agent never fixes the
 * test. That is the *run's* status, not this command's: `main` returns 0 when the workload
 * emitted as specified, and non-zero only when emitting it threw. A command that exited 1
 * because its scripted failure happened would be unusable as the §25 demo's second beat.
 *
 * `maxRetries: 0` for the same reproduced SDK defect `playground/cli/happy-path.ts`
 * documents at length: with the SDK's default `maxRetries` and no API listening, a retry's
 * backoff timer is scheduled unref'd, Node exits 0 with the `await` abandoned, and the
 * command produces no output at all. Filed to `BACKLOG.md` during `p3.cli`; sidestepped, not
 * fixed, from here.
 */
import {
  ATTEMPTS,
  runRepeatedFailureScenario,
  TOOL_NAME,
  type RepeatedFailureScenarioResult,
} from './scenario';
import { PLAYGROUND_DEFAULT_ENDPOINT } from '../../index';

/** Arbitrary but fixed, and the same value `playground:happy-path` and
 *  `playground:deterministic-decision` default to — not `0`, so a reader greping sample
 *  output for the seed does not mistake it for "unset". */
const DEFAULT_SEED = 42;

const SEED_FLAG = '--seed=';

/** Decimal digits only, optional leading minus — `Number(raw)` alone maps `''` to `0`,
 *  `'0x10'` to `16` and `'1e3'` to `1000`, four ways to run a seed nobody chose
 *  (`playground/cli/happy-path.ts`, tester F4). */
const SEED_PATTERN = /^-?\d+$/;

export function parseSeed(argv: readonly string[]): number {
  const flag = argv.find((arg) => arg.startsWith(SEED_FLAG));
  const unrecognised = argv.find((arg) => !arg.startsWith(SEED_FLAG));
  if (unrecognised !== undefined) {
    throw new Error(
      `playground:repeated-failure: unrecognised argument "${unrecognised}" — the only option is ${SEED_FLAG}<integer>`,
    );
  }
  if (flag === undefined) return DEFAULT_SEED;
  const raw = flag.slice(SEED_FLAG.length);
  if (!SEED_PATTERN.test(raw)) {
    throw new Error(`playground:repeated-failure: --seed must be an integer, got "${raw}"`);
  }
  return Number(raw);
}

/** `playground/index.ts`'s own doc: "reading the environment is the CLI's job, not this
 *  seam's". The resolved value is printed in the banner, so an override is always visible in
 *  the output it shapes. */
export function resolveEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['PLAYGROUND_ENDPOINT'];
  return override !== undefined && override !== '' ? override : PLAYGROUND_DEFAULT_ENDPOINT;
}

/** `no-console` (`eslint.config.js`) carves out `spike/**` and `scripts/**`, not
 *  `playground/**`. Writing to `process.stdout` is this file's own summary output and is
 *  unaffected by that rule, which targets the `console` global. */
function println(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The four §20.2 conditions this emission can speak to, each printed as the value that was
 * recorded rather than as a claim that it held: one runId, one toolName, the distinct
 * fingerprints across attempts (one, when the streak is intact), and the count of attempts
 * that failed with no success between them.
 */
function printAttempts(result: RepeatedFailureScenarioResult): void {
  const fingerprints = [...new Set(result.attempts.map((attempt) => attempt.inputFingerprint))];
  const toolNames = [...new Set(result.attempts.map((attempt) => attempt.toolName))];
  const failed = result.attempts.filter((attempt) => !attempt.success);

  println('');
  println(`attempts: ${result.attempts.length} (§20.2 floor: ${ATTEMPTS})`);
  println(`  tool: ${toolNames.join(', ')}`);
  println(`  distinct inputFingerprints: ${fingerprints.length} — ${fingerprints.join(', ')}`);
  println(`  failed: ${failed.length} of ${result.attempts.length}, none succeeded between them`);
  for (const attempt of result.attempts) {
    println(
      `  #${attempt.attempt} ${attempt.toolName} toolCallId=${attempt.toolCallId} ` +
        `success=${String(attempt.success)}`,
    );
  }
}

function printSummary(seed: number, endpoint: string, result: RepeatedFailureScenarioResult): void {
  println(`playground:repeated-failure — seed=${seed} endpoint=${endpoint}`);
  println(`run: ${result.runId} status=${result.status}`);
  printAttempts(result);

  const stats = result.telemetryStats;
  println('');
  println(
    `telemetry: recorded=${stats.recorded} delivered=${stats.delivered} ` +
      `droppedUndeliverable=${stats.droppedUndeliverable} droppedOverflow=${stats.droppedOverflow} ` +
      `droppedInvalid=${stats.droppedInvalid}`,
  );
  if (stats.droppedUndeliverable > 0) {
    println(
      `note: ${stats.droppedUndeliverable} event(s) could not be delivered to ${endpoint} ` +
        '— is the LenGentic API running? (`pnpm dev`)',
    );
  }
  println(
    `persistence: accepted=${stats.serverAccepted} duplicate=${stats.serverDuplicate} ` +
      `rejected=${stats.serverRejected} unattributed=${stats.serverCountsUnavailable}`,
  );
  if (stats.serverAccepted === 0 && stats.serverDuplicate > 0) {
    println('note: no new data was recorded — this seed and scenario already exist in LenGentic');
  }
  // The claim this command may make and no more: it emitted the run §20.2 is defined
  // against. Whether the analyzer returns REPEATED_FAILED_ACTION is the analyzer's answer,
  // read from the analysis response — never from here (`./scenario.ts`'s "What this file
  // does NOT do"). `p7.e2e` owns that assertion.
  println('');
  println(`emitted only — no verdict is computed here. ${TOOL_NAME} failed ${ATTEMPTS} times`);
  println('consecutively on one runId with one inputFingerprint; trigger analysis and read');
  println('the response for REPEATED_FAILED_ACTION.');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const seed = parseSeed(argv);
  const endpoint = resolveEndpoint();
  const result = await runRepeatedFailureScenario({
    seed,
    telemetryConfig: { maxRetries: 0, endpoint },
  });
  printSummary(seed, endpoint, result);
  return 0;
}

/* istanbul ignore next -- entry guard, exercised by running the command, not by unit tests */
if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(
        'playground:repeated-failure failed:',
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    });
}
