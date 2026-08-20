/**
 * The in-memory buffer §16 requires to be bounded: "Maximum buffer size. On overflow, drop
 * oldest and increment a dropped counter. Never grow without limit."
 *
 * Drop-oldest, not drop-newest: telemetry loses value with age, and a process that is
 * overflowing is one whose most recent events describe the problem.
 */
export class BoundedQueue<T> {
  private readonly items: T[] = [];

  private droppedCount = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `BoundedQueue capacity must be a positive integer, received ${capacity}`,
      );
    }
  }

  get size(): number {
    return this.items.length;
  }

  /** Total items dropped to overflow over this queue's lifetime. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Appends `item`, returning how many oldest items were dropped to make room. */
  push(item: T): number {
    this.items.push(item);
    let dropped = 0;
    while (this.items.length > this.capacity) {
      this.items.shift();
      dropped += 1;
    }
    this.droppedCount += dropped;
    return dropped;
  }

  /** Removes and returns up to `count` items, oldest first. */
  take(count: number): T[] {
    return this.items.splice(0, count);
  }
}
