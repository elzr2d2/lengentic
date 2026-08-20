/**
 * Seed infrastructure (MVP_PLAN.md §32).
 *
 * Phase 1 has no models, so there is nothing to seed. The wiring exists and is proven to
 * run; the first real seed data arrives with Run and Step in Phase 2.
 *
 * Kept as an executable no-op rather than deferred entirely, because discovering that
 * `db:seed` was never wired up is much cheaper now than during a Phase 2 migration.
 */

// Synchronous while there is nothing to insert. Phase 2 makes it `async` again the moment
// it awaits a real write; `require-await` is what keeps the two in step.
function main(): void {
  process.stdout.write('seed: no models defined yet (Phase 1) — nothing to insert\n');
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`seed failed: ${String(error)}\n`);
  process.exitCode = 1;
}
