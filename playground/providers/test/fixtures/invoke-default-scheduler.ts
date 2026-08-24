/**
 * Standalone script — NOT a `node:test` file, and not matched by
 * `playground/package.json`'s test glob (it lives under `fixtures/`, which no `*.spec.ts` /
 * `*.test.ts` pattern reaches). Spawned as a real child process by
 * `../process-exit.spec.ts` so `MockProvider`'s actual production default — the real
 * `systemScheduler`, no `FakeScheduler`, no `node:test` runner holding the event loop open
 * on its own — gets to decide whether this process exits before both awaited calls settle.
 *
 * Two sequential `await invoke()` calls, matching the validator's own reproduction
 * (`.artifacts/evidence/3/wave2-gate/validator/raw/mock-provider-silent-hang.txt`): a
 * non-zero `delayMs` so the scheduler actually arms a real timer, and nothing else pending
 * on the event loop that would incidentally keep the process alive.
 */
import { MockProvider } from '../../mock-provider';

// No top-level await: `playground/package.json` carries no `"type"` field, so tsx's
// nearest-package.json lookup resolves this file to CommonJS (the root package.json's
// `"type": "module"` is further away and loses), where top-level await is a syntax error.
// An async IIFE proves exactly the same thing — the race is about the scheduler's timer and
// the event loop, which behave identically under CJS and ESM.
async function main(): Promise<void> {
  const provider = new MockProvider({ seed: 1, delayMs: 10 });

  const first = await provider.invoke({ step: 'a' });
  process.stdout.write(`first ${first.detail}\n`);

  const second = await provider.invoke({ step: 'b', callIndex: 1 });
  process.stdout.write(`second ${second.detail}\n`);

  process.stdout.write('SCRIPT-COMPLETED\n');
}

void main();
