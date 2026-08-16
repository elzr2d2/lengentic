import { describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env.schema';

/**
 * One bounded check against the real driver adapter.
 *
 * The unit spec fakes the client, so it can only prove what the service does with an answer.
 * It cannot prove the claim the service is built on: that `$connect()` resolves against an
 * unreachable database while a round-trip query rejects. That claim is about
 * Prisma 7.9.1 + `@prisma/adapter-pg`, and only the real adapter can settle it.
 *
 * Deliberately narrow. No container, no Compose, no restart-loop harness — a closed port is
 * an unreachable database, and it is the cheapest honest instance of one. The positive path
 * (a real Postgres, `app.init()` succeeding) is already covered by
 * `health.integration.spec.ts`.
 *
 * `BACKLOG.md` — the defect this closes was invisible because no test ever constructed
 * PrismaService against a database that was down at boot.
 */

// Port 1 is reserved and never listening. ECONNREFUSED arrives immediately, so this test
// costs milliseconds and cannot hang the suite waiting for a TCP timeout.
const UNREACHABLE_URL = 'postgresql://lengentic:lengentic@127.0.0.1:1/lengentic';

function serviceAgainst(connectionString: string): PrismaService {
  const config = {
    get: () => connectionString,
  } as unknown as ConfigService<Env, true>;

  return new PrismaService(config);
}

describe('PrismaService boot verification (integration)', () => {
  it('rejects at boot against an unreachable database', async () => {
    const service = serviceAgainst(UNREACHABLE_URL);

    await expect(service.onModuleInit()).rejects.toThrow();

    await service.onModuleDestroy();
  });

  it('is not protected by $connect alone — $connect resolves against the same database', async () => {
    // The reason the assertion above needs a query behind it. If this ever starts failing,
    // the adapter has changed its behaviour and the round trip in onModuleInit() could be
    // reconsidered — until then, removing it silently restores the original defect.
    const service = serviceAgainst(UNREACHABLE_URL);

    await expect(service.client.$connect()).resolves.toBeUndefined();

    await service.onModuleDestroy();
  });
});
