---
number: 0003
title: The caller computes contextKey; the Platform never infers it
date: 2026-08-16
status: accepted
---

Backfilled 2026-08-16 from `MVP_PLAN_V3.md` §14 and `CONTEXT.md:37`. The contract itself
lives in the plan; this record holds the trade-off and its detection.

## Context

`MVP_PLAN_V3.md:695` — "Normalization is the hardest problem in the product":

```text
Too coarse  →  distinct decisions merge   →  fake dominance
Too fine    →  sample size never reached  →  no output
```

Something must decide when two situations are the same situation. The options were:
the Platform infers it, or the caller declares it.

## Decision

The caller declares it. `MVP_PLAN_V3.md:702`:

> **The caller owns normalization.** The instrumented system supplies `contextKey`, a
> short stable string it computes itself. The Platform groups by it and never infers it.
> The Platform does not know what makes two contexts equivalent in the caller's domain;
> the caller does. The alternative — platform-inferred normalization with an LLM — is the
> hardest part of TraceCompiler, and it is not the MVP.

Three supporting rules, all already in the contract:

- `rawContext` is stored alongside the key, so re-normalization stays possible without
  losing history.
- `contextKeyVersion` is stored, so a change in strategy **splits** groups "instead of
  silently corrupting them."
- A decision with no `contextKey` is stored and **excluded from aggregation**. Quoted:
  "Silent inclusion under a default key is how fake dominance gets manufactured."

## Consequences

**The good one.** This is what licenses the product's differentiating claim. `contextKey`
is a dimension measured _within_ a group, never part of its identity (`CONTEXT.md:91`) —
which is what lets gate G2 (`distinctContextCount >= 5`) tell "ten runs of ten different
situations" apart from "ten runs of one situation". Prior art that promotes on sample
count and consistency alone cannot distinguish those two.

**The bad one, and it is real.** Cardinality becomes the caller's obligation, and the
Platform cannot help. `MVP_PLAN_V3.md:722`:

> The Platform cannot detect this for the caller — a high-cardinality key looks exactly
> like a legitimately diverse one until the data runs out.

The mitigation is documentation, not mechanism: forbidden dimensions (run ids, task ids,
timestamps, free text, hashes) versus sound ones (coarse enumerated buckets), plus a
worked five-dimension derivation for `execution_strategy`.

**The adoption cost.** Already logged as an open problem — "`contextKey` is an onboarding
wall with no on-ramp" (`BACKLOG.md`, product-strategy session 2026-08-16). A user must
understand the concept before emitting a single useful decision.

## Detection

This decision is wrong if the on-ramp cost exceeds the analytical benefit — that is, if
real callers either skip `contextKey` (decisions stored, excluded from aggregation, product
silent) or supply a high-cardinality one (every decision in its own bucket, G1 never
reached, product silent). **Both failure modes look identical from inside the Platform:
no output.**

So the observable is the ratio, not the errors:

```text
decisions with no contextKey        -> excluded-from-aggregation count
groups that never reach G1          -> starved by key cardinality
```

Both are countable at analysis time. A high excluded rate or a population of
never-promoting groups is the signal to revisit — most likely by shipping derivation
helpers, not by moving normalization into the Platform, which §2's epistemic position
forbids for a different reason.
