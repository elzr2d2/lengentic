import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

/**
 * The database package's entire public surface.
 *
 * `PrismaClient` is re-exported as a *type* only. Corrections doc §10: Prisma types are
 * database-internal and never cross a module boundary — no Prisma model is ever returned
 * from a controller. Consumers get a connection, not a schema.
 */
export type { PrismaClient };

export interface DatabaseConfig {
  readonly connectionString: string;
  /**
   * Upper bound on opening one connection (TCP + startup + auth). Defaults to
   * `DEFAULT_CONNECTION_TIMEOUT_MILLIS`; overridable so a test can prove the bound quickly.
   */
  readonly connectionTimeoutMillis?: number;
}

/**
 * ENGINEERING_STANDARDS ASYNC-4: a call that can hang carries a timeout. `pg` defaults to
 * `connect_timeout: 0` and `pg-pool` arms no connect timer unless this is set, so without it
 * a black-holed or paused Postgres makes every query — the boot verification and the
 * `/health` probe included — wait forever instead of failing.
 */
export const DEFAULT_CONNECTION_TIMEOUT_MILLIS = 5_000;

/**
 * Prisma 7 requires an explicit driver adapter. Passing the connection string here rather
 * than reading `process.env` keeps the package free of environment assumptions, which is
 * what lets integration tests point it at a Testcontainers instance.
 */
export function createPrismaClient(config: DatabaseConfig): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MILLIS,
  });
  return new PrismaClient({ adapter });
}
