/**
 * A `Scheduler` (`@lengentic/telemetry-sdk`'s public timer seam) whose clock only moves
 * when a test moves it. A small local copy of
 * `playground/providers/test/support/fake-scheduler.ts` (itself a local copy of
 * `platform/telemetry-sdk/test/support/fake-scheduler.ts`, for the reason documented
 * there) — this is what lets `mock-agent.spec.ts` assert that `MockAgent`'s Execute phase
 * actually starts every task before any of them completes in `parallel` mode, and starts
 * each task only after the previous one completed in `sequential` mode, without a real
 * wait (`docs/ENGINEERING_STANDARDS.md` TEST-1).
 */
import type { CancelTimer, Scheduler } from '../../../index';

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
