/**
 * `R1`-`R5` input data for the §20.2 repeated-failed-action analyzer.
 *
 * New in Phase 5a, built from scratch. Shapes are transcribed from the `R fixtures — no
 * gates apply` table in MVP_PLAN_V3 Phase 5. `G1`-`G5` do not apply here: §20.2 is a
 * conditions analyzer that emits when all of its own conditions hold and is otherwise
 * silent, so there is no gate grid for these and writing one would imply a suppression
 * mechanism that does not exist.
 *
 * `R4` is required rather than optional: `R1`, `R2` and `R3` all expect silence, so an
 * implementation of §20.2 that is literally `return []` passes all three.
 *
 * `R5`'s timeline is PINNED — `F(A) F(A) S(B) F(A)` in a single run. Of the three ways to
 * write "an unrelated success interleaved", only this one discriminates the subsequence
 * reading of "consecutive" from the whole-timeline reading; the other two emit under both
 * and bind nothing.
 */
import type { ToolCallRecord } from '../../src/tool-call';

/** Client clock, ISO-8601 (§12 `occurredAt`). Ordering is the only property that matters. */
const at = (seconds: number): string =>
  new Date(Date.UTC(2026, 7, 17, 12, 0, seconds)).toISOString();

export interface ToolCallFixture {
  readonly id: 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
  readonly label: string;
  readonly rationale: string;
  readonly calls: readonly ToolCallRecord[];
}

export const TOOL_CALL_FIXTURES: readonly ToolCallFixture[] = [
  {
    id: 'R1',
    label: 'Batch iteration',
    rationale:
      'Ten identical actions with no failure at all. Nothing here is a failed attempt, so ' +
      'no condition of §20.2 is met at any point.',
    calls: Array.from({ length: 10 }, (_unused, index) => ({
      toolCallId: `tc_R1_${index + 1}`,
      runId: 'run_R1',
      toolName: 'process_batch_item',
      inputFingerprint: 'fp_R1_a',
      outcome: 'SUCCESS' as const,
      errorType: null,
      occurredAt: at(index + 1),
    })),
  },

  {
    id: 'R2',
    label: 'Below threshold',
    rationale:
      'Two consecutive failures against one target where §20.2 requires at least three. ' +
      'An implementation that emits on two has lowered the threshold silently.',
    calls: [
      {
        toolCallId: 'tc_R2_1',
        runId: 'run_R2',
        toolName: 'run_tests',
        inputFingerprint: 'fp_R2_a',
        outcome: 'FAILED',
        errorType: 'AssertionError',
        occurredAt: at(1),
      },
      {
        toolCallId: 'tc_R2_2',
        runId: 'run_R2',
        toolName: 'run_tests',
        inputFingerprint: 'fp_R2_a',
        outcome: 'FAILED',
        errorType: 'AssertionError',
        occurredAt: at(2),
      },
    ],
  },

  {
    id: 'R3',
    label: 'Changing inputs',
    rationale:
      'Four failures of one tool, a different inputFingerprint each time. Different targets ' +
      'means progress, not a loop — this is the fixture that keeps §20.2 from degenerating ' +
      'into "the agent failed a lot", which is the false-positive class that kills the ' +
      'product.',
    calls: ['a', 'b', 'c', 'd'].map((suffix, index) => ({
      toolCallId: `tc_R3_${index + 1}`,
      runId: 'run_R3',
      toolName: 'run_tests',
      inputFingerprint: `fp_R3_${suffix}`,
      outcome: 'FAILED' as const,
      errorType: 'AssertionError',
      occurredAt: at(index + 1),
    })),
  },

  {
    id: 'R4',
    label: 'Genuine repeated failure',
    rationale:
      'Three consecutive failures, same runId, same toolName, same inputFingerprint. The ' +
      'only unambiguous positive the R corpus has, and without it `return []` satisfies ' +
      'R1-R3 and the analyzer graduates unexercised.',
    calls: [
      {
        toolCallId: 'tc_R4_1',
        runId: 'run_R4',
        toolName: 'run_tests',
        inputFingerprint: 'fp_R4_a',
        outcome: 'FAILED',
        errorType: 'AssertionError',
        occurredAt: at(1),
      },
      {
        toolCallId: 'tc_R4_2',
        runId: 'run_R4',
        toolName: 'run_tests',
        inputFingerprint: 'fp_R4_a',
        outcome: 'FAILED',
        errorType: 'AssertionError',
        occurredAt: at(2),
      },
      {
        toolCallId: 'tc_R4_3',
        runId: 'run_R4',
        toolName: 'run_tests',
        inputFingerprint: 'fp_R4_a',
        outcome: 'FAILED',
        errorType: 'AssertionError',
        occurredAt: at(3),
      },
    ],
  },

  {
    id: 'R5',
    label: 'Interleaved success',
    rationale:
      'F(A) F(A) S(B) F(A) in ONE run: two failures against target A, one success from an ' +
      'unrelated tool B, then the third failure against A. Under the subsequence reading of ' +
      '"consecutive" this EMITS; under the whole-timeline reading the interleaved success ' +
      'breaks the streak and the analyzer goes quiet. The subsequence reading is correct — a ' +
      'finding that disappears because something else happened to succeed nearby depends on ' +
      'scheduling noise rather than on agent behaviour. The success sits in the MIDDLE on ' +
      'purpose: put it last or first and the fixture is green under both readings.',
    calls: [
      {
        toolCallId: 'tc_R5_1',
        runId: 'run_R5',
        toolName: 'run_tests',
        inputFingerprint: 'fp_R5_a',
        outcome: 'FAILED',
        errorType: 'AssertionError',
        occurredAt: at(1),
      },
      {
        toolCallId: 'tc_R5_2',
        runId: 'run_R5',
        toolName: 'run_tests',
        inputFingerprint: 'fp_R5_a',
        outcome: 'FAILED',
        errorType: 'AssertionError',
        occurredAt: at(2),
      },
      {
        toolCallId: 'tc_R5_3',
        runId: 'run_R5',
        toolName: 'lint_project',
        inputFingerprint: 'fp_R5_b',
        outcome: 'SUCCESS',
        errorType: null,
        occurredAt: at(3),
      },
      {
        toolCallId: 'tc_R5_4',
        runId: 'run_R5',
        toolName: 'run_tests',
        inputFingerprint: 'fp_R5_a',
        outcome: 'FAILED',
        errorType: 'AssertionError',
        occurredAt: at(4),
      },
    ],
  },
];

/** Look a tool-call fixture up by id, failing loudly rather than returning `undefined`. */
export function toolCallFixtureById(id: string): ToolCallFixture {
  const found = TOOL_CALL_FIXTURES.find((fixture) => fixture.id === id);
  if (found === undefined) throw new Error(`no tool-call fixture declared with id "${id}"`);
  return found;
}
