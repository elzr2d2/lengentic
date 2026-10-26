import { createHash } from 'node:crypto';

import type { RecommendationGroupKey, RepeatedFailedActionKey } from '@lengentic/shared';

/**
 * The recommendation fingerprint — §21's dedupe key.
 *
 * ## What it is computed over, and why that is a decision and not a reading
 *
 * §21 lists `fingerprint` as a persisted field and states exactly one constraint about it,
 * and that constraint is negative: "a new `workflowVersion`, `contextKeyVersion`, or
 * `analyzerVersion` produces a NEW fingerprint, and therefore a new recommendation". No
 * positive input set appears anywhere in `MVP_PLAN_V3.md`, and
 * `.artifacts/framing/phase-5b-recon.md` D2 records that `pnpm decide` returns NOVEL for it.
 *
 * The input set below is therefore an ASSUMPTION, taken under `CLAUDE.md` ## Plan
 * discipline (unclear and below an escalation trigger: decide from the rules, document the
 * assumption, prefer the reversible option) and recorded here because there is nowhere
 * closer to the code to record it:
 *
 *     analyzerId, analyzerVersion, and §18's four-member GroupKey
 *     (workflowName, workflowVersion, decisionType, contextKeyVersion)
 *
 * Three properties make it the reading the plan's own text forces rather than one of
 * several:
 *
 * 1. It satisfies §21's stated constraint exactly — `workflowVersion`,
 *    `contextKeyVersion` and `analyzerVersion` are all inputs, so a change in any of the
 *    three yields a new fingerprint.
 * 2. It is *identity*, not evidence. §21's other rule is that re-analysis with the same
 *    fingerprint UPDATES evidence and `lastSeenAt`. Any evidence-derived input
 *    (`sampleCount`, the distribution, the gate results) would change on essentially every
 *    re-analysis, which turns that update rule into an insert rule and fills the dashboard
 *    with duplicates — the exact outcome §21 says not to build ("do not implement
 *    'resurface when evidence materially changes' until 'materially' has a tested
 *    definition").
 * 3. It is exactly "one recommendation per analyzed group", which is what §20.1 emits:
 *    "at most one recommendation per group".
 *
 * `contextKey` is deliberately NOT an input — it is a dimension measured *within* a group
 * (§18), and including it would produce one recommendation per context and make G2
 * meaningless.
 *
 * `configSnapshot` is deliberately NOT an input either, and this is the one genuinely
 * arguable exclusion. Including it would give a threshold change its own recommendation row
 * rather than an updated one; §21 names the three inputs whose change forces a new row and
 * the thresholds are not among them, and it separately requires the snapshot to be persisted
 * precisely so a reader can see which thresholds produced the *current* evidence. A new row
 * per threshold tweak would also make "DISMISSED stays DISMISSED" trivially escapable.
 *
 * Reversing this costs one thing: existing rows keep their old fingerprints and the next
 * analysis inserts new ones beside them. That is the reversible option — no data is lost and
 * no migration is owed.
 *
 * ## The encoding
 *
 * `JSON.stringify` over a fixed-order array, hashed with SHA-256 and rendered lowercase hex
 * (`FingerprintSchema` in `platform/shared/schema/recommendation.ts` is that bound). The
 * array form is what makes the encoding injective: JSON escapes every field, so no choice of
 * separator inside a field can make two different input sets serialize identically — the
 * failure mode a `join('|')` has, and the one `fingerprint.spec.ts` pins.
 */
export interface GroupFingerprintInput {
  /**
   * Which analyzer produced this. `category` is deliberately not a second input: §20 has two
   * analyzers and each has exactly one category, so `analyzerId` already separates them and a
   * category input would be a value that can never vary independently of one already present.
   */
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly groupKey: RecommendationGroupKey;
}

/**
 * §20.2's identity: the same two analyzer fields, and §20.2's own three-member streak key in
 * place of §18's group key. Identity and not evidence, for the reason given above — a streak
 * that grows from three failures to four is the SAME recommendation with refreshed evidence,
 * so `attemptCount` and `toolCallIds` are deliberately not inputs.
 *
 * Two streaks of one key in one run (F F F S F F F) therefore share a fingerprint and one
 * row: the analysis service keeps the longer (`analysis.service.ts`), and the row's
 * `counterexamples` carry the success between them.
 */
export interface ActionFingerprintInput {
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly actionKey: RepeatedFailedActionKey;
}

export type RecommendationFingerprintInput = GroupFingerprintInput | ActionFingerprintInput;

export function recommendationFingerprint(input: RecommendationFingerprintInput): string {
  // `analyzerId` leads both encodings and differs between the two analyzers, so the two input
  // sets cannot collide even though both are JSON arrays of strings.
  const canonical = JSON.stringify(
    'actionKey' in input
      ? [
          input.analyzerId,
          input.analyzerVersion,
          input.actionKey.runId,
          input.actionKey.toolName,
          input.actionKey.inputFingerprint,
        ]
      : [
          input.analyzerId,
          input.analyzerVersion,
          input.groupKey.workflowName,
          input.groupKey.workflowVersion,
          input.groupKey.decisionType,
          input.groupKey.contextKeyVersion,
        ],
  );

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
