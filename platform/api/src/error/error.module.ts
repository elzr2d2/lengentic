import { Module } from '@nestjs/common';
import { ErrorRepository } from './error.repository';
import { ErrorService } from './error.service';

/**
 * §13's `error.recorded` capability, as one injectable seam — mirrors `DecisionsModule`.
 *
 * `ErrorService` is exported and `ErrorRepository` is not: `TelemetryModule` needs the
 * wire-level entry only. `PrismaService` arrives through the `@Global` `PrismaModule`.
 */
@Module({
  providers: [ErrorService, ErrorRepository],
  exports: [ErrorService],
})
export class ErrorModule {}
