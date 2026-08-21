/**
 * Node ownership leases.
 *
 * One rule: **a node has at most one live owner.** Everything else here exists to keep that
 * true across a crash, which is where the naive version fails — a worker that dies holding a
 * lock never releases it, and a supervisor that ignores locks to make progress double-owns
 * the node instead.
 *
 * The lock is one file per node, created with `wx`: the filesystem, not this code, decides
 * who wins a race. A lease carries the holder's pid and an expiry. It is stolen only when
 * BOTH are conclusive — expired AND the pid is gone. An expired lease held by a live process
 * is a slow worker, not an abandoned node; stealing it is the duplicate-ownership bug the
 * lease exists to prevent.
 *
 * `CLAUDE.md` ## Dispatch: parallel is an exception a batch earns, and a lane writes only
 * inside its own paths. Leases do not replace that decision — `pnpm lanes decide` still makes
 * it. They stop two workers landing on one node when the decision said parallel.
 *
 * Deliberately not a distributed lock. Same machine, same filesystem, cooperating processes.
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_LEASE_TTL_MS = 30 * 60_000;

export interface Lease {
  node: string;
  workerId: string;
  runId: string;
  pid: number;
  host: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface LeaseHolder {
  workerId: string;
  runId: string;
  pid: number;
}

export type AcquireResult =
  { ok: true; lease: Lease; stole: Lease | null } | { ok: false; held: Lease; reason: string };

export function leaseDir(dir: string): string {
  return join(dir, 'leases');
}

/**
 * Lease keys are node ids (`p3.scaffold`) and gate keys (`5a::gate`). `:` is not a legal
 * Windows filename character and `/` is a directory separator everywhere, so anything outside
 * `[A-Za-z0-9._-]` is folded to `_`. Two keys differing only in punctuation would share a
 * file; none in this repository do, and a collision over-locks rather than under-locks, which
 * is the safe direction for a mutual-exclusion file.
 */
function leasePath(dir: string, node: string): string {
  return join(leaseDir(dir), `${node.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

export function readLease(dir: string, node: string): Lease | null {
  const path = leasePath(dir, node);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Lease;
  } catch {
    // An unreadable lease file is a held lease, not a free node. The reaper below is the
    // only thing allowed to remove it, and only once its pid is proven gone.
    return {
      node,
      workerId: 'unreadable',
      runId: 'unknown',
      pid: -1,
      host: 'unknown',
      acquiredAt: new Date(0).toISOString(),
      expiresAt: new Date(0).toISOString(),
    };
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means the process exists and belongs to someone else — alive, for our purposes.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface AcquireOptions {
  ttlMs?: number;
  now?: Date;
  isAlive?: (pid: number) => boolean;
}

/**
 * Take exclusive ownership of `node`, or report who holds it. Never blocks and never waits:
 * the supervisor's answer to a held node is to work on a different one.
 */
export function acquireLease(
  dir: string,
  node: string,
  holder: LeaseHolder,
  opts: AcquireOptions = {},
): AcquireResult {
  const now = opts.now ?? new Date();
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const isAlive = opts.isAlive ?? isProcessAlive;
  mkdirSync(leaseDir(dir), { recursive: true });

  const lease: Lease = {
    node,
    workerId: holder.workerId,
    runId: holder.runId,
    pid: holder.pid,
    host: hostname(),
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };

  const write = (stole: Lease | null): AcquireResult => {
    // `wx` — the create is the lock. Two processes reaching this line at the same instant
    // cannot both succeed, whatever the JavaScript above them believed.
    const fd = openSync(leasePath(dir, node), 'wx');
    try {
      writeFileSync(fd, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
    } finally {
      closeSync(fd);
    }
    return { ok: true, lease, stole };
  };

  try {
    return write(null);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }

  const held = readLease(dir, node);
  if (held === null) {
    // Released between the failed create and the read. One retry, then give up honestly.
    try {
      return write(null);
    } catch {
      return {
        ok: false,
        held: { ...lease, workerId: 'unknown' },
        reason: 'lease file appeared and vanished under us',
      };
    }
  }

  const expired = Date.parse(held.expiresAt) <= now.getTime();
  const alive = isAlive(held.pid);
  if (!expired) {
    return { ok: false, held, reason: `held by ${held.workerId} until ${held.expiresAt}` };
  }
  if (alive) {
    return {
      ok: false,
      held,
      reason:
        `lease expired at ${held.expiresAt} but pid ${String(held.pid)} is still running — ` +
        'a slow worker is not an abandoned node',
    };
  }

  rmSync(leasePath(dir, node), { force: true });
  try {
    return write(held);
  } catch {
    const now2 = readLease(dir, node);
    return {
      ok: false,
      held: now2 ?? held,
      reason: 'another supervisor reclaimed the lease first',
    };
  }
}

/** Release only our own lease. Releasing someone else's is the double-ownership bug. */
export function releaseLease(dir: string, node: string, workerId: string): boolean {
  const held = readLease(dir, node);
  if (held === null) return false;
  if (held.workerId !== workerId) return false;
  rmSync(leasePath(dir, node), { force: true });
  return true;
}

/** Extend our own lease. A long worker is normal; a lease that outlives it is not. */
export function renewLease(
  dir: string,
  node: string,
  workerId: string,
  opts: AcquireOptions = {},
): Lease | null {
  const held = readLease(dir, node);
  if (held === null || held.workerId !== workerId) return null;
  const now = opts.now ?? new Date();
  const renewed: Lease = {
    ...held,
    expiresAt: new Date(now.getTime() + (opts.ttlMs ?? DEFAULT_LEASE_TTL_MS)).toISOString(),
  };
  writeFileSync(leasePath(dir, node), `${JSON.stringify(renewed, null, 2)}\n`, 'utf8');
  return renewed;
}

export function listLeases(dir: string): Lease[] {
  let files: string[];
  try {
    files = readdirSync(leaseDir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    try {
      return [JSON.parse(readFileSync(join(leaseDir(dir), f), 'utf8')) as Lease];
    } catch {
      return [];
    }
  });
}

/**
 * Remove leases whose holder is provably gone. Returns the node ids reaped, so the caller
 * can record why a node became available again rather than silently re-dispatching it.
 */
export function reapExpired(dir: string, opts: AcquireOptions = {}): Lease[] {
  const now = opts.now ?? new Date();
  const isAlive = opts.isAlive ?? isProcessAlive;
  const reaped: Lease[] = [];
  for (const lease of listLeases(dir)) {
    if (Date.parse(lease.expiresAt) > now.getTime()) continue;
    if (isAlive(lease.pid)) continue;
    rmSync(leasePath(dir, lease.node), { force: true });
    reaped.push(lease);
  }
  return reaped;
}
