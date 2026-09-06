/**
 * Seam: `../main.ts`'s argv and environment parsing — the two places this entry point can
 * silently run a workload nobody asked for.
 *
 * `main()` itself is not exercised here: it opens a real transport at a real endpoint, which
 * is `p7.e2e`'s and `p7.docker-smoke`'s ground, and the emission it wraps is already checked
 * at its own seam in `./scenario.spec.ts`. What is left that only this file owns is the
 * mapping from a string to a seed, and the four ways `Number()` alone gets that wrong
 * (`playground/cli/happy-path.ts`, tester F4).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSeed, resolveEndpoint } from '../main';
import { PLAYGROUND_DEFAULT_ENDPOINT } from '../../../index';

void describe('parseSeed', () => {
  void it('defaults when no flag is given', () => {
    assert.equal(parseSeed([]), 42);
  });

  void it('reads a decimal integer, including a negative one', () => {
    assert.equal(parseSeed(['--seed=7']), 7);
    assert.equal(parseSeed(['--seed=-7']), -7);
    assert.equal(parseSeed(['--seed=0']), 0);
  });

  void it('rejects the values Number() would silently coerce', () => {
    for (const raw of ['', '0x10', '1e3', '1.5', ' 7', 'seven']) {
      assert.throws(
        () => parseSeed([`--seed=${raw}`]),
        /--seed must be an integer/,
        `--seed=${raw} must be rejected, not coerced`,
      );
    }
  });

  void it('rejects an unrecognised argument rather than ignoring it', () => {
    assert.throws(() => parseSeed(['--runs=5']), /unrecognised argument "--runs=5"/);
  });
});

void describe('resolveEndpoint', () => {
  void it('falls back to the Playground default', () => {
    assert.equal(resolveEndpoint({}), PLAYGROUND_DEFAULT_ENDPOINT);
    assert.equal(resolveEndpoint({ PLAYGROUND_ENDPOINT: '' }), PLAYGROUND_DEFAULT_ENDPOINT);
  });

  void it('honours an override', () => {
    assert.equal(
      resolveEndpoint({ PLAYGROUND_ENDPOINT: 'http://example.test:9999' }),
      'http://example.test:9999',
    );
  });
});
