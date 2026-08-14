import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Global request validation (MVP_PLAN.md §32) built on Zod rather than class-validator.
 *
 * §6 locks Zod as the shared runtime schema language, and corrections doc §10 makes
 * `platform/shared/schema/**` the single wire contract that the SDK and the API both
 * import. A second validation system here would mean the SDK and the API could disagree
 * about what a valid event is — which is exactly the class of bug idempotent ingestion
 * cannot recover from.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new BadRequestException({
      message: 'Request validation failed',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    });
  }
}

/**
 * Convenience factory so controllers read as `@Body(zodBody(EventBatchSchema))` rather
 * than `new ZodValidationPipe(...)` at every call site.
 */
export function zodBody<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
