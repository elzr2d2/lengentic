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
}

/**
 * Prisma 7 requires an explicit driver adapter. Passing the connection string here rather
 * than reading `process.env` keeps the package free of environment assumptions, which is
 * what lets integration tests point it at a Testcontainers instance.
 */
export function createPrismaClient(config: DatabaseConfig): PrismaClient {
  const adapter = new PrismaPg({ connectionString: config.connectionString });
  return new PrismaClient({ adapter });
}
