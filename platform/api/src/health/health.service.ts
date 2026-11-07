import { Injectable } from '@nestjs/common';
import type { CheckStatus, HealthReport } from '@lengentic/shared/read';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthReport> {
    const database: CheckStatus = (await this.prisma.isReachable()) ? 'up' : 'down';

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks: { database },
    };
  }
}
