/**
 * How many repair attempts a run gets, and who says so.
 *
 * **An attempt and a strategy are the same unit.** `autopilot` §4 defines it: "An attempt is a
 * materially different, evidence-driven strategy. Running the same command again is not an
 * attempt, and neither is the same fix applied twice." `CLAUDE.md` trigger 5 uses the same
 * words — "two materially different, evidence-driven recovery attempts". So there is one
 * countable thing here, not two, and this file does not invent a second.
 *
 * What differs between the two rules in this repository is the **bound** and its **scope**:
 *
 *   CLAUDE.md trigger 5   bound 2   standing, applies always, no expiry
 *   ADR 0011 pref. (2)    bound 3   scoped to one charter's run, and it carries an extra
 *                                   obligation: a focused escalation analysis against that
 *                                   record's critical-blocker definition before escalating
 *
 * A supervisor that silently defaulted to 3 would be running the whole roadmap under a charter
 * that was written for one run — and nothing on disk would say so. A supervisor that let
 * `--max-repairs 3` through unremarked would be the same failure with an extra keystroke. So
 * widening the bound requires naming the record that authorises it, the authority is recorded
 * in durable state, and it is quoted in the escalation when the bound is finally reached.
 *
 * Tightening needs no authority: fewer attempts before asking a human is never the unsafe
 * direction.
 */

export const STANDING_REPAIR_BOUND = 2;

export const STANDING_AUTHORITY = 'CLAUDE.md ## Plan discipline, trigger 5 (standing rule)';

export interface RepairPolicy {
  /** Materially different, evidence-driven strategies allowed before trigger 5 fires. */
  bound: number;
  /** Human-readable: which rule set this bound. Recorded in state and in the escalation. */
  authority: string;
  /** The decision record that widened the bound, when one did. */
  charter: string | null;
  /** True when `bound` differs from the standing rule — surfaced by `status`, never inferred. */
  overridden: boolean;
}

export interface RepairPolicyInput {
  /** `--max-repairs`. Absent means the standing bound. */
  bound?: number | undefined;
  /** `--charter <path>`. Required to widen, ignored when not widening. */
  charter?: string | undefined;
  /** Injected so the rule is testable without a repository. */
  exists: (path: string) => boolean;
}

export function standingPolicy(): RepairPolicy {
  return {
    bound: STANDING_REPAIR_BOUND,
    authority: STANDING_AUTHORITY,
    charter: null,
    overridden: false,
  };
}

/**
 * Resolve the bound, refusing anything that would change the semantics by accident. Returns an
 * error rather than a policy: there is no fallback that quietly widens, and a caller that
 * ignores the error gets a type mismatch rather than a permissive default.
 */
export function resolveRepairPolicy(input: RepairPolicyInput): RepairPolicy | { error: string } {
  const { bound, charter } = input;

  if (bound === undefined) {
    if (charter !== undefined) {
      return {
        error:
          '--charter was supplied without --max-repairs. A decision record authorises a ' +
          `widened bound; on its own it changes nothing. The standing bound is ${String(STANDING_REPAIR_BOUND)}.`,
      };
    }
    return standingPolicy();
  }

  if (!Number.isInteger(bound) || bound < 1) {
    return {
      error: `--max-repairs must be a whole number of attempts, at least 1; got ${String(bound)}`,
    };
  }

  if (bound < STANDING_REPAIR_BOUND) {
    // Tightening. Always allowed, and still recorded, because a run that escalated after one
    // attempt must not read later as a run that was allowed two.
    return {
      bound,
      authority: `${STANDING_AUTHORITY}, tightened to ${String(bound)} at the command line`,
      charter: charter ?? null,
      overridden: true,
    };
  }

  if (bound === STANDING_REPAIR_BOUND) return standingPolicy();

  if (charter === undefined) {
    return {
      error:
        `--max-repairs ${String(bound)} widens the standing bound of ${String(STANDING_REPAIR_BOUND)} ` +
        'and must name the decision record that authorises it: ' +
        '`--charter docs/decisions/NNNN-....md`.\n\n' +
        'CLAUDE.md ## Plan discipline, trigger 5: stop and ask when "a required gate fails and ' +
        'two materially different, evidence-driven recovery attempts have both failed". An ' +
        'attempt IS a strategy (autopilot §4) — raising the count is raising the escalation ' +
        'bar, not renaming a unit.',
    };
  }

  if (!input.exists(charter)) {
    return {
      error:
        `--charter "${charter}" does not exist. The authority for a widened repair bound has to ` +
        'be a record someone can read, not a string.',
    };
  }

  return {
    bound,
    authority: `${charter} (charter-scoped override of the standing bound of ${String(STANDING_REPAIR_BOUND)})`,
    charter,
    overridden: true,
  };
}

/** One line for `pnpm autopilot status`, the run journal, and the escalation record. */
export function describeRepairPolicy(p: RepairPolicy): string {
  return `${String(p.bound)} attempt(s) — ${p.authority}`;
}
