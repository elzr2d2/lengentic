/**
 * `pnpm playground:deterministic-decision` — Scenario 3's entry point (`MVP_PLAN_V3.md`
 * Phase 6, work package 2), and the second line of §25's demo script.
 *
 * One process, both cohorts: the deterministic candidate and the low-diversity suppression
 * control. `./scenario.ts` owns the emission; this file owns argv, the endpoint, and the
 * summary a human reads.
 *
 * It prints **what was emitted**, never a verdict. The candidate cohort's sample count and
 * distinct-context count are the inputs G1 and G2 are evaluated against, so printing them is
 * what lets a reader check the gates against the analyzer's own output rather than take this
 * command's word for either.
 *
 * `maxRetries: 0` for the same reproduced SDK defect `playground/cli/happy-path.ts`
 * documents at length: with the SDK's default `maxRetries` and no API listening, a retry's
 * backoff timer is scheduled unref'd, Node exits 0 with the `await` abandoned, and the
 * command produces no output at all. That failure mode is worse here than there — this
 * scenario emits dozens of runs, so a reader would see a partial workload silently truncate.
 * Filed to `BACKLOG.md` during `p3.cli`; sidestepped, not fixed, from here.
 */
import {
  runDeterministicDecisionScenario,
  type CohortEmission,
  type DeterministicDecisionScenarioResult,
} from './scenario';
import { PLAYGROUND_DEFAULT_ENDPOINT } from '../../index';

/** Arbitrary but fixed, and the same value `playground:happy-path` defaults to — not `0`, so
 *  a reader greping sample output for the seed does not mistake it for "unset". */
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
      `playground:deterministic-decision: unrecognised argument "${unrecognised}" — the only option is ${SEED_FLAG}<integer>`,
    );
  }
  if (flag === undefined) return DEFAULT_SEED;
  const raw = flag.slice(SEED_FLAG.length);
  if (!SEED_PATTERN.test(raw)) {
    throw new Error(`playground:deterministic-decision: --seed must be an integer, got "${raw}"`);
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

function printCohort(cohort: CohortEmission): void {
  const attested = cohort.decisions.filter((decision) => decision.outcome !== 'UNKNOWN');
  const counts = new Map<string, number>();
  for (const decision of cohort.decisions) {
    counts.set(decision.selectedOption, (counts.get(decision.selectedOption) ?? 0) + 1);
  }
  const distribution = [...counts.entries()]
    .map(([option, count]) => `${option}=${count}`)
    .join(' ');

  println('');
  println(`cohort "${cohort.id}" — ${cohort.label}`);
  println(
    `  group key: ${cohort.groupKey.workflowName} @ ${cohort.groupKey.workflowVersion} ` +
      `/ ${cohort.groupKey.decisionType} / ${cohort.groupKey.contextKeyVersion}`,
  );
  println(
    `  samples: ${cohort.sampleCount}   distinct contexts: ${cohort.distinctContextKeys.length}`,
  );
  println(`  contexts: ${cohort.distinctContextKeys.join(', ')}`);
  println(`  selections: ${distribution}`);
  println(`  attested outcomes: ${attested.length} of ${cohort.sampleCount}`);
}

function printSummary(
  seed: number,
  endpoint: string,
  result: DeterministicDecisionScenarioResult,
): void {
  println(`playground:deterministic-decision — seed=${seed} endpoint=${endpoint}`);
  println(`runs emitted: ${result.runCount}`);
  for (const cohort of result.cohorts) printCohort(cohort);

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
  // The claim this command may make and no more: it emitted two cohorts. Whether they come
  // back DETERMINISTIC_CANDIDATE and SUPPRESSED is the analyzer's answer, read from the
  // analysis response — never from here (`./scenario.ts`'s "What this file does NOT do").
  println('');
  println('emitted only — no verdict is computed here. Trigger analysis and read the');
  println('evaluatedGroups array: the candidate group carries counterexamples, and the');
  println('control group is expected SUPPRESSED with G2_context_diversity failing.');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const seed = parseSeed(argv);
  const endpoint = resolveEndpoint();
  const result = await runDeterministicDecisionScenario({
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
        'playground:deterministic-decision failed:',
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    });
}
