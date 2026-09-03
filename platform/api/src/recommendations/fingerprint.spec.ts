import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { recommendationFingerprint, type RecommendationFingerprintInput } from './fingerprint';

/**
 * Seam: `recommendationFingerprint` as a pure function of its declared input set.
 *
 * The expected values are sourced independently of the implementation — the first assertion
 * recomputes SHA-256 over the canonical string by hand, so an implementation that hashed a
 * different string, or a different algorithm, fails here rather than agreeing with itself.
 * Every other assertion is about a property §21 states, not about a hash value.
 */

const BASE: RecommendationFingerprintInput = {
  analyzerId: 'deterministic-candidate',
  analyzerVersion: '1.0.0',
  groupKey: {
    workflowName: 'demo-workflow',
    workflowVersion: 'a1b2c3d',
    decisionType: 'run_tests_after_code_change',
    contextKeyVersion: 'v1',
  },
};

function withGroupKey(
  overrides: Partial<RecommendationFingerprintInput['groupKey']>,
): RecommendationFingerprintInput {
  return { ...BASE, groupKey: { ...BASE.groupKey, ...overrides } };
}

describe('recommendationFingerprint', () => {
  it('is SHA-256 hex over the six inputs, in the declared order', () => {
    // Computed here, not read off the module: `createHash` is Node's, and the canonical
    // string is written out longhand. Changing the field order, the separator or the digest
    // in fingerprint.ts turns this red.
    const expected = createHash('sha256')
      .update(
        '["deterministic-candidate","1.0.0","demo-workflow","a1b2c3d","run_tests_after_code_change","v1"]',
        'utf8',
      )
      .digest('hex');

    expect(recommendationFingerprint(BASE)).toBe(expected);
    expect(recommendationFingerprint(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls — the same group re-analysed is the same recommendation (§21)', () => {
    expect(recommendationFingerprint(BASE)).toBe(recommendationFingerprint({ ...BASE }));
  });

  // §21: "A new workflowVersion, contextKeyVersion, or analyzerVersion produces a NEW
  // fingerprint, and therefore a new recommendation." All three, one assertion each — a
  // fingerprint that ignored any one of them would still pass a test that only checked
  // another.
  it('changes when workflowVersion changes (§21)', () => {
    expect(recommendationFingerprint(withGroupKey({ workflowVersion: 'deadbee' }))).not.toBe(
      recommendationFingerprint(BASE),
    );
  });

  it('changes when contextKeyVersion changes (§21)', () => {
    expect(recommendationFingerprint(withGroupKey({ contextKeyVersion: 'v2' }))).not.toBe(
      recommendationFingerprint(BASE),
    );
  });

  it('changes when analyzerVersion changes (§21)', () => {
    expect(recommendationFingerprint({ ...BASE, analyzerVersion: '1.0.1' })).not.toBe(
      recommendationFingerprint(BASE),
    );
  });

  it('changes when the workflow, the decision type or the analyzer changes', () => {
    const distinct = new Set([
      recommendationFingerprint(BASE),
      recommendationFingerprint(withGroupKey({ workflowName: 'other-workflow' })),
      recommendationFingerprint(withGroupKey({ decisionType: 'execution_strategy' })),
      recommendationFingerprint({ ...BASE, analyzerId: 'repeated-failed-action' }),
    ]);

    expect(distinct.size).toBe(4);
  });

  it('does not collide when a value contains the encoding it is serialized with', () => {
    // The failure mode a `join('|')` or `join(':')` encoding has: shifting a character
    // across a field boundary produces the same flat string. JSON escapes each field, so
    // these two inputs — and the quote-and-bracket case below — must stay distinct.
    const left = withGroupKey({ workflowName: 'a', workflowVersion: 'b|c' });
    const right = withGroupKey({ workflowName: 'a|b', workflowVersion: 'c' });

    expect(recommendationFingerprint(left)).not.toBe(recommendationFingerprint(right));

    const quoted = withGroupKey({ workflowName: '","' });

    expect(recommendationFingerprint(quoted)).not.toBe(
      recommendationFingerprint(withGroupKey({ workflowName: '', workflowVersion: '' })),
    );
  });

  it('ignores nothing it accepts — every declared input is load-bearing', () => {
    // A guard against the reverse defect: an implementation that hashed only the group key
    // would pass the three §21 assertions above except the analyzerVersion one, and one that
    // hashed a JSON object rather than an array could reorder keys silently. Six inputs, six
    // distinct fingerprints plus the base.
    const fingerprints = [
      recommendationFingerprint(BASE),
      recommendationFingerprint({ ...BASE, analyzerId: 'x' }),
      recommendationFingerprint({ ...BASE, analyzerVersion: 'x' }),
      recommendationFingerprint(withGroupKey({ workflowName: 'x' })),
      recommendationFingerprint(withGroupKey({ workflowVersion: 'x' })),
      recommendationFingerprint(withGroupKey({ decisionType: 'x' })),
      recommendationFingerprint(withGroupKey({ contextKeyVersion: 'x' })),
    ];

    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });
});
