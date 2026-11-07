import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@lengentic/database';

/**
 * The connect timeout in `createPrismaClient`, against the real driver adapter.
 *
 * Seam: a TCP socket. The "database" here accepts connections and never says a word — what a
 * black-holed or paused Postgres looks like from the client. `pg` defaults to no connect
 * timeout, so before `connectionTimeoutMillis` was passed through, the query below waited
 * forever (ENGINEERING_STANDARDS ASYNC-4) and this test hit vitest's own timeout instead.
 *
 * No Docker, no Postgres: the property under test is the client's, not the server's.
 */

const CONNECT_TIMEOUT_MILLIS = 300;

let server: Server | undefined;
let client: PrismaClient | undefined;
const sockets: Socket[] = [];

async function silentServer(): Promise<number> {
  server = createServer((socket) => {
    sockets.push(socket); // accept, then never answer the startup message
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  return address.port;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await client?.$disconnect().catch(() => undefined);
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  client = undefined;
});

describe('createPrismaClient against a database that never answers', () => {
  it('rejects the query within the connect timeout instead of hanging', async () => {
    const port = await silentServer();
    client = createPrismaClient({
      connectionString: `postgresql://user:pass@127.0.0.1:${port}/lengentic`,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MILLIS,
    });
    const started = Date.now();

    await expect(client.$queryRaw`SELECT 1`).rejects.toThrow();

    // Upper bound well under vitest's 5 s default; lower bound proves the timer, not some
    // unrelated immediate failure, is what ended the wait.
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_MILLIS - 50);
    expect(elapsed).toBeLessThan(3_000);
  });
});
