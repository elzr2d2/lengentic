import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import StatusPage from '../app/page';
import { fetchHealth } from './api';

/**
 * `fetchHealth` and the status page, against a stubbed `fetch`.
 *
 * Seam: `fetch`, nothing above it — the real `safeParse` against `@lengentic/shared/read`
 * and the real page component both run. The defect this pins: the body used to be cast
 * (`as HealthReport`) and the page read `report.checks.database`, so any JSON body of another
 * shape — e.g. the API's own AllExceptionsFilter 500 body — threw a TypeError during render
 * and the status page became a 500, despite `fetchHealth`'s "never throws" contract.
 *
 * Expected values are written from the wire contract (`platform/shared/read/health.ts`) and
 * from the API's documented 200/503 semantics, not from this module's output.
 */

function stubFetch(status: number, body: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(body, { status, headers: { 'content-type': 'application/json' } }),
      ),
    ),
  );
}

async function renderStatusPage(): Promise<string> {
  const element = (await StatusPage()) as ReactElement;
  return renderToStaticMarkup(element);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchHealth', () => {
  it('reads a degraded 503 report as reachable, database down', async () => {
    stubFetch(
      503,
      JSON.stringify({ status: 'degraded', uptimeSeconds: 7, checks: { database: 'down' } }),
    );

    const result = await fetchHealth();

    expect(result).toEqual({
      kind: 'reachable',
      httpStatus: 503,
      report: { status: 'degraded', uptimeSeconds: 7, checks: { database: 'down' } },
    });
  });

  it('reports an error-filter 500 body as invalid, not as a report', async () => {
    stubFetch(500, JSON.stringify({ statusCode: 500, message: 'Internal server error' }));

    const result = await fetchHealth();

    expect(result.kind).toBe('invalid');
    expect(result).toMatchObject({ httpStatus: 500 });
  });

  it('reports a non-JSON body as invalid, not unreachable: the API answered', async () => {
    stubFetch(502, '<html>Bad Gateway</html>');

    const result = await fetchHealth();

    expect(result).toMatchObject({ kind: 'invalid', httpStatus: 502 });
  });

  it('rejects a database check outside up|down', async () => {
    stubFetch(200, JSON.stringify({ status: 'ok', uptimeSeconds: 1, checks: { database: 'yes' } }));

    expect((await fetchHealth()).kind).toBe('invalid');
  });
});

describe('the status page', () => {
  it('renders, rather than throwing, when /health answers with a body of another shape', async () => {
    stubFetch(500, JSON.stringify({ statusCode: 500, message: 'Internal server error' }));

    const html = await renderStatusPage();

    expect(html).toContain('up · HTTP 500');
    expect(html).toContain('unexpected /health body');
  });

  it('renders database up for a healthy report', async () => {
    stubFetch(200, JSON.stringify({ status: 'ok', uptimeSeconds: 3, checks: { database: 'up' } }));

    const html = await renderStatusPage();

    expect(html).toContain('up · HTTP 200');
    expect(html).toContain('3s');
  });
});
