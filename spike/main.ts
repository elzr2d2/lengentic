import { aggregateAll } from './aggregate.ts';
import { DEFAULT_CONFIG, type AnalyzerConfig } from './config.ts';
import { expandGroup, loadFixtures, type FixtureGroup, type GroupExpectation } from './expand.ts';
import { evaluateGates, type GateEvaluation } from './gates.ts';
import { renderGroup, renderHeader, renderSummary, type GroupReportInput } from './report.ts';
import type { DecisionAggregate } from './types.ts';

/**
 * Phase 0 entry point — the only impure file in the spike.
 *
 * Every fixture declares the verdict it expects. The run compares actual against declared
 * and exits non-zero on any mismatch, so the spike is self-checking without a test
 * framework. That is not the real Phase 0 gate, though: MVP_PLAN §13's real gate is a
 * human reading all nine verdicts and agreeing with each one. If a verdict is defensible
 * to the code and wrong to a competent engineer, the thresholds are wrong — and fixing
 * them here costs an hour instead of a migration.
 */

function main(): void {
  const config: AnalyzerConfig = DEFAULT_CONFIG;
  const fixtures = loadFixtures();
  const rows: GroupReportInput[] = [];

  for (const fixture of fixtures) {
    // Aggregation runs per fixture so a version-split fixture (D8) yields multiple
    // groups from one declaration, which is exactly the behaviour under test.
    for (const aggregate of aggregateAll(expandGroup(fixture))) {
      const evaluation = evaluateGates(aggregate, config);
      const expectation = findExpectation(fixture, aggregate);
      const mismatches = compare(aggregate, evaluation, expectation);

      rows.push({
        fixtureId: fixture.id,
        label: fixture.label,
        aggregate,
        evaluation,
        expectationStatus: mismatches.length === 0 ? 'MATCH' : 'MISMATCH',
        mismatches,
      });
    }
    assertGroupCount(fixture, rows);
  }

  process.stdout.write(renderHeader(config));
  for (const row of rows) {
    process.stdout.write(`${renderGroup(row, config)}\n\n`);
  }
  process.stdout.write(renderSummary(rows));

  const failed = rows.filter((r) => r.expectationStatus === 'MISMATCH').length;
  process.exitCode = failed === 0 ? 0 : 1;
}

function findExpectation(
  fixture: FixtureGroup,
  aggregate: DecisionAggregate,
): GroupExpectation | undefined {
  return fixture.expect.find((e) => e.workflowVersion === aggregate.key.workflowVersion);
}

function assertGroupCount(fixture: FixtureGroup, rows: readonly GroupReportInput[]): void {
  const produced = rows.filter((r) => r.fixtureId === fixture.id).length;
  if (produced !== fixture.expect.length) {
    throw new Error(
      `${fixture.id}: expected ${fixture.expect.length} group(s) after grouping, got ${produced}`,
    );
  }
}

/**
 * Compare a group against its declared expectation.
 *
 * Gate comparison is set equality, not containment. "Suppressed by G2" when the group
 * also fails G4 is a materially different finding, and an assertion that tolerated the
 * difference would let the second problem graduate into Phase 5 unnoticed.
 */
function compare(
  aggregate: DecisionAggregate,
  evaluation: GateEvaluation,
  expectation: GroupExpectation | undefined,
): readonly string[] {
  if (expectation === undefined) {
    return [`no declared expectation for workflowVersion ${aggregate.key.workflowVersion}`];
  }

  const mismatches: string[] = [];
  const check = (name: string, actual: unknown, expected: unknown): void => {
    if (actual !== expected)
      mismatches.push(`${name}: expected ${String(expected)}, got ${String(actual)}`);
  };

  check('verdict', evaluation.verdict, expectation.verdict);
  check('sampleCount', aggregate.sampleCount, expectation.sampleCount);
  check('distinctContextCount', aggregate.distinctContextCount, expectation.distinctContextCount);
  check('counterexamples', aggregate.counterexamples.length, expectation.counterexamples);

  const actualGates = [...evaluation.failedGates].sort().join(',');
  const expectedGates = [...expectation.failedGates].sort().join(',');
  check('failedGates', actualGates || '(none)', expectedGates || '(none)');

  if (expectation.excluded !== undefined) {
    check('excluded.staleRun', aggregate.excluded.staleRun, expectation.excluded.staleRun);
    check(
      'excluded.missingContextKey',
      aggregate.excluded.missingContextKey,
      expectation.excluded.missingContextKey,
    );
  }

  return mismatches;
}

main();
