/**
 * Declared group shape -> individual `DecisionRecord`s.
 *
 * Deliberately dumb, for the same reason `spike/expand.ts` was: this file knows how to
 * materialise a declared shape and nothing else. It performs no counting, no grouping,
 * no ratio and no gate logic, so a bug in the wave-3 analyzer cannot be cancelled out by
 * a matching bug here.
 *
 * It imports the engine's TYPES and never its behaviour. `.dependency-cruiser.cjs`
 * (`engine-fixtures-not-to-analyzers`) enforces that: an expectation that can reach the
 * analyzer can be sourced from it, which is the provenance failure MVP_PLAN_V3 Phase 5
 * exists to prevent.
 */
import type { DecisionRecord, Outcome } from '../../src/types';

export interface DecisionSpec {
  readonly selected: string;
  readonly outcome: Outcome;
  readonly count: number;
  /** Absent = assign by round-robin. `null` = deliberately missing, must be excluded. */
  readonly contextKey?: string | null;
  /** Absent = the group's own version. Present = this block splits into its own group. */
  readonly workflowVersion?: string;
  readonly runIsStale?: boolean;
}

export interface DecisionGroupSpec {
  readonly id: string;
  readonly label: string;
  readonly rationale: string;
  readonly workflowName: string;
  readonly workflowVersion: string;
  readonly decisionType: string;
  readonly contextKeyVersion: string;
  readonly availableOptions: readonly string[];
  /** The context pool. Assigned round-robin, in order, from the first entry. */
  readonly contexts: readonly string[];
  readonly decisions: readonly DecisionSpec[];
}

/**
 * Expand a declared group into individual decision records.
 *
 * Context assignment is round-robin over `contexts` by the record's ordinal position in
 * the group, so a group of N decisions over C contexts covers all C exactly when N >= C.
 * A spec that pins `contextKey` overrides the round-robin but still consumes an ordinal,
 * which keeps identifiers stable when a block above it is edited.
 */
export function expandDecisionGroup(group: DecisionGroupSpec): readonly DecisionRecord[] {
  if (group.contexts.length === 0) throw new Error(`${group.id}: contexts must not be empty`);
  if (group.decisions.length === 0) throw new Error(`${group.id}: decisions must not be empty`);

  const records: DecisionRecord[] = [];
  let ordinal = 0;

  for (const spec of group.decisions) {
    if (!Number.isInteger(spec.count) || spec.count < 1) {
      throw new Error(`${group.id}: decision count must be a positive integer`);
    }
    if (!group.availableOptions.includes(spec.selected)) {
      throw new Error(`${group.id}: selected "${spec.selected}" is not in availableOptions`);
    }

    for (let i = 0; i < spec.count; i += 1) {
      const rotated = group.contexts[ordinal % group.contexts.length];
      if (rotated === undefined) throw new Error(`${group.id}: empty context rotation`);

      records.push({
        decisionId: `dec_${group.id}_${ordinal}`,
        runId: `run_${group.id}_${ordinal}`,
        runIsStale: spec.runIsStale ?? false,
        workflowName: group.workflowName,
        workflowVersion: spec.workflowVersion ?? group.workflowVersion,
        decisionType: group.decisionType,
        contextKey: spec.contextKey === undefined ? rotated : spec.contextKey,
        contextKeyVersion: group.contextKeyVersion,
        availableOptions: group.availableOptions,
        selectedOption: spec.selected,
        outcome: spec.outcome,
        outcomeAttestedBy: spec.outcome === 'UNKNOWN' ? 'UNKNOWN' : 'CALLER',
      });
      ordinal += 1;
    }
  }

  return records;
}

/** Look a declared group up by id, failing loudly rather than returning `undefined`. */
export function groupById(groups: readonly DecisionGroupSpec[], id: string): DecisionGroupSpec {
  const found = groups.find((group) => group.id === id);
  if (found === undefined) throw new Error(`no fixture group declared with id "${id}"`);
  return found;
}
