import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaClient } from '@lengentic/database';
import { HEALTH_PROBE_TIMEOUT_MILLIS, PrismaService } from './prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

/**
 * Boot-time database verification.
 *
 * The seams under test are `onModuleInit()`'s three observable commitments, and nothing
 * else: the order of the calls it makes, that a failed verification propagates, and that
 * the success log is absent when verification failed. The client itself is faked — the
 * question here is what the service does with the answers, not whether the driver answers.
 * That the driver's `$queryRaw` really does reject where `$connect()` does not is a claim
 * about the adapter, and it is proven against the real one in
 * `test/prisma-boot.integration.spec.ts`.
 *
 * This file exists because `BACKLOG.md` records a defect that was invisible to the whole
 * suite: `onModuleInit()` logged `Database connection established` after a `$connect()`
 * that verifies nothing. A seeded defect hid behind that gap during the DoD #9 run.
 */

vi.mock('@lengentic/database', () => ({
  createPrismaClient: vi.fn(),
}));

const SUCCESS_MESSAGE = 'Database connection established';

/** The order `onModuleInit()` promises, taken from its own contract, not from a run. */
const EXPECTED_ORDER = ['$connect', '$queryRaw', SUCCESS_MESSAGE];

interface Harness {
  readonly service: PrismaService;
  readonly calls: string[];
  readonly queryRaw: ReturnType<typeof vi.fn>;
}

function harness(queryRawBehaviour: () => Promise<unknown>): Harness {
  const calls: string[] = [];

  const queryRaw = vi.fn(() => {
    calls.push('$queryRaw');
    return queryRawBehaviour();
  });

  const client = {
    $connect: vi.fn(() => {
      calls.push('$connect');
      return Promise.resolve();
    }),
    $queryRaw: queryRaw,
    $disconnect: vi.fn(() => Promise.resolve()),
  };

  vi.mocked(createPrismaClient).mockReturnValue(client as never);

  vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
    calls.push(String(message));
  });

  const config = {
    get: () => 'postgresql://user:pass@127.0.0.1:5432/lengentic',
  } as unknown as ConfigService<Env, true>;

  return { service: new PrismaService(config), calls, queryRaw };
}

describe('PrismaService.onModuleInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('propagates the failure when the verification query rejects', async () => {
    // Negative case first. This is the whole point of the method: a database that does not
    // answer must stop the boot, because docker-compose.yml's restart-loop design has no
    // other signal to act on.
    const unreachable = new Error('ECONNREFUSED 127.0.0.1:5432');
    const { service } = harness(() => Promise.reject(unreachable));

    await expect(service.onModuleInit()).rejects.toThrow(unreachable);
  });

  it('does not log success when the verification query rejects', async () => {
    const { service, calls } = harness(() => Promise.reject(new Error('ECONNREFUSED')));

    await expect(service.onModuleInit()).rejects.toThrow();

    expect(calls).not.toContain(SUCCESS_MESSAGE);
  });

  it('logs success when the verification query resolves', async () => {
    // Paired with the assertion above on purpose. Absence of a log is satisfied by a service
    // that never logs at all, so the negative case proves nothing without this one.
    const { service, calls } = harness(() => Promise.resolve([{ '?column?': 1 }]));

    await service.onModuleInit();

    expect(calls).toContain(SUCCESS_MESSAGE);
  });

  it('connects, then verifies with a query, then reports success — in that order', async () => {
    const { service, calls } = harness(() => Promise.resolve([{ '?column?': 1 }]));

    await service.onModuleInit();

    expect(calls).toEqual(EXPECTED_ORDER);
  });

  it('verifies with a real round trip, not with $connect alone', async () => {
    // `$connect()` resolving is not evidence of reachability under @prisma/adapter-pg. If
    // this assertion ever fails, the service has gone back to trusting it.
    const { service, queryRaw } = harness(() => Promise.resolve([{ '?column?': 1 }]));

    await service.onModuleInit();

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('PrismaService.isReachable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('answers false, not never, when the database stops answering (ASYNC-4)', async () => {
    // A paused Postgres: the query on a pooled connection neither resolves nor rejects.
    // Without a deadline /health hangs until the caller gives up and the Dashboard reports
    // "API unreachable" — the misdiagnosis the 503 contract exists to prevent.
    vi.useFakeTimers();
    const { service } = harness(() => new Promise<never>(() => undefined));

    const probe = service.isReachable();
    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MILLIS);

    await expect(probe).resolves.toBe(false);
  });

  it('is still waiting just before the deadline', async () => {
    // Paired with the case above: a probe that answered false immediately would pass it too.
    vi.useFakeTimers();
    const { service } = harness(() => new Promise<never>(() => undefined));
    let settled = false;

    void service.isReachable().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MILLIS - 1);

    expect(settled).toBe(false);
  });

  it('answers true when the round trip completes', async () => {
    const { service } = harness(() => Promise.resolve([{ '?column?': 1 }]));

    await expect(service.isReachable()).resolves.toBe(true);
  });
});
