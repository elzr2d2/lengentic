import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// One .env at the repository root, loaded explicitly. A per-package .env would let the
// API and the migration tool point at different databases without anything complaining.
loadEnv({ path: new URL('../../.env', import.meta.url), quiet: true });

/**
 * Prisma 7 moved configuration out of schema.prisma and stopped loading .env implicitly.
 * Both are explicit here on purpose — an ORM that silently picks up an environment file is
 * an ORM that can silently connect to the wrong database.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
