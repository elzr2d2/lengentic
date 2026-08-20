import { describe, expect, it } from 'vitest';

import { BoundedQueue } from '../src/bounded-queue';

/**
 * Seam: `BoundedQueue` — the buffer §16 requires to be bounded. Observed through `size`,
 * `dropped` and `take`, never through the backing array.
 *
 * Expected values are the literals §16 states ("On overflow, drop OLDEST and increment a
 * dropped counter. Never grow without limit."), not values read back from the queue.
 */
describe('BoundedQueue', () => {
  it('drops the OLDEST item on overflow and keeps the newest', () => {
    const queue = new BoundedQueue<string>(3);
    for (const item of ['a', 'b', 'c', 'd']) queue.push(item);

    expect(queue.size).toBe(3);
    expect(queue.take(3)).toStrictEqual(['b', 'c', 'd']);
  });

  it('counts every dropped item instead of throwing', () => {
    const queue = new BoundedQueue<number>(2);
    let dropped = 0;
    for (let i = 0; i < 10; i++) dropped += queue.push(i);

    expect(dropped).toBe(8);
    expect(queue.dropped).toBe(8);
    expect(queue.size).toBe(2);
  });

  it('never grows past its capacity however many items arrive', () => {
    const queue = new BoundedQueue<number>(5);
    for (let i = 0; i < 5000; i++) queue.push(i);

    expect(queue.size).toBe(5);
    expect(queue.take(5)).toStrictEqual([4995, 4996, 4997, 4998, 4999]);
  });

  it('takes at most the requested count, oldest first', () => {
    const queue = new BoundedQueue<number>(10);
    for (let i = 0; i < 6; i++) queue.push(i);

    expect(queue.take(4)).toStrictEqual([0, 1, 2, 3]);
    expect(queue.size).toBe(2);
    expect(queue.take(99)).toStrictEqual([4, 5]);
    expect(queue.size).toBe(0);
  });

  it('rejects a non-positive capacity at construction — a zero-capacity buffer silently loses everything', () => {
    expect(() => new BoundedQueue<number>(0)).toThrow(RangeError);
  });
});
