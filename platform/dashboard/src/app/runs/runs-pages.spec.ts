import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { RunDetailView, RunListView } from '@lengentic/shared/read';
import RunsPage from './page';
import RunDetailPage from './[id]/page';

/**
 * The Run Explorer pages, rendered.
 *
 * ## Why this file exists
 *
 * The Phase 2 DoD says "The Dashboard shows the resulting Run." At the phase gate the Tester
 * confirmed by observation that it does — three interfaces agreed, down to the rendered tree
 * `root-step > (child-step > grandchild-step, sibling-step FAILED)`. And **nothing would have
 * noticed if it broke.** `src/lib/step-tree.spec.ts` was the only spec under `src/`, and it
 * proves a pure function; `src/lib/runs-api.ts` had no test at all. Two one-line mutations
 * left `pnpm gates` entirely green:
 *
 * - **D1** — make `fetchRunList` return an empty `runs` array. The page renders "No runs"
 *   while the API holds two. 18/18 dashboard tests, typecheck, eslint, integrity and
 *   boundaries all exit 0.
 * - **D2** — make the detail page stop recursing into `node.children`. The page prints
 *   "4 steps" above a single `<li>`. Same result.
 *
 * ## The seam
 *
 * `fetch`, and nothing above it. The real `runs-api.ts` — its URL construction, its
 * `safeParse` against `@lengentic/shared/read`, its three failure kinds — and the real page
 * components both run against a stubbed HTTP boundary. A test that stubbed `fetchRunList`
 * itself would be green under D1, which is the whole failure being repaired: the alarm has to
 * sit on the far side of the thing it watches.
 *
 * ## Why the pages are called rather than mounted
 *
 * These are async Server Components. React's own contract for one is: call it, await the
 * element tree it returns, render that tree. `renderPage` below is exactly those three steps,
 * so what is rendered here is the real component's real output — every child in the returned
 * tree (`RunList`, `RunRow`, `Pager`, `StepsCard`, `StepBranch`, `FetchFailureCard`) is a
 * plain synchronous component and runs for real.
 */

const RUN_ALPHA = {
  id: 'run-alpha',
  traceId: 'trace-alpha',
  workflowName: 'checkout-agent',
  workflowVersion: '1.4.0',
  status: 'RUNNING',
  startedAt: '2026-08-21T11:00:00.000Z',
  completedAt: null,
  receivedAt: '2026-08-21T11:00:00.000Z',
  lastEventAt: '2026-08-21T11:59:00.000Z',
  metadata: null,
} as const satisfies RunListView['runs'][number];

const RUN_BETA = {
  id: 'run-beta',
  traceId: 'trace-beta',
  workflowName: 'refund-agent',
  workflowVersion: '0.2.0',
  status: 'STALE',
  startedAt: '2026-08-21T09:00:00.000Z',
  completedAt: null,
  receivedAt: '2026-08-21T09:00:00.000Z',
  lastEventAt: '2026-08-21T09:01:00.000Z',
  metadata: null,
} as const satisfies RunListView['runs'][number];

/**
 * Four steps in the shape the DoD line "posting a child Step before its parent produces the
 * correct tree" is about: a root, a child, a grandchild, and a second child of the root that
 * failed. `parentStepId` is what the API sends — the tree is the Dashboard's to build, and
 * whether it also *renders* it is what this fixture is here to decide.
 */
const RUN_WITH_TREE = {
  id: 'run-tree',
  traceId: 'trace-tree',
  workflowName: 'checkout-agent',
  workflowVersion: '1.4.0',
  status: 'FAILED',
  startedAt: '2026-08-21T11:00:00.000Z',
  completedAt: '2026-08-21T11:05:00.000Z',
  receivedAt: '2026-08-21T11:00:00.000Z',
  lastEventAt: '2026-08-21T11:05:00.000Z',
  metadata: null,
  steps: [
    step({ id: 'root-step', parentStepId: null, name: 'root-step' }),
    step({ id: 'child-step', parentStepId: 'root-step', name: 'child-step' }),
    step({ id: 'grandchild-step', parentStepId: 'child-step', name: 'grandchild-step' }),
    step({
      id: 'sibling-step',
      parentStepId: 'root-step',
      name: 'sibling-step',
      status: 'FAILED',
    }),
  ],
} as const satisfies RunDetailView;

function step(overrides: {
  id: string;
  parentStepId: string | null;
  name: string;
  status?: 'RUNNING' | 'COMPLETED' | 'FAILED';
}): RunDetailView['steps'][number] {
  return {
    runId: 'run-tree',
    agentName: 'checkout-agent',
    type: 'execute',
    status: 'COMPLETED',
    startedAt: '2026-08-21T11:00:01.000Z',
    completedAt: '2026-08-21T11:00:02.000Z',
    receivedAt: '2026-08-21T11:00:01.000Z',
    metadata: null,
    ...overrides,
  };
}

function listOf(runs: readonly RunListView['runs'][number][], offset = 0): RunListView {
  return { runs: [...runs], limit: 50, offset, hasMore: false };
}

interface StubbedRoute {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Answers `fetch` from a table keyed by path + query string, and records what was asked for.
 *
 * Keyed by path rather than by absolute URL so the suite does not depend on whatever
 * `NEXT_PUBLIC_API_BASE_URL` happens to be set to in the running shell, while still pinning
 * the query `runs-api.ts` actually builds. A path with no entry is a rejected request, not a
 * quiet 200 — a page that asked for something this test did not intend must fail loudly.
 */
function stubApi(routes: Readonly<Record<string, StubbedRoute>>): { readonly asked: string[] } {
  const asked: string[] = [];

  vi.stubGlobal('fetch', (input: unknown): Promise<Response> => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    asked.push(key);

    const route = routes[key];
    if (route === undefined) {
      return Promise.reject(new Error(`the page requested ${key}, which this test did not stub`));
    }

    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  return { asked };
}

/** `fetch` itself throws — the API is not answering at all. */
function stubUnreachableApi(reason: string): void {
  vi.stubGlobal('fetch', () => Promise.reject(new Error(reason)));
}

async function renderPage(page: Promise<ReactElement>): Promise<string> {
  // React inserts `<!-- -->` between adjacent text children. Stripping it keeps assertions
  // about the sentences a reader sees from depending on where JSX happened to split them.
  return renderToStaticMarkup(await page).replaceAll('<!-- -->', '');
}

/**
 * Every step id the page **emitted**, with the nesting depth it was emitted at.
 *
 * Read off the rendered markup, deliberately. Anything derived from `buildStepTree` agrees
 * with the tree by construction, and "the tree is right, the page renders part of it" is
 * precisely the regression D2 proved nothing was watching for — including the page's own
 * count alarm, which compares `run.steps.length` against `countStepNodes(tree)` and so
 * compares the tree with itself.
 *
 * Depth is counted in `<ul class="step-branch">` nestings. The id is taken from the first
 * `<code>` of the step's `.step-meta` row specifically, not from any `<code>`: the summary
 * card has several, and an orphaned or cycle-placed step prints its *parent's* id in the mark
 * above the meta row.
 */
function emittedSteps(markup: string): [string, number][] {
  const token = /<ul class="step-branch">|<\/ul>|<div class="step-meta"><code>([^<]*)<\/code>/g;
  const emitted: [string, number][] = [];
  let depth = -1;

  for (const match of markup.matchAll(token)) {
    if (match[0].startsWith('<ul')) depth += 1;
    else if (match[0] === '</ul>') depth -= 1;
    else if (match[1] !== undefined) emitted.push([match[1], depth]);
  }

  return emitted;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /runs — the run list page', () => {
  it('renders every run the API returned, with its workflow, its derived status and its id', async () => {
    // D1's alarm. Expected values are the fixture's own fields, which are what the API is
    // being made to answer with — never anything read back off the render.
    const { asked } = stubApi({
      '/v1/runs?limit=50&offset=0': { status: 200, body: listOf([RUN_ALPHA, RUN_BETA]) },
    });

    const markup = await renderPage(RunsPage({ searchParams: Promise.resolve({}) }));

    expect(asked).toStrictEqual(['/v1/runs?limit=50&offset=0']);
    expect(markup).toContain('2 runs');
    expect(markup).toContain('checkout-agent');
    expect(markup).toContain('run-alpha');
    expect(markup).toContain('refund-agent');
    expect(markup).toContain('run-beta');
    // The derived status, not the stored one — `STALE` exists only in the response.
    expect(markup).toContain('>STALE<');
    // The paired negative: "No runs" is a real state of this page (asserted below), so its
    // absence here is what makes the assertions above mean "these runs" and not "some runs".
    expect(markup).not.toContain('No runs');
  });

  it('says the API has recorded no runs when the list really is empty', async () => {
    // Without this, "does not contain No runs" above would be a claim about a string the page
    // might never produce under any input.
    stubApi({ '/v1/runs?limit=50&offset=0': { status: 200, body: listOf([]) } });

    const markup = await renderPage(RunsPage({ searchParams: Promise.resolve({}) }));

    expect(markup).toContain('No runs');
    expect(markup).toContain('The API has recorded no runs yet');
    expect(markup).not.toContain('run-alpha');
  });

  it('answers a link asking for more than the API allows with the first page, and says so', async () => {
    // `RunsListQuerySchema.max(200)` rejects 5000, so `parseRunsListQuery` falls back rather
    // than letting the API answer 400 and the page render an outage.
    const { asked } = stubApi({
      '/v1/runs?limit=50&offset=0': { status: 200, body: listOf([RUN_ALPHA]) },
    });

    const markup = await renderPage(
      RunsPage({ searchParams: Promise.resolve({ limit: '5000', offset: '0' }) }),
    );

    expect(asked).toStrictEqual(['/v1/runs?limit=50&offset=0']);
    expect(markup).toContain('Showing the first page instead');
    expect(markup).toContain('run-alpha');
  });

  it('carries a valid page query through to the API unchanged', async () => {
    const { asked } = stubApi({
      '/v1/runs?limit=2&offset=4': { status: 200, body: listOf([RUN_ALPHA], 4) },
    });

    const markup = await renderPage(
      RunsPage({ searchParams: Promise.resolve({ limit: '2', offset: '4' }) }),
    );

    expect(asked).toStrictEqual(['/v1/runs?limit=2&offset=4']);
    expect(markup).not.toContain('Showing the first page instead');
  });

  it('reports an unanswering API as unreachable, naming the address it actually tried', async () => {
    stubUnreachableApi('connect ECONNREFUSED 127.0.0.1:3001');

    const markup = await renderPage(RunsPage({ searchParams: Promise.resolve({}) }));

    expect(markup).toContain('Runs unavailable');
    expect(markup).toContain('unreachable');
    expect(markup).toContain('connect ECONNREFUSED 127.0.0.1:3001');
    expect(markup).toContain('/v1/runs?limit=50&amp;offset=0');
  });

  it('reports a body that is not the published contract as a mismatch, not as an outage', async () => {
    // A deployed API older than this page: 200, a body, and `runs` missing. Rendering that as
    // "unreachable" would send someone to restart a healthy service.
    stubApi({
      '/v1/runs?limit=50&offset=0': { status: 200, body: { limit: 50, offset: 0, hasMore: false } },
    });

    const markup = await renderPage(RunsPage({ searchParams: Promise.resolve({}) }));

    expect(markup).toContain('contract mismatch');
    expect(markup).toContain('@lengentic/shared/read');
    expect(markup).not.toContain('unreachable');
  });

  it('reports a non-2xx from the list endpoint as an HTTP error', async () => {
    stubApi({ '/v1/runs?limit=50&offset=0': { status: 503, body: { message: 'degraded' } } });

    const markup = await renderPage(RunsPage({ searchParams: Promise.resolve({}) }));

    expect(markup).toContain('HTTP 503');
    expect(markup).not.toContain('contract mismatch');
  });
});

describe('GET /runs/[id] — the run detail page', () => {
  it('renders the whole step tree, nested — every step the response carried, at its own depth', async () => {
    // D2's alarm, and the DoD line "posting a child Step before its parent produces the
    // correct tree" proved at the page rather than at `buildStepTree`.
    //
    // The expected pairs are read off the fixture's `parentStepId` chain by hand — root at 0,
    // its two children at 1, the grandchild under `child-step` at 2 — not off `buildStepTree`,
    // which is the function whose output the page is accused of not rendering.
    stubApi({ '/v1/runs/run-tree': { status: 200, body: RUN_WITH_TREE } });

    const markup = await renderPage(RunDetailPage({ params: Promise.resolve({ id: 'run-tree' }) }));

    expect(emittedSteps(markup)).toStrictEqual([
      ['root-step', 0],
      ['child-step', 1],
      ['grandchild-step', 2],
      ['sibling-step', 1],
    ]);
    expect(markup).toContain('4 steps');
    // The failed sibling's own stored status, which is never replaced by the run's.
    expect(markup).toContain('>FAILED<');
    expect(markup).not.toContain('not on this page');
  });

  it('marks a step whose parent never arrived instead of promoting it to a root', async () => {
    // §13 gives `parentStepId` no foreign key. Rendering this flush-left and unmarked would
    // assert the step had no parent — a claim about the run the Dashboard cannot make.
    stubApi({
      '/v1/runs/run-tree': {
        status: 200,
        body: {
          ...RUN_WITH_TREE,
          steps: [step({ id: 'lost-step', parentStepId: 'never-arrived', name: 'lost-step' })],
        },
      },
    });

    const markup = await renderPage(RunDetailPage({ params: Promise.resolve({ id: 'run-tree' }) }));

    expect(emittedSteps(markup)).toStrictEqual([['lost-step', 0]]);
    expect(markup).toContain('1 step · 1 orphaned');
    expect(markup).toContain('not in this run');
  });

  it('says no steps have been recorded rather than rendering an empty tree', async () => {
    stubApi({
      '/v1/runs/run-tree': { status: 200, body: { ...RUN_WITH_TREE, steps: [] } },
    });

    const markup = await renderPage(RunDetailPage({ params: Promise.resolve({ id: 'run-tree' }) }));

    expect(emittedSteps(markup)).toStrictEqual([]);
    expect(markup).toContain('No steps have been recorded against this run');
  });

  it('percent-encodes the id it was given before asking the API for it', async () => {
    const { asked } = stubApi({
      '/v1/runs/run%2Ftree': { status: 200, body: { ...RUN_WITH_TREE, steps: [] } },
    });

    await renderPage(RunDetailPage({ params: Promise.resolve({ id: 'run/tree' }) }));

    expect(asked).toStrictEqual(['/v1/runs/run%2Ftree']);
  });

  it('turns a 404 into Next’s not-found page rather than a failure card', async () => {
    // ERR-3: "no such run" is a domain answer. A failure card here would tell the reader the
    // API is unwell when it answered correctly.
    stubApi({ '/v1/runs/run-missing': { status: 404, body: { message: 'not found' } } });

    await expect(
      RunDetailPage({ params: Promise.resolve({ id: 'run-missing' }) }),
    ).rejects.toThrow();
  });

  it('reports an unanswering API on the detail page too', async () => {
    stubUnreachableApi('connect ECONNREFUSED 127.0.0.1:3001');

    const markup = await renderPage(RunDetailPage({ params: Promise.resolve({ id: 'run-tree' }) }));

    expect(markup).toContain('Runs unavailable');
    expect(markup).toContain('connect ECONNREFUSED 127.0.0.1:3001');
    expect(emittedSteps(markup)).toStrictEqual([]);
  });
});
