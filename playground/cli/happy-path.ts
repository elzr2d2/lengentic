/**
 * `pnpm playground:happy-path` — Phase 3 work package 6 (`MVP_PLAN_V3.md` Phase 3 work
 * package table). Runs the already-built five-step `MockAgent` workflow
 * (`Start → Plan → Execute → Validate → Complete`) through the real Telemetry SDK, using
 * the seeded `Clock`/`IdGenerator` (`p3.seeded-clock`) and `MockProvider` `MockAgent`
 * (`p3.mock-agent`) already composes — the phase objective's
 * `Mock Agent → Telemetry SDK → LenGentic` pipeline, made runnable as one command.
 *
 * Composes only `../agents` (`MockAgent`'s public entry) and `../index` (this package's
 * own composition root, for the default endpoint printed below) — never
 * `@lengentic/telemetry-sdk` directly. `../index` is the one seam
 * `playground-sdk-public-entry-only` (`pnpm check:boundaries`) lets any of `playground/**`
 * reach the SDK through; a CLI importing the SDK a second way would give this file its own
 * opinion on a boundary `../index` already owns.
 *
 * Determinism: `MockAgent`'s own guarantee is "same seed → byte-identical telemetry"
 * (its module doc, and this phase's Definition of Done). `--seed` is the one input this
 * command exposes for that reason — every other `MockAgentConfig` knob keeps its
 * documented default, because "the happy path" is one fixed scenario, not a
 * general-purpose harness. The default seed and default `MockProviderConfig`
 * (`delayMs: 0`, `failureRate: 0`) mean an unparameterised run always completes.
 *
 * ## `maxRetries: 0` — reproduced, not guessed
 *
 * Talks to `PLAYGROUND_DEFAULT_ENDPOINT` (`../index`). With the SDK's own default
 * `maxRetries` (3) and the LenGentic API not running (the common case for this command —
 * nothing in `pnpm gates` or this packet's validation commands starts it), the process
 * exits 0 with **no output at all**, well before `agent.run()` ever settles: a retry's
 * backoff timer is scheduled through `Client.schedule()`
 * (`platform/telemetry-sdk/src/client.ts`), which sets `keepProcessAlive: this.draining` —
 * `false` outside `shutdown()`'s own drain, which `MockAgent.run()`'s plain
 * `await telemetry.flush()` never enters. An unref'd timer does not hold the event loop
 * open, so Node exits with the retry's `await` silently abandoned — the same
 * hang-that-exits-0 shape as the `MockProvider` R1 bug
 * (`playground/providers/mock-provider.ts`'s own `keepProcessAlive: true` fix), just one
 * layer up, in a file `playground/cli/**` cannot touch (`playground-sdk-public-entry-only`
 * forbids reaching `platform/telemetry-sdk/src/**` at all, and this packet's
 * `allowed_paths` forbid editing it either way). Filed to `BACKLOG.md` ("Discovered during
 * p3.cli, filed at the Phase 3 wave-4 gate") rather than fixed here.
 *
 * `maxRetries: 0` sidesteps it without touching the SDK: `deliverBatch` breaks out on
 * `attempt === maxAttempts` *before* scheduling a backoff, so with `maxAttempts = 1` no
 * unref'd timer is ever armed. Verified directly (`node --import tsx`, no `node:test`
 * runner holding the loop open): default `maxRetries` — process exits 0 with zero stdout,
 * `agent.run()` never resolves; `maxRetries: 0` — resolves and prints normally, with
 * `telemetryStats.droppedUndeliverable` and `.deliveryFailures` correctly showing the
 * failed attempt. Delivery itself is unaffected on a reachable endpoint: the very first
 * attempt succeeds and no retry is ever needed, retried or not.
 */
import { MockAgent, type MockAgentRunResult } from '../agents';
import { PLAYGROUND_DEFAULT_ENDPOINT } from '../index';

/** Arbitrary but fixed — not `0`, so a caller who greps sample output for the seed does
 *  not mistake it for "unset". Any value works; determinism does not depend on which one. */
const DEFAULT_SEED = 42;

const SEED_FLAG = '--seed=';

/** Decimal digits only, optional leading minus. `Number(raw)` alone is not enough: it maps
 *  `''` to `0`, `'0x10'` to `16`, `'1e3'` to `1000` and `' 7 '` to `7` — four ways a caller
 *  ends up on a fully deterministic run under a seed they never chose (tester F4: `--seed=`
 *  with an unset shell variable silently ran seed 0). */
const SEED_PATTERN = /^-?\d+$/;

export function parseSeed(argv: readonly string[]): number {
  const flag = argv.find((arg) => arg.startsWith(SEED_FLAG));
  const unrecognised = argv.find((arg) => !arg.startsWith(SEED_FLAG));
  if (unrecognised !== undefined) {
    // `--seed 4321` (space form) used to silently run the default seed 42 — the bare
    // `--seed` never matched the `--seed=` prefix and both tokens were ignored (tester F4).
    throw new Error(
      `playground:happy-path: unrecognised argument "${unrecognised}" — the only option is ${SEED_FLAG}<integer>`,
    );
  }
  if (flag === undefined) return DEFAULT_SEED;
  const raw = flag.slice(SEED_FLAG.length);
  if (!SEED_PATTERN.test(raw)) {
    throw new Error(`playground:happy-path: --seed must be an integer, got "${raw}"`);
  }
  return Number(raw);
}

/** `no-console` (`eslint.config.js`) restricts `console.*` to `warn`/`error` everywhere
 *  outside the few directories carved out as "a CLI whose entire job is stdout" (`spike/**`,
 *  `scripts/**`) — `playground/cli/**` is not one of them, and widening that list is outside
 *  this packet's `allowed_paths` (root `package.json` only, not `eslint.config.js`). Writing
 *  straight to `process.stdout` is this file's own summary output, unaffected by the rule
 *  (which targets the `console` global specifically), without asking for an exemption this
 *  packet cannot grant itself. */
function println(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * `playground/index.ts`'s own doc on `PLAYGROUND_DEFAULT_ENDPOINT`: "reading the environment
 * is the CLI's job, not this seam's" — this is that job. The override exists so the
 * process-boundary spec can point a real spawned CLI at an endpoint where nothing is
 * listening and prove the `maxRetries: 0` regression claim against the premise it states
 * (tester F2: the spec used to run against the live API, could not fail for its stated
 * cause, and wrote real Runs into the dev database). The value is printed in the banner, so
 * an override is always visible in the output it shapes.
 */
export function resolveEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['PLAYGROUND_ENDPOINT'];
  return override !== undefined && override !== '' ? override : PLAYGROUND_DEFAULT_ENDPOINT;
}

function printSummary(seed: number, endpoint: string, result: MockAgentRunResult): void {
  println(`playground:happy-path — seed=${seed} endpoint=${endpoint}`);
  println(`run ${result.runId} — ${result.status}`);
  println(
    `strategy: ${result.strategy.mode} ` +
      `(eligible=${result.strategy.eligible}, effectiveConcurrency=${result.strategy.effectiveConcurrency}, ` +
      `evaluatorVersion=${result.strategy.evaluatorVersion})`,
  );
  for (const task of result.tasks) {
    const detail = task.error !== undefined ? ` — ${task.error}` : '';
    println(`  task "${task.name}": ${task.status}${detail}`);
  }
  const stats = result.telemetryStats;
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
  // Always printed (F1/B: `.artifacts/evidence/3/phase-gate/repair-1/architect-f1-decision.md`
  // §B) — `delivered` above is a transport count and cannot tell a reader whether this run
  // created anything new in LenGentic or was entirely deduplicated. This is that answer, at
  // the exact surface the finding names: the reader re-running this command's own output.
  println(
    `persistence: accepted=${stats.serverAccepted} duplicate=${stats.serverDuplicate} ` +
      `rejected=${stats.serverRejected} unattributed=${stats.serverCountsUnavailable}`,
  );
  if (stats.serverAccepted === 0 && stats.serverDuplicate > 0) {
    println('note: no new data was recorded — this seed and scenario already exist in LenGentic');
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const seed = parseSeed(argv);
  const endpoint = resolveEndpoint();
  // See the module doc's "`maxRetries: 0`" section — a reproduced SDK defect, not a guess.
  const agent = new MockAgent({ seed, telemetryConfig: { maxRetries: 0, endpoint } });
  const result = await agent.run();
  printSummary(seed, endpoint, result);
  return result.status === 'COMPLETED' ? 0 : 1;
}

/* istanbul ignore next -- entry guard, exercised via the process-boundary spec, not unit tests */
if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(
        'playground:happy-path failed:',
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    });
}
