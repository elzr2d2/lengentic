import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService, type HealthReport } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Reports 200 when every dependency is up and **503 when one is down**.
   *
   * Returning 200 with `"status": "degraded"` in the body would be a health check that no
   * orchestrator, load balancer, or `docker compose` healthcheck can act on — all of them
   * read the status code. A health endpoint that is always 200 is decoration.
   */
  @Get()
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthReport> {
    const report = await this.health.check();

    response.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return report;
  }
}
