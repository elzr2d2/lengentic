import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient, type PrismaClient } from '@lengentic/database';
import type { Env } from '../config/env.schema';

/**
 * Owns the database connection and nothing else.
 *
 * The Prisma client is exposed to repository code inside the API, but corrections doc §10
 * forbids a Prisma type from crossing a module boundary — no Prisma model is ever returned
 * from a controller. Mapping happens at the persistence edge.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  readonly client: PrismaClient;

  constructor(config: ConfigService<Env, true>) {
    this.client = createPrismaClient({
      connectionString: config.get('DATABASE_URL', { infer: true }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /**
   * Liveness probe for the connection itself.
   *
   * Returns a boolean rather than throwing because the health endpoint's job is to report
   * the state, not to fail on it. A health check that throws when the thing it checks is
   * unhealthy has inverted its own purpose.
   */
  async isReachable(): Promise<boolean> {
    try {
      await this.client.$queryRaw`SELECT 1`;
      return true;
    } catch (error: unknown) {
      this.logger.warn({ err: error }, 'Database health check failed');
      return false;
    }
  }
}
