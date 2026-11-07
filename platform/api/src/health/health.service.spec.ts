import { describe, expect, it } from 'vitest';
import { HealthReportSchema } from '@lengentic/shared/read';
import { HealthService } from './health.service';
import type { PrismaService } from '../prisma/prisma.service';

function serviceWithDatabase(reachable: boolean): HealthService {
  const prisma = {
    isReachable: () => Promise.resolve(reachable),
  } as unknown as PrismaService;

  return new HealthService(prisma);
}

describe('HealthService', () => {
  it('reports ok when the database is reachable', async () => {
    const report = await serviceWithDatabase(true).check();

    expect(report.status).toBe('ok');
    expect(report.checks.database).toBe('up');
  });

  it('reports degraded when the database is unreachable', async () => {
    const report = await serviceWithDatabase(false).check();

    expect(report.status).toBe('degraded');
    expect(report.checks.database).toBe('down');
  });

  it('does not throw when the database is unreachable', async () => {
    // The endpoint's job is to report the state, not to fail on it. A health check that
    // throws when its dependency is down reports 500 instead of 503, and 500 is
    // indistinguishable from the health check itself being broken.
    await expect(serviceWithDatabase(false).check()).resolves.toBeDefined();
  });

  it('reports a non-negative uptime', async () => {
    const report = await serviceWithDatabase(true).check();

    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it.each([true, false])(
    'produces a body the Dashboard can parse (database reachable: %s)',
    async (reachable) => {
      // Expected source: the wire contract in platform/shared/read/health.ts, which is what
      // the Dashboard safeParses. A body it rejects renders as "unexpected /health body".
      const report = await serviceWithDatabase(reachable).check();

      expect(HealthReportSchema.safeParse(report).success).toBe(true);
    },
  );
});
