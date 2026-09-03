import type { GateId, RecommendationGroupKey } from '@lengentic/shared';

/**
 * The rendering vocabulary §21's required output shape is written in.
 *
 * Pure and separate from the components because the two rules below are the ones a reviewer
 * has to be able to check without reading JSX, and because a rule stated in one place cannot
 * be half-applied in a second component.
 */

/**
 * A 0..1 fraction as §21 prints it: `0.979` -> `97.9%`.
 *
 * One decimal place, matching every percentage in §21's output shape and §25's beats.
 */
export function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * `N/A`, never `0.0%`, when nothing has been attested.
 *
 * This is a Definition-of-Done line, not a formatting preference. `null` on
 * `dominantOptionAttestedSuccessRate` means no outcome was ever attested for the dominant
 * option; `0.0%` means every attested outcome was a failure. Printing the first as the second
 * turns "we were told nothing" into "we were told it always fails", which is the exact
 * overclaim `CLAUDE.md` ## Product claims exists to prevent — and it is an overclaim in the
 * direction a reader acts on.
 */
export const NOT_ATTESTED = 'N/A';

export function percentOrNotAttested(fraction: number | null): string {
  return fraction === null ? NOT_ATTESTED : percent(fraction);
}

/**
 * `G1_sample_count` -> `G1 sample_count`, which is how §19's table and §21's Gates block name
 * a gate. Only the first underscore: the rest of the id is the gate's own name.
 */
export function gateLabel(id: GateId): string {
  return id.replace('_', ' ');
}

/** §21's `Workflow: demo-workflow @ a1b2c3d`. */
export function workflowLabel(groupKey: RecommendationGroupKey): string {
  return `${groupKey.workflowName} @ ${groupKey.workflowVersion}`;
}
