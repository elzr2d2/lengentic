import { Module } from '@nestjs/common';
import { CLOCK, SystemClock } from '../common/clock';
import { RunsController } from './runs.controller';
import { RunsRepository } from './runs.repository';
import { RunsService } from './runs.service';
import { staleThresholdProvider } from './stale-threshold.provider';

@Module({
  controllers: [RunsController],
  providers: [
    RunsService,
    RunsRepository,
    staleThresholdProvider,
    { provide: CLOCK, useClass: SystemClock },
  ],
})
export class RunsModule {}
