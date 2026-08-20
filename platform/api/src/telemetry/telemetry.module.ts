import { Module } from '@nestjs/common';
import { TelemetryEventsController } from './telemetry.controller';
import { TelemetryRepository } from './telemetry.repository';
import { TelemetryService } from './telemetry.service';

@Module({
  controllers: [TelemetryEventsController],
  providers: [TelemetryService, TelemetryRepository],
})
export class TelemetryModule {}
