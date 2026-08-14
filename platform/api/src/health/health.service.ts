import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type CheckStatus = 'up' | 'down';

export interface HealthReport {
  readonly status: 'ok' | 'degraded';
  readonly uptimeSeconds: number;
  readonly checks: {
    readonly database: CheckStatus;
  };
}

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
