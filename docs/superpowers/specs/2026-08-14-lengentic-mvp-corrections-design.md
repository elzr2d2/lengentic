# LenGentic MVP Plan — Corrections & Locked Decisions

**Date:** 2026-08-14
**Status:** Accepted
**Applies to:** `MVP_PLAN.md` v2

This is a **delta document**. It does not restate the MVP plan. It records defects found
in review, the corrections that resolve them, and decisions the plan left open that would
have become expensive later. Where this document and `MVP_PLAN.md` disagree, this document
wins, and `MVP_PLAN.md` should be amended to match at the start of the phase that consumes
the change.

Every item below is either a **defect** (the plan as written cannot be implemented, or
produces a wrong result) or a **decision** (the plan left a fork open that has to be
resolved before the phase that depends on it).

---

## 0. Positioning — what the research changes

Two papers published within the last two months implement the core LenGentic thesis:

| | Progressive Crystallization (2026-07-08) | TraceCompiler (2026-08-03) |
|---|---|---|
| Method | Promote agent behavior → hybrid → deterministic on evidence | Cluster noisy traces, compile to workflow graphs |
| Promotion gate | ≥10 successful runs, ≥90% same action sequence | Argument-level provenance; edges admitted only when uniquely attributable |
| Sample gate | Yes (10, then 50) | Implicit (cluster size) |
| **Context-diversity gate** | **No** | **No** |
| **Counterexample reporting** | **No** | **No** (but *refuses to compile* under-determined irreversible effects) |
| Regression handling | Circuit-breaker demotion | Not addressed |
| Counterfactual honesty | Not addressed | Partial (refusal, not disclosure) |

Three consequences for this project:

1. **G2 is the differentiator, and it is defensible.** Progressive Crystallization's
   promotion gate — "≥90% of runs produce the same action sequence" over ten runs — is
   precisely the artifact G2 exists to suppress. Ten runs of the same situation and ten
   runs of ten different situations are indistinguishable under their gate and are
   *opposite* findings. This should be stated plainly in the README, with the comparison.

2. **Counterexample reporting is unclaimed.** TraceCompiler *refuses* under uncertainty;
   LenGentic *discloses* under uncertainty. Refusal hides the judgment call from the
   engineer. Disclosure hands it to them. That is a stronger position and nobody is
   occupying it.

3. **"Progressive crystallization" is now a taken term.** Do not adopt it. Keep
   "deterministic candidate."

Non-goal, recorded for honesty: Progressive Crystallization has automated **demotion** on
regression. LenGentic has no analogue and will not grow one in the MVP. `BACKLOG.md`'s
"shadow mode" is the honest version. The README's limits section should say so.

---

## 1. DEFECT — §70 grouping key makes G2 unsatisfiable

**Severity: blocking.** Phase 5 is un-implementable as written.

§70 groups decisions by:

```
workflowName, workflowVersion, decisionType, contextKey, contextKeyVersion
```

`contextKey` is part of the group identity, so within any group `distinctContextCount` is
always exactly `1`, and G2 (`>= 5`) can never pass. No recommendation is ever emitted.

The rest of the plan contradicts this and reveals the intent: §11's P1 is "50 samples,
**12 distinct contexts**" as a single group; §79's Scenario 3 spans "≥8 distinct
contextKeys" and expects **one** `DETERMINISTIC_CANDIDATE`; §71's rationale for G2 reasons
explicitly about a group that *could* have contained varied contexts but did not.

### Correction

```
Group key:   (workflowName, workflowVersion, decisionType, contextKeyVersion)
Dimension:   contextKey  — measured within the group, not part of its identity
```

`distinctContextCount` = number of distinct `contextKey` values observed in the group.
Dominance, attested success, and coverage are computed across the whole group.

### Why the coarse grouping is the right one

The claim LenGentic is licensed to make is *"this option wins across varied situations."*
That claim requires one group spanning many situations. Per-`contextKey` grouping supports
a different and finer claim — *"in situation A, always YES"* — which is more actionable but
directly contradicts G2 and needs far more data per group. It is a legitimate v2 analyzer.
It is not the MVP. Recorded in `BACKLOG.md` as **Context-conditional defaults**.

---

## 2. DEFECT — §70 exclusion of `UNKNOWN` outcomes kills G5

**Severity: blocking.** Same shape as §1: a gate that can never fail.

§70 lists "Decisions with outcome `UNKNOWN`" under **Exclusions**, then parenthetically
says "(counted separately, reported as coverage)". These are contradictory. If `UNKNOWN`
decisions are excluded from `sampleCount`, then `outcomeCoverage` is by construction 100%
and G5 never suppresses anything.

### Correction — explicit denominators

A decision's **selection** is observed even when its **outcome** is not. Selection-based
metrics include `UNKNOWN`; outcome-based metrics do not.

```
eligible                = decisions after excluding STALE runs and null contextKey
sampleCount             = |eligible|                         # includes UNKNOWN outcomes
distinctContextCount    = |distinct contextKey in eligible|
optionDistribution      = count by selectedOption over eligible
dominancePercentage     = max(optionDistribution) / sampleCount

attested                = eligible where outcome != UNKNOWN
outcomeCoverage         = |attested| / sampleCount
attestedSuccessRate     = |attested where outcome == SUCCESS| / |attested|
```

`attestedSuccessRate` is **undefined** when `|attested| == 0`. It is not zero. G5 is
evaluated first in that case and suppresses the group; G4 reports `N/A`, never `FAIL`,
and never `0%`. A group with no attested outcomes has an unknown success rate, and
rendering that as `0.0%` would be a lie of exactly the kind §2 of the plan forbids.

---

## 3. DEFECT — fixture numbering collides across §11 and §72

`N1`–`N5` in §11 and `N1`–`N8` in §72 use the same labels for different cases. §11's `N5`
is a *positive* case (recommend, with the minority branch surfaced); §72's `N5` is the
version-boundary case. §11 tests four gates; §72 requires five. Since §13 states the
Phase 0 functions and fixtures *graduate* into Phase 5, two divergent numbering schemes
for one graduating artifact is a guaranteed source of wrong assertions.

### Correction — one namespace, split by analyzer

| Prefix | Analyzer | Introduced | Count |
|---|---|---|---|
| `D1`–`D9` | Deterministic candidate | Phase 0 | 9 |
| `R1`–`R3` | Retry / loop | Phase 5 | 3 |

Phase 0 defines **all five gates** and carries a dedicated suppressor for each, so that no
gate graduates into Phase 5 unexercised.

| ID | Shape | Expected |
|---|---|---|
| `D1` | 50 samples, 12 contexts, YES 49 / NO 1, coverage 94%, success 96% | **CANDIDATE**, 1 counterexample |
| `D2` | 40 samples, 9 contexts, SKIP 37 / RUN 3, coverage 90%, success 92% | **CANDIDATE**, 3 counterexamples |
| `D3` | 50 samples, 10 contexts, YES 47 / NO 3; all 3 NO succeeded, 4 YES failed | **CANDIDATE**, minority branch prominent |
| `D4` | 50 samples, **2 contexts**, YES 48 / NO 2 (96%) | **SUPPRESSED — G2** |
| `D5` | **12 samples**, 8 contexts, YES 12 / NO 0 (100%) | **SUPPRESSED — G1** |
| `D6` | 60 samples, 15 contexts, 96.7% dominance, **success 61%** | **SUPPRESSED — G4** |
| `D7` | 50 samples, 10 contexts, 95% dominance, **coverage 60%** | **SUPPRESSED — G5** |
| `D8` | 50 samples spanning **two workflowVersions** (26 + 24) | **splits → both SUPPRESSED — G1** |
| `D9` | 45 samples, 11 contexts, **YES 60% / NO 40%**, success 93% | **SUPPRESSED — G3** |

`D8` is deliberately sized so the *combined* 50 would clear G1 and each split half (26, 24)
does not. That is the only construction that actually demonstrates version splitting
changed the answer.

`D9` is the honest negative: a decision that genuinely requires judgment. Without it, G3
never suppresses anything in the fixture suite and graduates unproven.

### Sub-defect — `D8` has no suppressing gate

Splitting by `workflowVersion` is **grouping, not gating**. §13's "every suppression names
the gate that suppressed it" has no answer for `D8` as originally specified. The corrected
expectation is explicit: *split into two groups, each suppressed by G1.* Fixtures assert
the post-split group count **and** each group's suppressing gate.

### Reporting rule

A group reports **every** failing gate, not the first. "Suppressed by G2" when it also
fails G4 understates the problem, and an engineer who fixes only context diversity would
return to find it still suppressed. Verdict is `SUPPRESSED` if any gate fails; the report
lists all of them.

---

## 4. DEFECT — the retry analyzer has no defined unit of repetition

§68 specifies three conditions for classifying repetition as a retry but never defines what
a *sequence* is, and §67's fingerprint references a `sequenceKey` defined nowhere.

### Correction — sequence definition

```
Alphabet
  stepToken(step) = sha1(step.type + "|" + step.name + "|" + step.agentName)
  Steps are ordered by client startedAt, siblings only, within one parentStepId scope.

Candidate
  A contiguous n-gram over sibling step tokens, 2 <= n <= maxSequenceLength (default 6).

Repetition
  A tandem repeat: the same n-gram occurring k times back-to-back with no
  intervening non-matching sibling token. k >= repetitionThreshold (default 3).

sequenceKey
  sha1(join(stepTokens of the n-gram, ">"))
  Stable across runs. Used in the Recommendation fingerprint.

Retry classification — all three must hold (per §68)
  C1  k >= repetitionThreshold
  C2  every repetition terminates in FAILED status or records an Error
  C3  input similarity: for each repetition, the multiset of
      { toolCall.toolName, sha1(canonicalJson(redacted toolCall.input)) }
      is identical across repetitions.
      No tool calls in the window => C3 is UNSATISFIED, not vacuously true.

Otherwise classify ITERATION and emit nothing.
```

C3's null case matters: a sequence with no tool calls has no observable input, so
"inputs are unchanged" is unverifiable, not proven. Treating absence of evidence as
evidence would manufacture exactly the false positive §64 warns about. Longest n-gram wins
when candidates overlap, so an `A B A B A B` run reports one 3× repeat of `A B` rather than
also reporting `B A` twice.

This is tandem-repeat detection over an event log — the established shape in process
mining. Recorded so Phase 5 does not reinvent it under time pressure.

---

## 5. DECISION — background job execution (§66)

§66 requires analysis to run as a background job, never inline with ingestion. §6's locked
stack contains no job runner and `docker-compose.yml` runs only Postgres.

**Decision: Postgres job table with an in-process worker.** No Redis, no BullMQ, no
pg-boss, no new container, no new locked-stack entry.

```
analysis_job
  id            uuid pk
  jobType       ANALYZE_RUN | ANALYZE_WORKFLOW
  payload       jsonb
  status        PENDING | RUNNING | SUCCEEDED | FAILED
  attempts      int
  runAfter      timestamptz     -- backoff
  lockedAt      timestamptz
  lastError     text
```

Claim with `SELECT ... FOR UPDATE SKIP LOCKED LIMIT n`. Worker is a NestJS provider on an
interval, disabled by env flag in test. Retries with exponential backoff to a bounded
attempt count, then `FAILED` with `lastError` retained.

Rationale: honors "no paid external service" and "the simplest solution satisfying the
current Definition of Done." MVP volume is one job per terminal run. `SKIP LOCKED` is the
standard Postgres queue primitive and survives multiple API replicas without additional
coordination. If throughput ever demands it, swapping in a real broker is a contained
change behind the job-enqueue interface.

**Enqueue is transactional with the ingestion write that triggers it.** A run reaching a
terminal state and its analysis job must commit together, or a crash between them loses the
analysis silently.

---

## 6. DEFECT — recommendation lifecycle has no write path

§67 defines `status` (`OPEN | ACKNOWLEDGED | ACCEPTED | DISMISSED`) and `statusChangedAt`,
and §75's DoD requires "a dismissed recommendation stays dismissed." §74's task list
contains only *display* tasks. Nothing can change a status.

### Correction — add to Phase 5 scope

```
PATCH /v1/recommendations/:id/status   { status, note? }
  Validates the transition, stamps statusChangedAt, appends to an audit trail.

Legal transitions
  OPEN          -> ACKNOWLEDGED | ACCEPTED | DISMISSED
  ACKNOWLEDGED  -> ACCEPTED | DISMISSED
  ACCEPTED      -> DISMISSED
  DISMISSED     -> OPEN            only via re-analysis with materially changed evidence
```

"Materially changed evidence" is deliberately narrow and configurable: `sampleCount` grew
by more than `resurfaceSampleDelta` (default 50%), **or** the dominant option changed.
A drifting success rate alone does not resurface a dismissed recommendation. Without a
concrete rule, "unless evidence materially changes" becomes "always," and the dashboard is
noise within a day — the exact failure §67 introduces the lifecycle to prevent.

Dashboard gets the corresponding control. Counterexamples render expanded by default, per
§74.

---

## 7. DEFECT — outcome attestation cannot cross a process boundary

§60 exposes `decision.attestOutcome("SUCCESS")` on an in-memory handle, while §55 states
outcomes are usually known later — sometimes after the emitting process has exited.

### Correction

`recordDecision` returns a handle exposing its client-generated `decisionId`.
Attestation is an independent, idempotent telemetry event keyed on that id, postable by any
process:

```ts
const decision = step.recordDecision({ ... });
decision.id; // client-generated, stable, safe to persist

// same process, later
decision.attestOutcome("SUCCESS");

// different process, hours later — same wire event
telemetry.attestOutcome(decisionId, "SUCCESS", { observedAt });
```

Re-attesting the same `decisionId` overwrites `outcome`, `outcomeAttestedBy`, and
`outcomeObservedAt`. Last write wins, consistent with §41's late-arrival tolerance. An
attestation for an unknown `decisionId` is accepted and stored, not rejected — decisions
and attestations may arrive out of order like any other event pair.

---

## 8. ADDITION — `minorityContextConcentration`

Once §1's correction lands, a group spans many `contextKey`s, which makes a new and cheap
question answerable: *is the minority scattered, or concentrated?*

```
3 counterexamples, all in post_refactor_large_diff
```

names the escape-hatch condition directly. Compare:

```
3 counterexamples across 3 different contexts
```

which says the boundary is not context-shaped and the branch is doing something the
`contextKey` does not capture — a materially different, and more cautionary, finding.

Implementation is a group-by over the minority rows. It is a handful of lines and it
converts the counterexample block from a list into a recommendation about *where the
escape hatch goes*. Added to the aggregation output and the §73 report shape.

This is the one addition in this document. It is in scope because it is a direct
consequence of the §1 defect fix, not a new capability.

---

## 9. DECISION — `check:isolation` scope (§17)

As specified — three temp-checkout cycles of `install && build && test` — this roughly
triples CI wall-clock, and the first arm breaks immediately: deleting `playground/` leaves
root scripts (`pnpm playground:happy-path`) referencing a missing workspace, so
`pnpm install` fails for a reason unrelated to what the check is proving.

### Correction

```
Arm 1  platform without playground   FULL build + test in temp checkout   CI only
Arm 2  platform without .claude/     STATIC check                          every run
```

Arm 1 is the claim with real content and keeps its full cycle. It must strip
playground-referencing root scripts as part of the isolation script, so the check tests
*imports*, not *script bookkeeping*.

Arm 2 is nearly free and already fully covered by `dependency-cruiser`: nothing in
`platform/**` or `playground/**` may import `.claude/**`. A full rebuild to prove that adds
minutes and no information. The "delete both" arm is dropped — it proves nothing Arm 1 and
the dependency-cruiser rules do not already prove jointly.

`check:boundaries` stays exactly as §17 specifies and runs on every gate invocation.

---

## 10. DECISION — one wire contract, three type sources

§6 locks Zod for shared runtime schemas and Prisma for the database. Without a stated rule,
the SDK, the API, and the database drift into three incompatible notions of a `Decision`.

```
platform/shared/schema/**    Zod. The ONLY wire contract.
                             Imported by telemetry-sdk AND api. Types derived via z.infer.

Prisma types                 Database-internal. Never cross a module boundary.

Mapping                      Explicit mappers at the persistence edge.
                             No Prisma model is ever returned from a controller.
```

`platform/telemetry-sdk` may import `platform/shared` and nothing else from the platform.
`dependency-cruiser` enforces it, alongside the §17 rules.

Rationale: the SDK is the public artifact. If it transitively pulls in Prisma, every
consumer installs a database client to emit telemetry.

---

## 11. DECISION — test database strategy (§34)

**Testcontainers**, pinned image (`postgres:17.x`, exact tag, no `latest`).

```
Unit          Vitest, pure functions, no container. The analysis engine lives here.
Integration   One container per test file. `prisma migrate deploy` on boot,
              truncate between tests. Supertest against a real Nest app.
E2E           One container for the suite.
```

The analysis engine is deliberately pure and fixture-driven, so the bulk of the
correctness-critical logic needs no container at all and runs in milliseconds. That is the
main reason Phase 0's pure-function discipline is worth preserving through graduation.

---

## 12. Minor items — recorded, not blocking

- **`Run.traceId`** is always equal to the PK. §38 justifies it as reserved for future
  fan-out. Keep it, with the justification as a schema comment; a reviewer will otherwise
  flag it as redundant every time.
- **Scenario 3 (§79)** needs ≥30 runs across ≥8 contexts. One process emitting 30 runs with
  a single `shutdown()` drain, not 30 process spawns — otherwise the scenario is dominated
  by Node startup and flush intervals.
- **`outcomeAttestedBy`** stays `CALLER | UNKNOWN`. Two values are correct for the MVP;
  an `INFERRED` value has no producer and would be speculative schema.
- **`pnpm spike`** requires a root `package.json` and a TypeScript runner. §10's "no
  infrastructure" prohibits database, HTTP, NestJS, UI, and agents — not a package manifest.
  `tsx` + `typescript` only.

---

## 13. Unchanged and explicitly endorsed

Recorded so these are not relitigated during implementation:

- Phase 0 as a disposable, time-boxed, kill-cheap thesis gate — the strongest decision in
  the plan, and stronger than the review knew before seeing the prior art's gates.
- The epistemic position in §2 and the `Note` block in §73. Non-negotiable, not boilerplate.
- Caller-owned `contextKey` with `contextKeyVersion` and retained `rawContext` (§54).
  The alternative — platform-inferred normalization — is what TraceCompiler does with an
  LLM, and it is the hardest part of that system.
- Client-generated UUIDv7 identifiers and idempotent batch ingestion (§38, §41).
- Async, bounded, never-throwing, flushable SDK transport (§42).
- Payload size caps and the client-side redaction hook (§58).
- Deterministic tooling over LLM agents for mechanical verification (§17, §29).
- The seven-phase structure and the scope-management rule (§7, §8).

---

## 14. Phase deltas summary

| Phase | Change |
|---|---|
| 0 | 9 fixtures `D1`–`D9`; all five gates defined; §1 and §2 corrections implemented here first |
| 1 | `check:isolation` reduced to two arms (§9); §10 dependency-cruiser rule for `telemetry-sdk`; Testcontainers (§11). Engineering harness built in full per §18–35 before Phase 2 |
| 2 | No change |
| 3 | No change |
| 4 | `decisionId` exposed by SDK; standalone attestation event (§7) |
| 5 | Corrected group key (§1); corrected denominators (§2); `R1`–`R3` retry fixtures; sequence definition (§4); job table + worker (§5); status write path (§6); `minorityContextConcentration` (§8) |
| 6 | Scenario 3 runs in one process (§12) |
| 7 | README leads with G2 and the prior-art comparison (§0); limits section names the absent demotion mechanism |
