import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DecisionRecord, Outcome } from './types.ts';
import type { GateId, Verdict } from './gates.ts';

/**
 * Fixture loading and expansion.
 *
 * Deliberately dumb: this file knows how to turn a declared group shape into decision
 * records and nothing else. It performs no counting, no grouping, and no gate logic, so
 * a bug in the analyzer cannot be cancelled out by a matching bug here.
 */

interface DecisionSpec {
  readonly selected: string;
  readonly outcome: Outcome;
  readonly count: number;
  /** Absent = assign by round-robin. `null` = deliberately missing, must be excluded. */
  readonly contextKey?: string | null;
  readonly workflowVersion?: string;
  readonly runIsStale?: boolean;
}

export interface GroupExpectation {
  readonly workflowVersion: string;
  readonly verdict: Verdict;
  readonly sampleCount: number;
  readonly distinctContextCount: number;
  readonly failedGates: readonly GateId[];
  readonly counterexamples: number;
  readonly excluded?: { readonly staleRun: number; readonly missingContextKey: number };
}

export interface FixtureGroup {
  readonly id: string;
  readonly label: string;
  readonly rationale: string;
  readonly workflowName: string;
  readonly workflowVersion: string;
  readonly decisionType: string;
  readonly contextKeyVersion: string;
  readonly availableOptions: readonly string[];
  readonly contexts: readonly string[];
  readonly decisions: readonly DecisionSpec[];
  readonly expect: readonly GroupExpectation[];
}

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/decisions.json', import.meta.url));

export function loadFixtures(): readonly FixtureGroup[] {
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const groups = (parsed as { groups?: unknown }).groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error(`${FIXTURE_PATH}: expected a non-empty "groups" array`);
  }
  return groups.map(assertGroup);
}

function assertGroup(candidate: unknown, index: number): FixtureGroup {
  const group = candidate as FixtureGroup;
  const where = `groups[${index}]`;
  if (typeof group?.id !== 'string') throw new Error(`${where}: missing id`);
  if (group.contexts.length === 0) throw new Error(`${group.id}: contexts must not be empty`);
  if (group.decisions.length === 0) throw new Error(`${group.id}: decisions must not be empty`);
  if (group.expect.length === 0) throw new Error(`${group.id}: expect must not be empty`);
  for (const spec of group.decisions) {
    if (!Number.isInteger(spec.count) || spec.count < 1) {
      throw new Error(`${group.id}: decision count must be a positive integer`);
    }
    if (!group.availableOptions.includes(spec.selected)) {
      throw new Error(`${group.id}: selected "${spec.selected}" is not in availableOptions`);
    }
  }
  return group;
}

/**
 * Expand a declared group into individual decision records.
 *
 * Context assignment is round-robin over `contexts` by the record's ordinal position in
 * the group, so a group of N decisions over C contexts covers all C exactly when N >= C.
 * A spec that pins `contextKey` overrides the round-robin but still consumes an ordinal,
 * which keeps identifiers stable when fixtures are edited above it.
 */
export function expandGroup(group: FixtureGroup): readonly DecisionRecord[] {
  const records: DecisionRecord[] = [];
  let ordinal = 0;

  for (const spec of group.decisions) {
    for (let i = 0; i < spec.count; i += 1) {
      const seed = `${group.id}:${ordinal}`;
      const rotated = group.contexts[ordinal % group.contexts.length];
      if (rotated === undefined) throw new Error(`${group.id}: empty context rotation`);

      records.push({
        decisionId: `dec_${hash(seed)}`,
        runId: `run_${hash(`run:${seed}`)}`,
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

/** FNV-1a. Deterministic by construction — no clock, no RNG, stable across runs. */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
