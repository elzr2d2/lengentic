---
number: 0015
title: A suppression withdraws the recommendation row; a DISMISSED row survives as a tombstone
date: 2026-09-04
status: accepted
---

# 0015 — What happens to the row when a CANDIDATE turns SUPPRESSED

- **Status:** accepted
- **Date:** 2026-09-04
- **Deciders:** human (Phase 5b phase-gate escalation), Builder (recorded)

## Context

The 5b Definition of Done says, at `MVP_PLAN_V3.md:2326`:

> A `SUPPRESSED` group persists **no** `Recommendation` row. Suppression is visible in the
> response and is not an entity.

`AnalysisService` satisfied the literal words with a guard —
`if (evaluation.verdict !== 'CANDIDATE') return null;` — which writes nothing. Writing
nothing is not the same statement as no row existing, and Tester measured the gap at the
phase gate (`.artifacts/evidence/5b/phase-gate/tester.md`, FINDING 1). A group analysed as a
CANDIDATE persists a row; the world then changes — 30 further NO decisions arrive in the same
§18 group through the real ingest path — and the same group is re-analysed:

```text
run_tests_after_code_change | SUPPRESSED | failedGates ["G3_dominance"] | recId null
```

while the database, read at the same instant through a second interface, held:

```text
run_tests_after_code_change|OPEN|50|0.96|PASS|2026-09-04 10:24:06.58+00
```

and `GET /v1/recommendations` served it. The rendered page carried both claims on one screen:
`SUPPRESSED / G3 dominance FAIL (60.0% >= 90.0%)` directly above `Status OPEN / G3 dominance
PASS (96.0% >= 90.0%) / Consider a deterministic default of YES`. The product refused to make
a claim and made the claim, in one response, from evidence it had already superseded —
`CLAUDE.md` `## Product claims`: "Recommendations are hypotheses with counterevidence, never
assertions."

No test in the repository covered the transition. All 17 cases in
`analysis.integration.spec.ts` suppressed a group from its FIRST analysis, where "did not
write" and "no row" are indistinguishable.

That much is a defect, and the repair is forced. What was not forced is the DISMISSED case,
because two rules point in opposite directions:

- `:2326` says a SUPPRESSED group persists no row — with no exception for a dismissed one.
- §21 and the 5b DoD line `:2316` say a DISMISSED recommendation stays dismissed across
  re-analysis. Deleting the row on suppression would make a dismissed group that is suppressed
  and later qualifies again resurrect as a fresh `OPEN` row, silently undoing a human's
  explicit act through a path nobody looks at.

## Decision

**On a `SUPPRESSED` verdict, the row for that group is deleted — unless its status is
`DISMISSED`, in which case it is kept as a tombstone with its evidence refreshed to the
suppressing run's.**

Human decision, taken at the 5b phase gate. Three parts, each with its own reason.

**1. Delete.** A row the analyzer no longer stands behind must not remain in the table
consumers read. The write is `deleteMany` scoped to the group's fingerprint, in the same
statement that exempts DISMISSED (`recommendations.repository.ts`, `withdrawOnSuppression`) —
one atomic statement rather than a find-then-branch, for the same reason `recordSighting` is
an `upsert`.

**2. Keep a DISMISSED row.** It reads against `:2326`'s letter and honours its rationale. The
rationale is that suppression must not become an entity — no suppression table, no suppression
history, nothing a consumer could read as "the platform tracks refusals". A `DISMISSED` row
asserts **no recommendation**; it records that a human saw one and declined it. Keeping it
stores a human act that already existed, not a machine refusal that did not. Nothing about
the retained row says "suppressed": there is no suppression column, no suppression status, and
the analysis response still reports the group with `recommendationId: null`, which
`EvaluatedGroupSchema`'s biconditional enforces.

**3. Refresh the tombstone's evidence rather than freeze it or hide the row.** The defect being
repaired is a row serving evidence its own gates no longer support, and a frozen tombstone is
that same defect with a different status column. The two candidate remedies were:

- _Exclude the tombstone from `GET /v1/recommendations`._ Rejected. `listRecommendations`
  returns DISMISSED rows deliberately — "hiding it would hide the evidence it was dismissed
  over" — and a reader who cannot see what they dismissed cannot revisit the judgement.
  Hiding it would also make a dismissed recommendation indistinguishable from one that was
  never found, which is the understatement §19's reporting rule forbids one level up.
- _Refresh the evidence to the suppressing run's._ Chosen. The five columns an analysis run
  already re-states on a re-sighting — `configSnapshot`, `sourceWatermark`, `evidence`,
  `counterexamples`, `lastSeenAt` — are written, and the four §21 leaves alone — `status`,
  `firstSeenAt`, `statusNote`, `statusChangedAt` — are not. The row then shows `DISMISSED`
  beside the gate that now fails, which is true, legible, and not a recommendation.

The write shape is literally the same function for both paths (`resightedColumns`), so a sixth
column added to a re-sighting cannot fail to reach a tombstone.

## Consequences

- A dismissal survives a suppression excursion. `dismissed → suppressed → candidate again`
  returns to `DISMISSED` with its note intact, and never to a fresh `OPEN`.
- One row per group at most, still. The tombstone occupies the fingerprint, so a later
  re-candidacy `upsert`s onto it rather than inserting a second row.
- **A reader who knows only `:2326` will be surprised by a DISMISSED row for a suppressed
  group.** That surprise is why this record exists. `:2326` is not amended: it governs whether
  suppression is an entity, and the answer is still no.
- An analysis run now issues a write for suppressed groups it previously skipped — one
  `deleteMany` per suppressed group, plus one `updateMany` only where a row survived it. On an
  empty table that is one no-op statement per group per run. If group counts ever make that
  visible, the fix is a single statement over all suppressed fingerprints, not a return to the
  guard.
- `DELETED` is irreversible for an OPEN row: a group that oscillates around a gate threshold
  loses `firstSeenAt` and gets a new id each time it re-qualifies. That is correct for an
  unacknowledged hypothesis — "first seen" is about a claim that stood — and it is the reason
  the DISMISSED exception exists at all, since a human act must not be lost the same way.

## Detection

- **The transition regressed.** `platform/api/test/analysis.integration.spec.ts`, "deletes the
  row a group left behind once its own evidence suppresses it" and "keeps a DISMISSED row as a
  tombstone, carrying the suppressing run evidence rather than the stale one", both against a
  real Postgres and both driving telemetry in through `POST /v1/telemetry/events`. They were
  mutation-checked by restoring the old `persistIfCandidate` guard; the reds are in
  `.artifacts/evidence/5b/phase-gate/repair-1/`.
- **The tombstone went stale again.** The same test asserts `evidence.sampleCount` is the
  suppressing run's 70 and that `G3_dominance` reads `FAIL` on the kept row. A tombstone that
  still reported 40 samples and a PASS would fail it.
- **A human act was overwritten by an analysis run.** `recommendations.repository.spec.ts`,
  "refreshes the tombstone with the same five columns a re-sighting writes, and no others" —
  the assertion is on the statement's `data` keys, so `status`, `firstSeenAt`, `statusNote`
  and `statusChangedAt` reappearing is a failure rather than a silent overwrite.
- **The exception widened.** If the `status: { not: 'DISMISSED' }` filter is ever dropped from
  the delete, "keeps a DISMISSED row as a tombstone" goes red. If it is ever broadened to
  exempt `OPEN` as well, the first test goes red. Both directions are covered, which is what
  makes this a bound rather than a preference.
