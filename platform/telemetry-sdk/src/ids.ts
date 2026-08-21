import { mulberry32 } from './prng';

/**
 * §17's IdGenerator: the injected seam for every id the SDK produces — run, step, and
 * event ids alike. `systemIdGenerator` is the runtime default (UUIDv7, time-ordered).
 * `SeededIdGenerator` is the seeded implementation §17 requires for Phase 3/6 scenarios.
 *
 * `docs/decisions/0005-phase-2-wire-contract-gaps.md` depends on the seeded generator
 * producing **identical ids by design**: replaying the same seed must reproduce the same
 * sequence of ids across separate scenario runs, or a duplicate-event test is exercising
 * randomness instead of the dedup path it means to prove.
 */
export interface IdGenerator {
  next(): string;
}

export const systemIdGenerator: IdGenerator = {
  next: () => uuidv7(),
};

/**
 * UUIDv7: a 48-bit big-endian millisecond timestamp, the version nibble, then random bits.
 *
 * Time-ordered **to the millisecond**, and no finer. There is no intra-millisecond counter:
 * bytes 6-15 are `crypto.getRandomValues` after the version and variant bits, so two ids
 * minted inside the same millisecond sort by their random tails, not by which was created
 * first. The SDK batches, so same-millisecond ids are the normal case rather than the edge.
 * Nothing depends on the stronger reading today — `merge-rules.ts` needs a deterministic
 * total order for the `occurredAt` tie-break, which a random tail supplies — but anything
 * that comes to need true creation order has to add the counter, not assume it.
 */
function uuidv7(): string {
  const ms = BigInt(Date.now());
  const bytes = new Uint8Array(16);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);

  const random = crypto.getRandomValues(new Uint8Array(10));
  bytes[6] = 0x70 | (random[0]! & 0x0f); // version 7
  bytes[7] = random[1]!;
  bytes[8] = 0x80 | (random[2]! & 0x3f); // variant 10
  bytes.set(random.subarray(3), 9);

  return toUuidString(bytes);
}

function toUuidString(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * §17's seeded IdGenerator. Two instances constructed with the same `seed` produce the
 * identical sequence of ids when `.next()` is called the same number of times, which is
 * what makes replaying a mock scenario byte-identical. The version nibble is fixed to `f`
 * — a value real UUIDv7 never produces — so a consumer that looks CAN tell a seeded id from
 * a runtime one. Nothing looks today: `platform/shared/schema/primitives.ts`'s `IdSchema` is
 * a bounded non-empty string with no UUID shape check, so the ingestion path accepts `f` and
 * `7` identically. The nibble is a convention with no enforcement point, not a guarantee.
 */
export class SeededIdGenerator implements IdGenerator {
  private readonly random: () => number;

  constructor(seed: number) {
    this.random = mulberry32(seed);
  }

  next(): string {
    const bytes = new Uint8Array(16);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(this.random() * 256);
    }
    bytes[6] = 0xf0 | (bytes[6]! & 0x0f);
    bytes[8] = 0x80 | (bytes[8]! & 0x3f);
    return toUuidString(bytes);
  }
}
