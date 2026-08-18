/**
 * `B1`-`B5` input data — the fifteen threshold boundary groups.
 *
 * These exist because `docs/decisions/0004-no-tester-at-the-5a-gate.md` pays for skipping
 * Tester with a threshold-binding spec, and against `D1`-`D11` alone that spec cannot fail:
 * sample counts are 12, 24, 26, 40, 45, 50, 50, 50 and 60 and never 30; distinct-context
 * counts are 2, 8, 8, 9, 10, 10, 11, 12 and 15 and never 5; no ratio is 0.90 or 0.80. Every
 * D fixture sits far from every threshold, so a one-unit shift moves no verdict and the spec
 * is green by construction.
 *
 * Each group sits one unit below (`-lo`), exactly on (`-at`), or one unit above (`-hi`) the
 * threshold its letter names. Input shapes are transcribed from the `Inputs` block of
 * `Threshold boundary rows` in MVP_PLAN_V3 Phase 5; expected values live in
 * `../expectations.ts`, transcribed from the table below that block.
 *
 * `p5.det-candidate` writes the spec that consumes these and may not edit this file or the
 * expectations beside it. The packet that has to make the spec pass therefore cannot author
 * what the spec asserts.
 *
 * All fifteen deliberately share one group key. They are analyzed independently, one group
 * per call — the shared key is transcribed, not a merge instruction.
 */
import type { DecisionGroupSpec, DecisionSpec } from './expand';

const POOL = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'] as const;

/** The pool's first `n` entries. Round-robin assignment starts from `c1`, in order. */
const pool = (n: number): readonly string[] => POOL.slice(0, n);

function boundaryGroup(
  id: string,
  label: string,
  contexts: readonly string[],
  decisions: readonly DecisionSpec[],
): DecisionGroupSpec {
  return {
    id,
    label,
    rationale: `Threshold boundary group ${id}. ${label}`,
    workflowName: 'boundary-wf',
    workflowVersion: 'v1',
    decisionType: 'boundary_decision',
    contextKeyVersion: 'ckv1',
    availableOptions: ['YES', 'NO'],
    contexts,
    decisions,
  };
}

const allYesSuccess = (count: number): readonly DecisionSpec[] => [
  { selected: 'YES', outcome: 'SUCCESS', count },
];

export const BOUNDARY_GROUPS: readonly DecisionGroupSpec[] = [
  // B1 — minSampleCount, default 30.
  boundaryGroup('B1-lo', 'One sample below minSampleCount', pool(8), allYesSuccess(29)),
  boundaryGroup('B1-at', 'Exactly minSampleCount', pool(8), allYesSuccess(30)),
  boundaryGroup('B1-hi', 'One sample above minSampleCount', pool(8), allYesSuccess(31)),

  // B2 — minDistinctContexts, default 5. Sample count is held at 40 and the pool moves.
  boundaryGroup('B2-lo', 'One context below minDistinctContexts', pool(4), allYesSuccess(40)),
  boundaryGroup('B2-at', 'Exactly minDistinctContexts', pool(5), allYesSuccess(40)),
  boundaryGroup('B2-hi', 'One context above minDistinctContexts', pool(6), allYesSuccess(40)),

  // B3 — dominanceThreshold, default 0.9. The NO rows FAIL, which keeps the dominant
  // option's own attested rate at 100% while the blend across both options lands at the
  // dominance figure. B3-lo is the group where the two readings of G4 land on opposite
  // sides of the threshold.
  boundaryGroup('B3-lo', 'One unit below dominanceThreshold', pool(8), [
    { selected: 'YES', outcome: 'SUCCESS', count: 899 },
    { selected: 'NO', outcome: 'FAILURE', count: 101 },
  ]),
  boundaryGroup('B3-at', 'Exactly dominanceThreshold', pool(8), [
    { selected: 'YES', outcome: 'SUCCESS', count: 900 },
    { selected: 'NO', outcome: 'FAILURE', count: 100 },
  ]),
  boundaryGroup('B3-hi', 'One unit above dominanceThreshold', pool(8), [
    { selected: 'YES', outcome: 'SUCCESS', count: 901 },
    { selected: 'NO', outcome: 'FAILURE', count: 99 },
  ]),

  // B4 — successThreshold, default 0.9.
  boundaryGroup('B4-lo', 'One unit below successThreshold', pool(8), [
    { selected: 'YES', outcome: 'SUCCESS', count: 899 },
    { selected: 'YES', outcome: 'FAILURE', count: 101 },
  ]),
  boundaryGroup('B4-at', 'Exactly successThreshold', pool(8), [
    { selected: 'YES', outcome: 'SUCCESS', count: 900 },
    { selected: 'YES', outcome: 'FAILURE', count: 100 },
  ]),
  boundaryGroup('B4-hi', 'One unit above successThreshold', pool(8), [
    { selected: 'YES', outcome: 'SUCCESS', count: 901 },
    { selected: 'YES', outcome: 'FAILURE', count: 99 },
  ]),

  // B5 — coverageThreshold, default 0.8.
  boundaryGroup('B5-lo', 'One unit below coverageThreshold', pool(8), [
    { selected: 'YES', outcome: 'SUCCESS', count: 799 },
    { selected: 'YES', outcome: 'UNKNOWN', count: 201 },
  ]),
  boundaryGroup('B5-at', 'Exactly coverageThreshold', pool(8), [
    { selected: 'YES', outcome: 'SUCCESS', count: 800 },
    { selected: 'YES', outcome: 'UNKNOWN', count: 200 },
  ]),
  boundaryGroup('B5-hi', 'One unit above coverageThreshold', pool(8), [
    { selected: 'YES', outcome: 'SUCCESS', count: 801 },
    { selected: 'YES', outcome: 'UNKNOWN', count: 199 },
  ]),
];
