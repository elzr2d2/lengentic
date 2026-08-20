/** Cancels a scheduled callback. Calling it after the callback ran is a no-op. */
export type CancelTimer = () => void;

export interface ScheduleOptions {
  /**
   * Whether this timer may hold the host process open.
   *
   * Two real cases, and they pull in opposite directions — which is why this is an explicit
   * argument at every call site rather than a default somewhere:
   *
   *  - `false` for ordinary background work. A host that never calls `shutdown()` must
   *    still exit the moment its own work is done; an observability SDK is never the reason
   *    a script hangs.
   *  - `true` while `shutdown()` is draining. §16 makes `await telemetry.shutdown()`
   *    "required for short-lived processes and scripts", and a drain the runtime is free to
   *    cut short is not a drain. Proven at the process boundary in `test/process-exit.spec.ts`.
   */
  readonly keepProcessAlive: boolean;
}

/**
 * The timer seam. Injected so a test can drive the flush interval, the request timeout and
 * the retry backoff without waiting real seconds (ENGINEERING_STANDARDS TEST-1 forbids an
 * arbitrary sleep in a test).
 */
export interface Scheduler {
  schedule(callback: () => void, delayMs: number, options: ScheduleOptions): CancelTimer;
}

export const systemScheduler: Scheduler = {
  schedule(callback: () => void, delayMs: number, options: ScheduleOptions): CancelTimer {
    const timer = setTimeout(callback, delayMs);
    if (!options.keepProcessAlive) timer.unref();
    return () => {
      clearTimeout(timer);
    };
  },
};
