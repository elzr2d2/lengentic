/**
 * A `Scheduler` (`@lengentic/telemetry-sdk`'s public timer seam) whose clock only moves
 * when a test moves it — the same shape as
 * `platform/telemetry-sdk/test/support/fake-scheduler.ts`, kept as its own small copy here
 * because that file is test-only material inside another package, not something the
 * Playground may import (`playground-sdk-public-entry-only`). This is what lets
 * `mock-provider.spec.ts` assert `MockProvider`'s configured delay actually withholds
 * resolution, without a real wait (`docs/ENGINEERING_STANDARDS.md` TEST-1).
 */
import type { CancelTimer, Scheduler } from '@lengentic/telemetry-sdk';

interface PendingTimer {
  readonly at: number;
  readonly callback: () => void;
}

const settle = (): Promise<void> =>
  new Promise<void>((done) => {
    setImmediate(done);
  });

export class FakeScheduler implements Scheduler {
  private currentTime = 0;

  private nextId = 0;

  private readonly timers = new Map<number, PendingTimer>();

  get pendingTimerCount(): number {
    return this.timers.size;
  }

  schedule(callback: () => void, delayMs: number): CancelTimer {
    const id = (this.nextId += 1);
    this.timers.set(id, { at: this.currentTime + delayMs, callback });
    return () => {
      this.timers.delete(id);
    };
  }

  /** Fires every timer due within `ms`, oldest deadline first. */
  async advance(ms: number): Promise<void> {
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
