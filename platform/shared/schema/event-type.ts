import { z } from 'zod';

export const TELEMETRY_EVENT_TYPES = Object.freeze([
  'run.started',
  'run.completed',
  'step.started',
  'step.completed',
] as const);

export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

export const TelemetryEventTypeSchema = z.enum(TELEMETRY_EVENT_TYPES);
