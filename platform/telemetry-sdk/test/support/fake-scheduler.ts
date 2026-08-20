import type { CancelTimer, ScheduleOptions, Scheduler } from '../../src/scheduler';

interface PendingTimer {
  readonly at: number;
  readonly callback: () => void;
  readonly keepProcessAlive: boolean;
}

/** Lets the event loop run every queued microtask and I/O callback before continuing. */
export const settle = (): Promise<void> =>
  new Promise<void>((done) => {
    setImmediate(done);
  });

/**
 * A Scheduler whose clock only moves when a test moves it. This is what makes the flush
 * interval, the request timeout and the retry backoff observable without a real wait
 * (ENGINEERING_STANDARDS TEST-1).
 */
export class FakeScheduler implements Scheduler {
  private currentTime = 0;

  private nextId = 0;

  private readonly timers = new Map<number, PendingTimer>();

  get pendingTimerCount(): number {
    return this.timers.size;
  }

  get now(): number {
    return this.currentTime;
  }

  /** Timers currently asking to hold the host process open. */
  get keepAliveTimerCount(): number {
    return [...this.timers.values()].filter((timer) => timer.keepProcessAlive).length;
  }

  schedule(callback: () => void, delayMs: number, options: ScheduleOptions): CancelTimer {
    const id = (this.nextId += 1);
    this.timers.set(id, {
      at: this.currentTime + delayMs,
      callback,
      keepProcessAlive: options.keepProcessAlive,
    });
    return () => {
      this.timers.delete(id);
    };
  }

  /**
   * Fires every timer due within `ms`, oldest deadline first, letting the event loop
   * settle between callbacks so a callback that schedules more work is picked up.
   */
  async advance(ms: number): Promise<void> {
    // Real timers never fire ahead of an already-queued microtask. Moving the clock before
    // the event loop has settled would let a timer scheduled at t=1000 run before the
    // backoff timer the current attempt is about to schedule at t=200.
    await settle();
    const target = this.currentTime + ms;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) {
        this.currentTime = target;
        await settle();
        return;
      }
      this.timers.delete(due[0]);
      this.currentTime = due[1].at;
      due[1].callback();
      await settle();
    }
    throw new Error('FakeScheduler.advance fired 10000 timers without draining — runaway timer');
  }
}
