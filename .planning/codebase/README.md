# LenGentic context knowledge base

Reviewed: 2026-10-29. This is a derived orientation snapshot, not a replacement specification or a phase completion record. Revalidate status before execution. `MVP_PLAN_V3.md` wins on conflicts, even though the existing `pnpm kb` path classifier labels these Markdown files authoritative.

## Project overview

LenGentic is an agent observability and decision intelligence platform: Observe → Store → Analyze → Recommend. Applications emit telemetry through a public SDK; the API persists it, the pure analysis engine evaluates historical patterns, and the dashboard displays runs, decisions, recommendations, and suppressed groups.

Its differentiator is restraint: G1–G5 can suppress a deterministic-default hypothesis, and recommendations include counterexamples. Outcomes are caller attestations; the platform observes selected options, never counterfactual outcomes. Use “attested success rate.” Execution-strategy awareness instruments caller decisions; historical optimization of sequential versus parallel execution is not an MVP recommendation capability.

## Read by question

| Question                                              | Start here                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| What exists, what remains, and where is the evidence? | [Roadmap alignment](ROADMAP.md)                            |
| What technologies and dependencies run it?            | [Stack](STACK.md), [integrations](INTEGRATIONS.md)         |
| How does data move and where should a change go?      | [Architecture](ARCHITECTURE.md), [structure](STRUCTURE.md) |
| How should changes be implemented and checked?        | [Conventions](CONVENTIONS.md), [testing](TESTING.md)       |
| What could mislead the next contributor?              | [Concerns](CONCERNS.md)                                    |
| What do domain terms mean?                            | [Existing vocabulary](../../CONTEXT.md)                    |

## Source authority and retrieval

- [Executable roadmap](../../MVP_PLAN_V3.md): product contracts and phase Definitions of Done. Phase numbers identify scope; execution order is `0 → 1 → 5a → 2 → 3 → 4 → 5b → 6 → 7`.
- [Project rules](../../CLAUDE.md), [engineering standards](../../docs/ENGINEERING_STANDARDS.md), and [decisions](../../docs/decisions/README.md): working constraints and settled decisions. Keep their rules in their owning sources.
- [Delivery graph](../../scripts/oracle/graph.json): bounded packets, dependencies, ownership, and shallow probes. `DONE` here is a presence signal, not a fresh correctness result.
- `.artifacts/gates/` and `.artifacts/evidence/`: local recorded validation, usually ignored by Git. They may be missing on another checkout.
- [Backlog](../../BACKLOG.md): deferred ideas, not commitments. `MVP_PLAN.md`, `docs/archive/`, and `docs/superpowers/` are historical.

The existing knowledge tool automatically indexes Markdown; no extra service or index is needed:

```sh
pnpm kb search roadmap alignment
pnpm kb show "Roadmap alignment"
pnpm kb show §19
pnpm kb show phase 7
pnpm kb term contextKey
pnpm oracle status
pnpm flow next
pnpm oracle packet p7.e2e
```

Read this index and ROADMAP first; retrieve only the relevant contract and map next. Use `rg` for implementation symbols. Retrieval rank does not settle authority.

## Refresh procedure

1. Run `pnpm oracle status`, `pnpm oracle matrix`, and `pnpm flow next`; record the date and distinguish probes from executed validations.
2. Compare affected roadmap acceptance criteria with implementation, tests, and local gate evidence. Inspect evidence contents, not just filenames.
3. Update only affected map documents and the roadmap alignment. Preserve historical limitations and unresolved gaps until verified.
4. Check Markdown formatting, local links, and `pnpm kb` retrieval. Run product gates only when making product changes or claiming product correctness.

This review made documentation changes only. It did not rerun Docker, browser E2E, regression, or full product gates.
