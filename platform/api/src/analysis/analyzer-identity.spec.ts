import { describe, expect, it } from 'vitest';

import {
  DETERMINISTIC_CANDIDATE_ANALYZER,
  REPEATED_FAILED_ACTION_ANALYZER,
} from './analyzer-identity';
import { recommendationFingerprint } from '../recommendations/fingerprint';

/**
 * Seam: the `analyzerId` / `analyzerVersion` pair, and what §21 says happens to a
 * recommendation's identity when either changes.
 *
 * ## Why a constant deserves a pinning test
 *
 * Normally it does not — a test that restates a literal proves nothing about behaviour. This
 * pair is the exception because it is a FINGERPRINT INPUT: §21's "a new `workflowVersion`,
 * `contextKeyVersion`, or `analyzerVersion` produces a NEW fingerprint" makes an edit to
 * either value a data event. Every existing row is orphaned at its old fingerprint, the next
 * analysis inserts a fresh row beside it, and every dismissal a human recorded stops applying
 * — because a dismissal is stored on the row the old fingerprint names.
 *
 * The 5b wave gate measured what that costs when nothing pins it: `version: '1.0.0'` →
 * `'9.9.9'` passed all 375 API tests, all 107 dashboard tests, and the integration probe
 * (mutant M25). The consequence is asserted below alongside the pin, so a reader who wants to
 * change the value can see what they are choosing rather than only that a test says no.
 */

const GROUP_KEY = {
  workflowName: 'demo-workflow',
  workflowVersion: 'a1b2c3d',
  decisionType: 'run_tests_after_code_change',
  contextKeyVersion: 'v1',
};

describe('DETERMINISTIC_CANDIDATE_ANALYZER', () => {
  it('is §20.1 analyzer, at its first behaviour version, in §21 one category', () => {
    expect(DETERMINISTIC_CANDIDATE_ANALYZER).toStrictEqual({
      id: 'deterministic-candidate',
      version: '1.0.0',
      category: 'DETERMINISTIC_CANDIDATE',
    });
  });

  it('is frozen, so no caller can re-identify every recommendation at runtime', () => {
    expect(Object.isFrozen(DETERMINISTIC_CANDIDATE_ANALYZER)).toBe(true);
  });
});

describe('§21 — a new analyzerVersion produces a NEW fingerprint', () => {
  const shipped = recommendationFingerprint({
    analyzerId: DETERMINISTIC_CANDIDATE_ANALYZER.id,
    analyzerVersion: DETERMINISTIC_CANDIDATE_ANALYZER.version,
    groupKey: GROUP_KEY,
  });

  it('re-fingerprints every recommendation when the version changes — the cost of editing the constant', () => {
    const bumped = recommendationFingerprint({
      analyzerId: DETERMINISTIC_CANDIDATE_ANALYZER.id,
      analyzerVersion: '9.9.9',
      groupKey: GROUP_KEY,
    });

    expect(bumped).not.toBe(shipped);
  });

  it('re-fingerprints when the id changes too — both halves of the pair are inputs', () => {
    const renamed = recommendationFingerprint({
      analyzerId: 'deterministic-candidates',
      analyzerVersion: DETERMINISTIC_CANDIDATE_ANALYZER.version,
      groupKey: GROUP_KEY,
    });

    expect(renamed).not.toBe(shipped);
  });

  it('is stable across two computations of the shipped pair — re-analysis updates, never inserts', () => {
    expect(
      recommendationFingerprint({
        analyzerId: DETERMINISTIC_CANDIDATE_ANALYZER.id,
        analyzerVersion: DETERMINISTIC_CANDIDATE_ANALYZER.version,
        groupKey: { ...GROUP_KEY },
      }),
    ).toBe(shipped);
  });
});

describe('REPEATED_FAILED_ACTION_ANALYZER', () => {
  it('is §20.2 analyzer, at its first behaviour version, in its own category', () => {
    expect(REPEATED_FAILED_ACTION_ANALYZER).toStrictEqual({
      id: 'repeated-failed-action',
      version: '1.0.0',
      category: 'REPEATED_FAILED_ACTION',
    });
  });

  it('is a different analyzer id from §20.1, so the two fingerprint spaces cannot meet', () => {
    expect(REPEATED_FAILED_ACTION_ANALYZER.id).not.toBe(DETERMINISTIC_CANDIDATE_ANALYZER.id);
  });
});
