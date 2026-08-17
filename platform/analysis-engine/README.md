# @lengentic/analysis-engine

Pure analysis over decision and tool-call records (MVP_PLAN_V3.md §18-20). No persistence,
no transport, no rendering — enforced by the `analysis-engine-is-pure` dependency-cruiser
rule, not by convention.

## Wave split (5a)

- **Wave 1** (this state): graduated types only — `src/types.ts`, `src/tool-call.ts`,
  `src/gate-contract.ts`, `src/config.ts`, and the public entry `src/index.ts`. Zero
  functions, zero behaviour. `src/gates.ts` deliberately does not exist yet.
- **Wave 2**: `fixtures/**` + `test/grid/**` — the expectation table, sourced from the
  Phase 5 gate expectation grid, never from `src/`.
- **Wave 3**: `src/aggregate.ts`, `src/gates.ts` (the gate _functions_, importing their
  vocabulary from `src/gate-contract.ts`), `src/candidate.ts`, `src/repeated-failed.ts`,
  `test/analyzer/**`.

Wave 1 has no behaviour on purpose: MVP_PLAN_V3's Phase 5 objective forbids the positive
path landing before wave 2's expectation table exists to hold it accountable.

`src/gate-contract.ts` holds the gate vocabulary (`GateId`, `GateStatus`, `Verdict`,
`GateResult`, `GateEvaluation`, `GATE_IDS`) permanently, and never a function — that split
makes "no gate logic in wave 1" checkable by file existence rather than by reading a diff.
