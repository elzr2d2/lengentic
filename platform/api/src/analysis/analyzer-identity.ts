import type { RecommendationCategory } from '@lengentic/shared';

/**
 * Who produced a recommendation, as §21's `analyzerId` / `analyzerVersion` pair.
 *
 * ## The values are an assumption, recorded here because there is nowhere closer
 *
 * `MVP_PLAN_V3.md` names the analyzer ("§20.1 Deterministic Candidate") and constrains the
 * pair exactly once, negatively: §21's "a new `workflowVersion`, `contextKeyVersion`, or
 * `analyzerVersion` produces a NEW fingerprint". It never states a literal id or version. Taken
 * under `CLAUDE.md` ## Plan discipline — unclear and below an escalation trigger: decide from
 * the rules, document the assumption, prefer the reversible option.
 *
 * `deterministic-candidate` is §20.1's own name in kebab case. `1.0.0` is the version of the
 * analyzer's *behaviour*, not of any package: it is an input to
 * `recommendationFingerprint`, so it must change exactly when a recomputation should produce a
 * NEW recommendation rather than update the existing one. Binding it to
 * `@lengentic/analysis-engine`'s `package.json` version would tie that to release cadence and
 * split every recommendation on a patch release that changed no gate.
 *
 * Reversing either value costs one thing, and no data: existing rows keep their fingerprints
 * and the next analysis inserts new ones beside them. That is the reversible option
 * `fingerprint.ts` already accepted for the same field.
 *
 * `category` travels with the pair because §20 has two analyzers and each has exactly one
 * category — `fingerprint.ts` says so, which is why `category` is not a fingerprint input.
 * Keeping the three together is what makes that statement checkable in one place.
 */
export interface AnalyzerIdentity {
  readonly id: string;
  readonly version: string;
  readonly category: RecommendationCategory;
}

export const DETERMINISTIC_CANDIDATE_ANALYZER: AnalyzerIdentity = Object.freeze({
  id: 'deterministic-candidate',
  version: '1.0.0',
  category: 'DETERMINISTIC_CANDIDATE',
});
