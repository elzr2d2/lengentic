import { z } from 'zod';

export const TERMINAL_STATUSES = Object.freeze(['COMPLETED', 'FAILED'] as const);

// RUN_STATUSES is the STORED enum only — what a Run/Step row actually persists. It stays
// exactly this (no STALE member) by design: ADR 0005 decision 4 requires STALE to be
// derived at read time from lastEventAt and STALE_RUN_THRESHOLD_MS, computed server-side,
// and never written to the row ("Stored `status` stays `RUNNING` forever"). A compliant
// runs-API response widens into a separate read-side vocabulary in
// `platform/shared/read/**` (deliberately not `schema/**`, so "schema/** is the ingestion
// wire contract" stays true) — that is `p2.runs-api`'s deliverable, not this file's.
// See docs/decisions/0005-phase-2-wire-contract-gaps.md decision 4 and
// .artifacts/evidence/2/wire-contract-recovery.md SC1.
export const RUN_STATUSES = Object.freeze(['RUNNING', 'COMPLETED', 'FAILED'] as const);

export const TerminalStatusSchema = z.enum(TERMINAL_STATUSES);
export const RunStatusSchema = z.enum(RUN_STATUSES);

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

// Same stored/derived split as RunStatus above: this is the STORED Step status, never
// STALE. §13's Step model lists `status` without enumerating it; it inherits RUN_STATUSES
// because a Step has no independent liveness concept of its own — a Step's aliveness
// question is really "is its Run stale", derived the same way, at read time, in
// `platform/shared/read/**`.
export type StepStatus = RunStatus;
