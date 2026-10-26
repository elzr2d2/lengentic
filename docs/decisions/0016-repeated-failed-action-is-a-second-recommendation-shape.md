---
number: 0016
title: REPEATED_FAILED_ACTION is a second recommendation shape, not a variant of the first
date: 2026-10-26
status: accepted
---

# 0016 — How §20.2's recommendation sits beside §20.1's

- **Status:** accepted
- **Date:** 2026-10-26
- **Deciders:** human (Phase 6 phase-gate finding F1, option B), Builder (shape recorded)

## Context

Phase 6's phase gate found that live `POST /v1/analysis/run` over Scenario 2's data returned
no recommendation: `RECOMMENDATION_CATEGORIES` held only `DETERMINISTIC_CANDIDATE`, and
`inputFingerprint` never rode the wire. The human chose to build the platform path
(`.autopilot/escalations/2026-10-26T17-33-30-526Z.md`, option B).

§21's entity was designed around §18's group key and §19's gates. A §20.2 streak has neither:
its identity is `(runId, toolName, inputFingerprint)` and its evidence is an ordered list of
tool calls. Forcing it into the existing shape would mean filling `workflowName`,
`decisionType` and five gate results with values nothing measured.

## Decision

1. **Two wire shapes, discriminated by `category`.** `RecommendationSchema` stays the §20.1
   shape with `category` narrowed to `DETERMINISTIC_CANDIDATE`;
   `RepeatedFailedActionRecommendationSchema` carries `actionKey` and
   `{ attemptCount, toolCallIds }` and no gates. Both share the §21 lifecycle fields.
2. **One table.** `Recommendation` gains `runId`, `toolName`, `inputFingerprint` (nullable) and
   its four group-key columns become nullable. The row mappers enforce which set a category must
   carry and throw on a mismatch. A second table would have forked the UNIQUE-fingerprint dedupe,
   the status lifecycle and the PATCH route for no gain.
3. **`GET /v1/recommendations` defaults to `DETERMINISTIC_CANDIDATE`.** `?category=` opts into
   the second. A union on the default read would break every consumer that switches on the §20.1
   shape (the Dashboard), and adding a category must not be a breaking change for a reader that
   never asked for it.
4. **Fingerprint = analyzer id + version + the three-member action key.** Identity, not
   evidence, for the reason `fingerprint.ts` gives for §20.1. Two streaks of one key in one run
   (F F F S F F F) are therefore one row: the longer is kept, the earlier on a tie, and the
   separating success is a counterexample on the row.
5. **Counterexamples are same-key SUCCESS attempts.** Always present, may be empty.
6. **Withdrawal.** §20.2 has no gates and so no SUPPRESSED verdict; a persisted OPEN row whose
   fingerprint a run did not emit is deleted, and a DISMISSED row is kept untouched
   (`0015`'s tombstone rule, without the evidence refresh — there is no suppressing evidence).
7. **`inputFingerprint` is computed by the SDK over the sanitized, uncapped input** and is
   optional on the wire. A ToolCall without one is dropped from analysis rather than given a
   placeholder: unknown input is not equal input. It is omitted when the call had no input at
   all.
8. **Analyzer identity `repeated-failed-action` / `1.0.0`**, on the same recorded-assumption
   footing as `deterministic-candidate`.

## Consequences

- The Dashboard still renders only §20.1 rows; showing §20.2 rows there is a separate
  deliverable (named in this packet's handoff `follow_up_required`; `BACKLOG.md` is outside
  the packet's paths).
- `p7.e2e` keeps the through-the-SDK silence/dedup assertions; this change only supplies the
  platform half they run against.
- Stale-run exclusion (§39) is not applied to tool calls: a failure streak is an attested fact
  about calls that happened, whatever state the run later reached.
