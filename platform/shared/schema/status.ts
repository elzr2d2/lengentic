import { z } from 'zod';

export const TERMINAL_STATUSES = Object.freeze(['COMPLETED', 'FAILED'] as const);
export const RUN_STATUSES = Object.freeze(['RUNNING', 'COMPLETED', 'FAILED'] as const);

export const TerminalStatusSchema = z.enum(TERMINAL_STATUSES);
export const RunStatusSchema = z.enum(RUN_STATUSES);

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type StepStatus = RunStatus;
