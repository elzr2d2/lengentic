# BACKLOG

Ideas that are valuable but not required by the current phase's Definition of Done
(`MVP_PLAN.md` §8). Nothing here may expand the active phase.

The standing post-MVP list lives in `MVP_PLAN.md` §94 and is not duplicated here. This
file records items **discovered during implementation**, with the discovery context that
makes them actionable later.

---

## Discovered during Phase 0 plan review (2026-08-14)

### Context-conditional defaults

**Source:** corrections doc §1.
The corrected group key aggregates across `contextKey`, which licenses the claim _"this
option wins across varied situations."_ A per-`contextKey` analyzer would license a
finer claim — _"in `post_refactor_large_diff`, always NO"_ — which is more actionable but
needs far more data per group and directly contradicts G2's purpose. A real v2 analyzer,
not an MVP variant of the existing one.

### Recommendation demotion on regression

**Source:** [Progressive Crystallization](https://arxiv.org/abs/2607.07052), §0 of the
corrections doc.
That system pairs promotion with a circuit-breaker that demotes a deterministic playbook
back to hybrid on execution failure or acceptance-test regression. LenGentic has an
`ACCEPTED` recommendation status and no mechanism to notice that an accepted default
stopped holding. Related to, and probably subsumed by, §94's **shadow mode**, which is the
honest version — it produces the counterfactual instead of inferring it.

### Weight counterexamples by attestation

**Source:** observed in fixture `D2`.
`D2` reports three counterexamples: one attested `SUCCESS` and two `UNKNOWN`. A dissent
whose outcome was never attested is weaker evidence than one known to have succeeded, and
the current output gives them equal visual weight. Options: sort attested-first, annotate
the count as "3 (1 attested)", or exclude `UNKNOWN` dissents from the concentration
calculation. Deliberately **not** decided in Phase 0 — it changes what the report claims,
and the fixtures should drive that decision rather than an aesthetic preference.

### Concentration output is noisy for wide minorities

**Source:** observed in fixture `D9`.
A 60/40 split across 11 contexts prints an 11-row concentration table for a group that
produced no recommendation. The rows are correct but carry no signal — a scattered
minority is a single finding ("the boundary is not context-shaped"), not eleven. Consider
collapsing to a scatter/concentration summary when no single context exceeds some share.

---

## Environment prerequisites (not backlog — blocking for Phase 1)

- **Node.js is v21.0.0 on this machine.** It is end-of-life and not LTS. `MVP_PLAN.md` §6
  locks "Node.js LTS", and pnpm refuses to run below v22.13. Phase 1 cannot start until
  Node 22 LTS or 24 LTS is installed. The Phase 0 spike runs on v21 via `npm run spike`
  and is unaffected.
- **pnpm is installed but unusable** until the Node upgrade lands. `corepack enable pnpm`
  additionally requires an elevated shell on this machine (`C:\Program Files\nodejs` is not
  user-writable).
