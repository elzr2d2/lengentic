import type { AnalyzerConfig } from './config.ts';
import { percent, type GateEvaluation } from './gates.ts';
import type { DecisionAggregate } from './types.ts';

/**
 * Plain-text report rendering (MVP_PLAN §12, §73).
 *
 * Pure: takes data, returns a string. Nothing here writes to stdout.
 *
 * Two rules the format enforces on the product's behalf:
 *   - Every gate is shown, passing or failing, so a suppression always names its cause.
 *   - "Attested success", never "measured success". LenGentic did not measure it; the
 *     caller asserted it (§55).
 */

const WIDTH = 76;
const LABEL = 21;

export interface GroupReportInput {
  readonly fixtureId: string;
  readonly label: string;
  readonly aggregate: DecisionAggregate;
  readonly evaluation: GateEvaluation;
  readonly expectationStatus: 'MATCH' | 'MISMATCH';
  readonly mismatches: readonly string[];
}

export function renderGroup(input: GroupReportInput, config: AnalyzerConfig): string {
  const { aggregate: a, evaluation } = input;
  const lines: string[] = [];

  lines.push('─'.repeat(WIDTH));
  lines.push(`${input.fixtureId}  ${input.label}`);
  lines.push('─'.repeat(WIDTH));

  lines.push(field('Decision:', a.key.decisionType));
  lines.push(field('Workflow:', `${a.key.workflowName} @ ${a.key.workflowVersion}`));
  lines.push(field('Context key version:', a.key.contextKeyVersion));
  lines.push(field('Samples:', `${a.sampleCount}${renderExclusions(a)}`));
  lines.push(field('Distinct contexts:', String(a.distinctContextCount)));
  lines.push(field('Distribution:', renderDistribution(a)));
  lines.push(field('Attested success:', renderSuccess(a)));
  lines.push(field('Outcome coverage:', `${percent(a.outcomeCoverage)}  (${a.attestedCount}/${a.sampleCount})`));

  lines.push('');
  lines.push('Gates:');
  for (const gate of evaluation.gates) {
    const id = gate.id.slice(0, 2);
    lines.push(`  ${id}  ${gate.label.padEnd(18)}${gate.status.padEnd(16)}${gate.comparison}`);
  }

  lines.push('');
  lines.push(field('Verdict:', evaluation.verdict));

  lines.push('');
  lines.push(...renderCounterexamples(input));

  lines.push('');
  lines.push(field('Expectation:', input.expectationStatus));
  for (const mismatch of input.mismatches) {
    lines.push(`  ! ${mismatch}`);
  }

  void config;
  return lines.join('\n');
}

function field(label: string, value: string): string {
  return `${label.padEnd(LABEL)}${value}`;
}

function renderExclusions(a: DecisionAggregate): string {
  const { staleRun, missingContextKey } = a.excluded;
  if (staleRun === 0 && missingContextKey === 0) return '';
  return `   (excluded: ${staleRun} stale, ${missingContextKey} no contextKey)`;
}

function renderDistribution(a: DecisionAggregate): string {
  if (a.optionDistribution.length === 0) return '(none)';
  return a.optionDistribution
    .map((o) => `${o.option} ${o.count} (${percent(o.share)})`)
    .join(' | ');
}

function renderSuccess(a: DecisionAggregate): string {
  if (a.attestedSuccessRate === null) return 'n/a  (no attested outcomes)';
  const successes = Math.round(a.attestedSuccessRate * a.attestedCount);
  return `${percent(a.attestedSuccessRate)}  (caller-attested, ${successes}/${a.attestedCount})`;
}

/**
 * Counterexamples are listed in full for a CANDIDATE, because there they are evidence
 * attached to a live claim and summarizing them away is the overclaim §2 forbids.
 *
 * A SUPPRESSED group makes no claim, so its counterexamples are reported as a count and
 * a concentration rather than as pages of rows. D9 alone would otherwise print eighteen
 * entries in support of a recommendation that was never made.
 */
function renderCounterexamples(input: GroupReportInput): readonly string[] {
  const { aggregate: a, evaluation } = input;
  const lines: string[] = [];

  if (a.counterexamples.length === 0) {
    lines.push('Counterexamples:     none');
    return lines;
  }

  lines.push(`Counterexamples (${a.counterexamples.length}):`);

  if (evaluation.verdict === 'CANDIDATE') {
    for (const example of a.counterexamples) {
      lines.push(`  - ${example.runId}  context: ${example.contextKey}`);
      lines.push(`    selected ${example.selectedOption}, outcome ${example.outcome}`);
    }
  } else {
    lines.push('  (not listed — this group produced no recommendation)');
  }

  lines.push('  Minority concentration:');
  for (const entry of a.minorityContextConcentration) {
    lines.push(`    ${entry.contextKey.padEnd(28)}${entry.count}  (${percent(entry.share)})`);
  }

  if (evaluation.verdict === 'CANDIDATE') {
    lines.push('');
    lines.push('Note:');
    lines.push('  LenGentic observes chosen options only. It cannot determine what would');
    lines.push('  have happened had the minority option been selected. Review the');
    lines.push('  counterexamples before removing the branch.');
  }

  return lines;
}

export function renderHeader(config: AnalyzerConfig): string {
  return [
    '',
    '='.repeat(WIDTH),
    'LenGentic — Phase 0 Thesis Spike',
    'Deterministic candidate detection over hand-written fixtures',
    '='.repeat(WIDTH),
    '',
    'Thresholds:',
    `  G1 minSampleCount        ${config.minSampleCount}`,
    `  G2 minDistinctContexts   ${config.minDistinctContexts}`,
    `  G3 dominanceThreshold    ${percent(config.dominanceThreshold)}`,
    `  G4 successThreshold      ${percent(config.successThreshold)}`,
    `  G5 coverageThreshold     ${percent(config.coverageThreshold)}`,
    '',
  ].join('\n');
}

export function renderSummary(rows: readonly GroupReportInput[]): string {
  const lines: string[] = [];
  lines.push('='.repeat(WIDTH));
  lines.push('SUMMARY');
  lines.push('='.repeat(WIDTH));
  lines.push('');
  lines.push(`  ${'GROUP'.padEnd(8)}${'VERDICT'.padEnd(13)}${'GATES FAILED'.padEnd(24)}EXPECTATION`);

  for (const row of rows) {
    const failed = row.evaluation.failedGates.map((g) => g.slice(0, 2)).join(', ') || '—';
    const id = `${row.fixtureId}@${row.aggregate.key.workflowVersion.slice(0, 3)}`;
    lines.push(
      `  ${id.padEnd(8)}${row.evaluation.verdict.padEnd(13)}${failed.padEnd(24)}${row.expectationStatus}`,
    );
  }

  const mismatched = rows.filter((r) => r.expectationStatus === 'MISMATCH').length;
  const candidates = rows.filter((r) => r.evaluation.verdict === 'CANDIDATE').length;

  lines.push('');
  lines.push(`  ${rows.length} groups   ${candidates} CANDIDATE   ${rows.length - candidates} SUPPRESSED`);
  lines.push(
    mismatched === 0
      ? `  ${rows.length}/${rows.length} matched their declared expectation.`
      : `  ${mismatched}/${rows.length} DID NOT match their declared expectation.`,
  );
  lines.push('');

  return lines.join('\n');
}
