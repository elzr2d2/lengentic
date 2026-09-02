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
 *
 * ## Why no step's `id` is its `name`
 *
 * It used to be — every step here was `id: 'root-step', name: 'root-step'` — and the phase-gate
 * Tester measured what that cost. `emittedSteps` below reads the id out of the `.step-meta`
 * `<code>`; with `id === name` it cannot tell "the page printed the id" from "the page printed
 * the name", so making that `<code>` print `node.step.name` left the whole suite green
 * (D2b, `.artifacts/evidence/2/phase-gate-2/tester/README.md` §2). A fixture whose two fields
 * are indistinguishable makes every assertion about either one of them weaker than it reads.
 *
 * The ids are ordinal-prefixed (`step-01-…`) so a wrong *placement* names itself in the diff
 * as well: the ordinals are the fixture's declaration order, the depths below are its
 * `parentStepId` chain, and the two are deliberately not the same fact.
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
    step({ id: 'step-01-root', parentStepId: null, name: 'root-step' }),
    step({ id: 'step-02-child', parentStepId: 'step-01-root', name: 'child-step' }),
    step({ id: 'step-03-grandchild', parentStepId: 'step-02-child', name: 'grandchild-step' }),
    step({
      id: 'step-04-sibling',
      parentStepId: 'step-01-root',
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

/**
 * A run whose steps arrive in one order and executed in another, with server clocks nowhere
 * near the client ones.
 *
 * `RUN_WITH_TREE` cannot serve here: its steps all share one `startedAt` and one
 * `completedAt`, so every bar is the same bar and the rendered order is the array's whatever
 * the timeline does with it. This fixture separates the two facts. Declaration order is
 * `late, first` — the arrival order the Steps card renders — while the client clock says the
 * opposite, and the timeline must say so too (§12: `occurredAt` is "authoritative for
 * ordering").
 *
 * `receivedAt` is 19:00 on every step and 09:00 on the run, hours from the 11:00 client
 * window, so a card that reached for the server clock cannot produce the geometry below.
 */
const RUN_ON_THE_CLOCK = {
  id: 'run-clock',
  traceId: 'trace-clock',
  workflowName: 'checkout-agent',
  workflowVersion: '1.4.0',
  status: 'COMPLETED',
  startedAt: '2026-08-21T11:00:00.000Z',
  completedAt: '2026-08-21T11:00:10.000Z',
  receivedAt: '2026-08-21T09:00:00.000Z',
  lastEventAt: '2026-08-21T09:00:00.000Z',
  metadata: null,
  steps: [
    timedStep({
      id: 'step-77-late',
      name: 'late-step',
      startedAt: '2026-08-21T11:00:05.000Z',
      completedAt: '2026-08-21T11:00:07.500Z',
    }),
    timedStep({
      id: 'step-11-first',
      name: 'first-step',
      startedAt: '2026-08-21T11:00:00.000Z',
      completedAt: '2026-08-21T11:00:02.500Z',
    }),
    timedStep({ id: 'step-99-clockless', name: 'clockless-step' }),
  ],
} as const satisfies RunDetailView;

function timedStep(overrides: {
  id: string;
  name: string;
  startedAt?: string;
  completedAt?: string;
}): RunDetailView['steps'][number] {
  return {
    runId: 'run-clock',
    parentStepId: null,
    agentName: 'checkout-agent',
    type: 'execute',
    status: 'COMPLETED',
    startedAt: null,
    completedAt: null,
    // The server clock, deliberately eight hours from every client instant above.
    receivedAt: '2026-08-21T19:00:00.000Z',
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
 *
 * ## Why it tracks a stack of lists rather than a counter
 *
 * It used to be one `depth` counter incremented on `<ul class="step-branch">` and decremented
 * on every `</ul>`. That was correct while the steps card held the only `<ul>` on the page,
 * and silently wrong the moment the Execution Timeline card added one above it: an unmatched
 * `</ul>` drove the counter negative, and every step id came back one level shallower than it
 * was rendered at. The failure landed on a passing page — the tree was right and the reader
 * saw it — which is the shape of harness bug that gets "fixed" by editing the expectation.
 * The stack records *which* list each `</ul>` closes, so a list this helper is not about
 * cannot move a depth it is.
 */
function emittedSteps(markup: string): [string, number][] {
  const token = /<ul(?: class="([^"]*)")?>|<\/ul>|<div class="step-meta"><code>([^<]*)<\/code>/g;
  const emitted: [string, number][] = [];
  const open: string[] = [];

  for (const match of markup.matchAll(token)) {
    if (match[0].startsWith('<ul')) open.push(match[1] ?? '');
    else if (match[0] === '</ul>') open.pop();
    else if (match[2] !== undefined) {
      emitted.push([match[2], open.filter((cls) => cls === 'step-branch').length - 1]);
    }
  }

  return emitted;
}

/**
 * Every step **name** the page emitted, in document order.
 *
 * A separate reading from `emittedSteps` on purpose. That one watches the `.step-meta`
 * `<code>` — ids and nesting — and stays green with the `.step-name` span deleted and every
 * step rendered nameless (D2d, Tester §2). Identity and placement are one claim about the
 * page; "and it says which step each one is" is another, and it needs its own oracle.
 */
function emittedStepNames(markup: string): string[] {
  return [...markup.matchAll(/<span class="step-name">([^<]*)<\/span>/g)].map((m) => m[1] ?? '');
}

/**
 * The run detail page's summary card, as the reader sees it: its heading, and every
 * `label → value` row in it.
 *
 * ## Why it is sliced out of the markup rather than asserted with `toContain`
 *
 * `expect(markup).toContain('>FAILED<')` was the only thing this file said about the detail
 * page's summary card, and the phase-gate Tester showed it is satisfied by
 * `sibling-step`'s own status badge further down the page — so it stayed true while
 * `RunSummaryCard` was made to render *nothing at all*: no workflow name, no version, no run
 * id, no trace id, no badge, no timestamps (D2c). An unscoped substring assertion about a
 * card is a claim about the whole document, and the page has more than one card.
 *
 * So the card is located first — it is the first `<section class="card">` the page emits —
 * and only then read. If `RunSummaryCard` emits no section, the first one becomes the steps
 * card and the returned rows are its (none), which is a mismatch rather than a pass.
 *
 * The values are tag-stripped, so `<span class="value">1.4.0</span>`, `<code>run-tree</code>`
 * and `<time …>2026-…Z</time>` all read as their text. What is asserted is what a reader
 * would see, not which element the page happened to choose.
 */
function summaryCard(markup: string): { title: string; rows: [string, string][] } {
  const section = /<section class="card">([\s\S]*?)<\/section>/.exec(markup);
  if (section === null) return { title: '(no card on the page)', rows: [] };

  const body = section[1] ?? '';
  const title = /<h2 class="card-title">([\s\S]*?)<\/h2>/.exec(body)?.[1] ?? '(no card title)';

  const rows = [
    ...body.matchAll(/<div class="row"><span class="row-label">([^<]*)<\/span>([\s\S]*?)<\/div>/g),
  ].map((match): [string, string] => [match[1] ?? '', stripTags(match[2] ?? '')]);

  return { title: stripTags(title), rows };
}

/**
 * One entry per `<li class="run-row">` the list page emitted — the four fields the row is
 * made of, each read from its own element.
 *
 * `workflowVersion` is in here because deleting it from the row left this suite, `typecheck`
 * and `eslint` all green (D2e, Tester §2), and the Phase 2 DoD prose names it: "start a Run
 * with a `workflowVersion` … The Dashboard shows the resulting Run." A Run shown without the
 * field the sentence names does not discharge the sentence.
 */
function runRows(markup: string): { name: string; version: string; status: string; id: string }[] {
  return [...markup.matchAll(/<li class="run-row">([\s\S]*?)<\/li>/g)].map((match) => {
    const row = match[1] ?? '';

    return {
      name: /<span class="run-row-name">([^<]*)<\/span>/.exec(row)?.[1] ?? '(no name element)',
      version:
        /<span class="run-row-version">([^<]*)<\/span>/.exec(row)?.[1] ?? '(no version element)',
      status: /<span class="status status-[a-z]+">([^<]*)<\/span>/.exec(row)?.[1] ?? '(no badge)',
      id: /<code>([^<]*)<\/code>/.exec(row)?.[1] ?? '(no id element)',
    };
  });
}

/**
 * The Execution Timeline card, as the reader sees it: its heading, its window row, one entry
 * per rendered bar, and the ids it listed as unplaceable.
 *
 * Located by its heading rather than by position, so inserting another card above or below it
 * does not silently retarget every assertion at the wrong section — which is exactly how
 * `summaryCard`'s `toContain('>FAILED<')` predecessor came to be satisfied by a badge in a
 * different card.
 *
 * The bar's `style` is read verbatim. `left`/`width` are the whole geometry of the chart —
 * everything a reader concludes from the picture is in those two numbers — so a card that
 * emitted the right names, the right durations and every bar at `left:0%` would be a chart
 * that lies, and nothing else on this page would notice.
 */
function timelineCard(markup: string): {
  title: string;
  window: string;
  runDuration: string;
  rows: { name: string; mark: string; duration: string; bar: string }[];
  unplaced: string[];
} {
  const card =
    /<section class="card"><h2 class="card-title">Execution timeline[\s\S]*?<\/section>/.exec(
      markup,
    )?.[0] ?? '(no timeline card on the page)';

  const rowMatches = [...card.matchAll(/<li class="timeline-row">([\s\S]*?)<\/li>/g)].map(
    (match) => match[1] ?? '',
  );

  return {
    title: stripTags(/<h2 class="card-title">([\s\S]*?)<\/h2>/.exec(card)?.[1] ?? '(no title)'),
    window: labelledRow(card, 'Window'),
    runDuration: labelledRow(card, 'Run duration'),
    // A row with no bar is an unplaced step, which has its own list below.
    rows: rowMatches
      .filter((row) => row.includes('timeline-track'))
      .map((row) => ({
        name: /<span class="timeline-name">([^<]*)<\/span>/.exec(row)?.[1] ?? '(no name element)',
        mark: stripTags(
          /<span class="placement placement-[a-z-]+">([\s\S]*?)<\/span>/.exec(row)?.[1] ?? '',
        ),
        duration:
          /<span class="timeline-duration">([^<]*)<\/span>/.exec(row)?.[1] ?? '(no duration)',
        bar: /<div class="timeline-bar[^"]*" style="([^"]*)"/.exec(row)?.[1] ?? '(no bar)',
      })),
    unplaced: rowMatches
      .filter((row) => !row.includes('timeline-track'))
      .map((row) => /<code>([^<]*)<\/code>/.exec(row)?.[1] ?? '(no id element)'),
  };
}

/** One `label → value` row of a card, by its label. */
function labelledRow(card: string, label: string): string {
  const row = new RegExp(
    `<div class="row"><span class="row-label">${label}</span>([\\s\\S]*?)</div>`,
  ).exec(card);

  return stripTags(row?.[1] ?? `(no ${label} row)`);
}

/** The text a reader sees, with whatever markup carried it removed. */
function stripTags(fragment: string): string {
  return fragment.replaceAll(/<[^>]*>/g, '');
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

  it('renders each run as its own row — workflow name, workflow version, derived status and id', async () => {
    // D2e's alarm on the list page. The expected rows are the two fixtures' own fields,
    // transcribed by hand in the order the stub answers with — never read back off the
    // render, and never derived from anything the page computed.
    //
    // A row at a time, rather than four `toContain`s over the whole document: `toContain`
    // cannot say which row a value landed in, and — as `>FAILED<` proved on the detail page —
    // a value belonging to some *other* element keeps an unscoped substring assertion true
    // while the element under test is gone.
    stubApi({
      '/v1/runs?limit=50&offset=0': { status: 200, body: listOf([RUN_ALPHA, RUN_BETA]) },
    });

    const markup = await renderPage(RunsPage({ searchParams: Promise.resolve({}) }));

    expect(runRows(markup)).toStrictEqual([
      { name: 'checkout-agent', version: '1.4.0', status: 'RUNNING', id: 'run-alpha' },
      { name: 'refund-agent', version: '0.2.0', status: 'STALE', id: 'run-beta' },
    ]);
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
      ['step-01-root', 0],
      ['step-02-child', 1],
      ['step-03-grandchild', 2],
      ['step-04-sibling', 1],
    ]);
    expect(markup).toContain('4 steps');
    // The failed sibling's own stored status, which is never replaced by the run's.
    expect(markup).toContain('>FAILED<');
    expect(markup).not.toContain('not on this page');
  });

  it('names every step it renders, in document order', async () => {
    // D2d's alarm. The assertion above reads the `.step-meta` `<code>`, so the whole
    // `.step-name` span can be deleted — every step rendered nameless, a tree of anonymous
    // rows — with it still green. A step id is which step this is; the name is what it did,
    // and it is the only one of the two a reader can act on.
    //
    // Expected: the fixture's four `name` fields in declaration order, which is also the
    // order `buildStepTree` must emit them (root, its first child, that child's child, then
    // the root's second child). Neither the names nor the order is read off the render.
    stubApi({ '/v1/runs/run-tree': { status: 200, body: RUN_WITH_TREE } });

    const markup = await renderPage(RunDetailPage({ params: Promise.resolve({ id: 'run-tree' }) }));

    expect(emittedStepNames(markup)).toStrictEqual([
      'root-step',
      'child-step',
      'grandchild-step',
      'sibling-step',
    ]);
    // The paired negative. `StepBranch` prints this placeholder when a step has no name yet,
    // so its absence is what makes the four names above "these steps' names" rather than
    // "four strings the page happened to emit".
    expect(markup).not.toContain('(no step.started event yet)');
  });

  it('renders the run summary card — the workflow, its version, both ids, the derived status and every instant the API sent', async () => {
    // D2c's and D2e's alarm on the detail page. Until this existed, `RunSummaryCard` could be
    // made to render NOTHING — no workflow name, no version, no run id, no trace id, no
    // status badge, no timestamps — and this file stayed 31/31, because the only thing it
    // said about the card was `toContain('>FAILED<')`, which `sibling-step`'s own badge
    // satisfies from inside the steps card further down.
    //
    // The DoD prose is what fixes the field list: "start a Run with a `workflowVersion` …
    // The Dashboard shows the resulting Run" (MVP_PLAN_V3.md:1599-1602). A Run shown without
    // the field the sentence names is not that Run.
    //
    // Expected values are `RUN_WITH_TREE`'s own fields — the body the stub is answering with
    // — transcribed by hand, in the order `RunSummaryCard` states them.
    stubApi({ '/v1/runs/run-tree': { status: 200, body: RUN_WITH_TREE } });

    const markup = await renderPage(RunDetailPage({ params: Promise.resolve({ id: 'run-tree' }) }));

    expect(summaryCard(markup)).toStrictEqual({
      title: 'checkout-agent',
      rows: [
        ['Status', 'FAILED'],
        ['Workflow version', '1.4.0'],
        ['Run id', 'run-tree'],
        ['Trace id', 'trace-tree'],
        ['Started', '2026-08-21T11:00:00.000Z'],
        ['Completed', '2026-08-21T11:05:00.000Z'],
        ['Received', '2026-08-21T11:00:00.000Z'],
        ['Last event', '2026-08-21T11:05:00.000Z'],
      ],
    });
  });

  it('says so in place of each field the API had no value for, rather than omitting the row', async () => {
    // The paired negative for the card above, and the reason its eight rows mean "these
    // values" instead of "eight rows". A run whose `run.started` event has not arrived has no
    // workflow name and no version (§12 lets any event create the row), and a running one has
    // no `completedAt`. The card must still be the same card — same rows, same order — with
    // the missing values named as missing.
    stubApi({
      '/v1/runs/run-tree': {
        status: 200,
        body: {
          ...RUN_WITH_TREE,
          workflowName: null,
          workflowVersion: null,
          status: 'RUNNING',
          completedAt: null,
          steps: [],
        },
      },
    });

    const markup = await renderPage(RunDetailPage({ params: Promise.resolve({ id: 'run-tree' }) }));

    expect(summaryCard(markup)).toStrictEqual({
      title: '(no run.started event yet)',
      rows: [
        ['Status', 'RUNNING'],
        ['Workflow version', '—'],
        ['Run id', 'run-tree'],
        ['Trace id', 'trace-tree'],
        ['Started', '2026-08-21T11:00:00.000Z'],
        ['Completed', '—'],
        ['Received', '2026-08-21T11:00:00.000Z'],
        ['Last event', '2026-08-21T11:05:00.000Z'],
      ],
    });
  });

  it('marks a step whose parent never arrived instead of promoting it to a root', async () => {
    // §13 gives `parentStepId` no foreign key. Rendering this flush-left and unmarked would
    // assert the step had no parent — a claim about the run the Dashboard cannot make.
    stubApi({
      '/v1/runs/run-tree': {
        status: 200,
        body: {
          ...RUN_WITH_TREE,
          steps: [step({ id: 'step-09-lost', parentStepId: 'never-arrived', name: 'lost-step' })],
        },
      },
    });

    const markup = await renderPage(RunDetailPage({ params: Promise.resolve({ id: 'run-tree' }) }));

    // Same reason as `RUN_WITH_TREE`: id and name differ, so this cannot pass on a page that
    // prints the name where the id belongs.
    expect(emittedSteps(markup)).toStrictEqual([['step-09-lost', 0]]);
    expect(emittedStepNames(markup)).toStrictEqual(['lost-step']);
    expect(markup).toContain('1 step · 1 orphaned');
    expect(markup).toContain('not in this run');
  });

  it('renders the execution timeline — every step on the client clock, in client-clock order, with its bar', async () => {
    // The required view `MVP_PLAN_V3.md:1783` names: "Execution Timeline (client clocks ONLY)".
    // `src/lib/timeline.spec.ts` proves the arithmetic; this proves the page renders it, which
    // is the half D1 and D2 showed nothing was watching.
    //
    // Every expected value is computed by hand from `RUN_ON_THE_CLOCK`'s client instants
    // against its 10s window (11:00:00 → 11:00:10) — never read back off the render:
    //
    //   first-step  0.0s → 2.5s  left  0%  width 25%  2.500s
    //   late-step   5.0s → 7.5s  left 50%  width 25%  2.500s
    //
    // The order is the client clock's and is the REVERSE of the fixture's declaration order,
    // which is what the Steps card renders. Both orders are on the page and each says which
    // it is.
    stubApi({ '/v1/runs/run-clock': { status: 200, body: RUN_ON_THE_CLOCK } });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-clock' }) }),
    );
    const card = timelineCard(markup);

    expect(card.title).toBe('Execution timeline · 1 with no client clock');
    expect(card.runDuration).toBe('10.000s');
    expect(card.window).toBe('2026-08-21T11:00:00.000Z → 2026-08-21T11:00:10.000Z');
    expect(card.rows).toStrictEqual([
      { name: 'first-step', mark: '', duration: '2.500s', bar: 'left:0%;width:25%' },
      { name: 'late-step', mark: '', duration: '2.500s', bar: 'left:50%;width:25%' },
    ]);
    // The paired negative, and the alarm for the rule the whole card exists to keep
    // (`MVP_PLAN_V3.md:493`): the server clocks in this fixture are 09:00 and 19:00, so their
    // absence from the card is what makes the window above "the client's" rather than "a
    // window". `receivedAt` is still on the page — the summary card states it — so this is
    // scoped to the card, not to the document.
    expect(card.window).not.toContain('19:00');
    expect(card.window).not.toContain('09:00');
  });

  it('lists a step carrying no client clock instead of dropping it off the page', async () => {
    // §12 lets any event create a Step row, so a step with neither `startedAt` nor
    // `completedAt` is an ordinary shape. It cannot be placed on a client-clock axis without
    // inventing a position for it — and a timeline that silently drops it renders two of three
    // steps and looks exactly like a run that had two.
    stubApi({ '/v1/runs/run-clock': { status: 200, body: RUN_ON_THE_CLOCK } });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-clock' }) }),
    );

    expect(timelineCard(markup).unplaced).toStrictEqual(['step-99-clockless']);
    expect(markup).toContain('cannot be placed on this axis');
    // The count alarm's own paired negative: it must be silent on a page that accounted for
    // every step, or its firing elsewhere would mean nothing.
    expect(markup).not.toContain('on neither the axis nor the unplaced list');
  });

  it('marks a bar whose interval the run never observed, rather than drawing it as a measurement', async () => {
    // Three degenerate shapes, each drawn and each marked. Expected geometry, by hand, against
    // the same 10s window:
    //
    //   open-step      5.0s → (no completion)  left 50%  width 50%  — bar runs to the window's end
    //   end-only-step  7.5s (completion only)  left 75%  width  0%  — no interval was observed
    //
    // A zero-width bar with no mark is indistinguishable from an instantaneous step, which is
    // a claim about the run nobody made.
    stubApi({
      '/v1/runs/run-clock': {
        status: 200,
        body: {
          ...RUN_ON_THE_CLOCK,
          steps: [
            timedStep({
              id: 'step-open',
              name: 'open-step',
              startedAt: '2026-08-21T11:00:05.000Z',
            }),
            timedStep({
              id: 'step-end-only',
              name: 'end-only-step',
              completedAt: '2026-08-21T11:00:07.500Z',
            }),
          ],
        },
      },
    });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-clock' }) }),
    );

    expect(timelineCard(markup).rows).toStrictEqual([
      {
        name: 'open-step',
        mark: 'running · no completion yet',
        duration: '—',
        bar: 'left:50%;width:50%',
      },
      {
        name: 'end-only-step',
        mark: 'completed before any start · duration unknown',
        duration: '—',
        bar: 'left:75%;width:0%',
      },
    ]);
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

    // ADR 0014 decision 2 added a second fetch (the Ingestion Health card's dropped-event
    // count, `GET /v1/runs/:id/summary` — not stubbed here, so it fails, harmlessly, the
    // same way it does whenever this suite does not care about that row) — encoded the same
    // way as the first.
    expect(asked).toStrictEqual(['/v1/runs/run%2Ftree', '/v1/runs/run%2Ftree/summary']);
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

/**
 * The five remaining Run Explorer views — Decisions, Model Calls, Tool Calls, Errors and
 * Ingestion Health (`MVP_PLAN_V3.md:1785-1789`).
 *
 * ## Why the fixtures below lead with the empty shapes
 *
 * `CLAUDE.md` ## Product claims: "write the negative fixtures before the positive path".
 * These five cards render four `.optional()` collections, and the failure mode is not a
 * missing row — it is a card that answers a question the API never answered. `entityKindOf`
 * returns `null` for all five Phase 4 event types today, so `GET /v1/runs/:id` carries
 * `decisions: []` at best and the field not at all at worst; a page that prints "0 decisions"
 * over either is asserting something about the agent from a gap in the platform.
 *
 * `RUN_WITH_TREE` above is the *absent* fixture and is reused here unchanged: it is typed
 * `satisfies RunDetailView` while naming none of the four collections, which is also one of
 * the three places in the repo where that optionality is pinned at compile time. Do not add
 * collections to it.
 */
const RUN_WITH_TELEMETRY = {
  id: 'run-telemetry',
  traceId: 'trace-telemetry',
  workflowName: 'checkout-agent',
  workflowVersion: '1.4.0',
  status: 'FAILED',
  startedAt: '2026-08-21T11:00:00.000Z',
  completedAt: '2026-08-21T11:00:10.000Z',
  receivedAt: '2026-08-21T19:00:00.000Z',
  lastEventAt: '2026-08-21T19:00:00.000Z',
  metadata: null,
  steps: [],
  decisions: [
    {
      id: 'decision-01-strategy',
      runId: 'run-telemetry',
      stepId: 'step-01',
      // §29's execution strategy is "an ordinary Decision" — MVP_PLAN_V3.md:641. Its evidence
      // is `rawContext`, "the awarenessContext object", and the Decisions view is required to
      // show it: "strategy evidence per §29".
      decisionType: 'execution_strategy',
      contextKey: 'batch:small',
      contextKeyVersion: 'v1',
      rawContext: { fanOut: 3, sharedState: false },
      availableOptions: ['sequential', 'parallel'],
      selectedOption: 'parallel',
      outcome: 'SUCCESS',
      outcomeAttestedBy: 'CALLER',
      outcomeObservedAt: '2026-08-21T11:00:09.000Z',
      createdAt: '2026-08-21T11:00:01.000Z',
    },
    {
      // §14's attestation-first row: an attestation arrived for a `decisionId` nothing had
      // recorded, and "is accepted and stored, not rejected". Everything the record event
      // would have written is null, and the card has to be able to say so rather than render
      // five blanks that read as a rendering fault.
      id: 'decision-02-orphan-attestation',
      runId: 'run-telemetry',
      stepId: null,
      decisionType: null,
      contextKey: null,
      contextKeyVersion: null,
      rawContext: null,
      availableOptions: null,
      selectedOption: null,
      outcome: 'FAILURE',
      outcomeAttestedBy: 'UNKNOWN',
      outcomeObservedAt: '2026-08-21T11:00:08.000Z',
      createdAt: '2026-08-21T11:00:08.000Z',
    },
  ],
  modelCalls: [
    {
      id: 'call-01-complete',
      runId: 'run-telemetry',
      stepId: 'step-01',
      provider: 'anthropic',
      model: 'claude-opus-4',
      latencyMs: 1200,
      inputTokens: 1500,
      outputTokens: 240,
      status: 'ok',
      metadata: null,
      createdAt: '2026-08-21T11:00:02.000Z',
    },
    {
      // §13 marks exactly the two token fields optional. `run-view.ts`: a `0` here "would read
      // as 'this call used no tokens' — a measurement the platform never received."
      id: 'call-02-no-usage',
      runId: 'run-telemetry',
      stepId: 'step-01',
      provider: 'openai',
      model: 'gpt-5',
      latencyMs: 800,
      inputTokens: null,
      outputTokens: null,
      status: 'error',
      metadata: null,
      createdAt: '2026-08-21T11:00:03.000Z',
    },
  ],
  toolCalls: [
    {
      // The DoD line "A 1MB tool output is truncated and flagged". `outputBytes` is the size
      // before §15's cap, so 1,048,576 is what the reader must see — not the 32KB that
      // survived, and not the length of whatever `output` renders as.
      id: 'tool-01-truncated',
      runId: 'run-telemetry',
      stepId: 'step-01',
      toolName: 'fetch_ledger',
      input: { accountId: 'acct-9' },
      output: { rows: 'the first 32KB of a very long answer' },
      inputTruncated: false,
      outputTruncated: true,
      inputBytes: 22,
      outputBytes: 1_048_576,
      startedAt: '2026-08-21T11:00:04.000Z',
      completedAt: '2026-08-21T11:00:05.000Z',
      durationMs: 1000,
      success: true,
      error: null,
    },
    {
      // A completion that precedes its start, and a negative duration to go with it. The
      // validator confirmed `durationMs` is passed through and not recomputed, so a backwards
      // client clock reaches this component intact and must arrive at the reader intact too.
      id: 'tool-02-backwards',
      runId: 'run-telemetry',
      stepId: 'step-01',
      toolName: 'charge_card',
      input: { amount: 40 },
      output: null,
      inputTruncated: false,
      outputTruncated: false,
      inputBytes: 14,
      outputBytes: 0,
      startedAt: '2026-08-21T11:00:07.000Z',
      completedAt: '2026-08-21T11:00:06.000Z',
      durationMs: -1000,
      success: false,
      error: 'card declined',
    },
  ],
  errors: [
    {
      id: 'error-01',
      runId: 'run-telemetry',
      stepId: 'step-01',
      type: 'ToolTimeout',
      message: 'charge_card did not answer within 30s',
      metadata: { attempt: 2 },
      createdAt: '2026-08-21T11:00:07.500Z',
    },
  ],
} satisfies RunDetailView;

/**
 * The same run, answered with all four collections **present and empty**.
 *
 * Four characters apart from `RUN_WITH_TREE` on the wire and the opposite meaning: here the
 * API answered "none", there it answered nothing at all. Every card below is asserted against
 * both, and the two must not produce the same sentence.
 */
const RUN_WITH_EMPTY_TELEMETRY = {
  ...RUN_WITH_TELEMETRY,
  decisions: [],
  modelCalls: [],
  toolCalls: [],
  errors: [],
} satisfies RunDetailView;

/**
 * One card of the run detail page, read back out of the markup the way a reader sees it.
 *
 * Located by its heading, like `timelineCard` and for the same reason: five new cards are
 * being added below an existing three, and any helper that found a card by position would
 * silently retarget onto its neighbour the first time the order changed.
 *
 * The card is sliced at the *next* `<section`, not at `</section>`: these cards nest elements
 * and a lazy `[\s\S]*?</section>` stops at the first inner close. The slice is deliberately
 * generous in the other direction — if a card emits nothing, the slice runs into the following
 * card and the assertions read that card's rows, which is a mismatch rather than a pass.
 */
function telemetryCard(
  markup: string,
  heading: string,
): {
  title: string;
  notes: string[];
  rows: { name: string; marks: string[]; tag: string; fields: [string, string][] }[];
  ids: string[];
} {
  const card = cardSection(markup, heading);

  return {
    title: stripTags(/<h2 class="card-title">([\s\S]*?)<\/h2>/.exec(card)?.[1] ?? '(no title)'),
    notes: [...card.matchAll(/<p class="note-inline[^"]*">([\s\S]*?)<\/p>/g)].map((m) =>
      stripTags(m[1] ?? ''),
    ),
    rows: [...card.matchAll(/<li class="telemetry-row">([\s\S]*?)<\/li>/g)].map((match) => {
      const row = match[1] ?? '';

      return {
        name: /<span class="telemetry-name">([^<]*)<\/span>/.exec(row)?.[1] ?? '(no name element)',
        marks: [
          ...row.matchAll(/<span class="placement placement-[a-z-]+">([\s\S]*?)<\/span>/g),
        ].map((m) => stripTags(m[1] ?? '')),
        tag: stripTags(/<span class="telemetry-tag[^"]*">([\s\S]*?)<\/span>/.exec(row)?.[1] ?? ''),
        fields: [
          ...row.matchAll(
            /<div class="field"><span class="field-label">([^<]*)<\/span>([\s\S]*?)<\/div>/g,
          ),
        ].map((m): [string, string] => [m[1] ?? '', stripTags(m[2] ?? '')]),
      };
    }),
    ids: [...card.matchAll(/<div class="telemetry-meta"><code>([^<]*)<\/code>/g)].map(
      (m) => m[1] ?? '',
    ),
  };
}

/**
 * The `<pre>` payload blocks of a card, each with the label above it.
 *
 * The body is entity-decoded, unlike everywhere else in this file. A payload is JSON and JSON
 * is mostly double quotes, which React escapes to `&quot;` in a text node — so an assertion
 * written against the raw markup would be a claim about React's escaping rather than about
 * the payload the reader sees. `stripTags` is left alone: every other assertion here is about
 * prose, where decoding would hide a page that emitted a literal `&amp;lt;` at a reader.
 */
function payloadsOf(markup: string, heading: string): [string, string][] {
  return [
    ...cardSection(markup, heading).matchAll(
      /<span class="payload-label">([\s\S]*?)<\/span>[\s\S]*?<pre class="payload-body">([\s\S]*?)<\/pre>/g,
    ),
  ].map((m): [string, string] => [
    decodeEntities(stripTags(m[1] ?? '')),
    decodeEntities(stripTags(m[2] ?? '')),
  ]);
}

/** The five characters React escapes in a text node, back to what the reader sees. */
function decodeEntities(text: string): string {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function cardSection(markup: string, heading: string): string {
  const start = markup.indexOf(`<h2 class="card-title">${heading}`);
  if (start === -1) return `(no ${heading} card on the page)`;

  const rest = markup.slice(start);
  const next = rest.indexOf('<section class="card">');

  return next === -1 ? rest : rest.slice(0, next);
}

describe('GET /runs/[id] — the Phase 4 collections, and the difference between none and unanswered', () => {
  it('says a collection the response never carried is unanswered, and never that there were none', async () => {
    // The governing rule for this whole card set — `CLAUDE.md` ## Product claims. An empty
    // collection means "not answerable", not "none happened", and today that is the ONLY
    // shape a real deployment produces: `entityKindOf` returns null for all five Phase 4
    // event types, so nothing is stored and nothing is returned.
    stubApi({ '/v1/runs/run-tree': { status: 200, body: RUN_WITH_TREE } });

    const markup = await renderPage(RunDetailPage({ params: Promise.resolve({ id: 'run-tree' }) }));

    for (const [heading, plural] of [
      ['Decisions', 'decisions'],
      ['Model calls', 'model calls'],
      ['Tool calls', 'tool calls'],
      ['Errors', 'errors'],
    ] as const) {
      const card = telemetryCard(markup, heading);

      expect(card.rows).toStrictEqual([]);
      expect(card.notes).toContain(
        `This response did not carry ${plural}. That is not a claim that none occurred — the API did not answer the question.`,
      );
      // The paired negative, per card: the sentence the API DID answer must not appear.
      expect(card.notes).not.toContain(`The API reported no ${plural} for this run.`);
    }
  });

  it('says the API reported none when the API actually reported none — a different sentence', async () => {
    stubApi({ '/v1/runs/run-telemetry': { status: 200, body: RUN_WITH_EMPTY_TELEMETRY } });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );

    for (const [heading, plural] of [
      ['Decisions', 'decisions'],
      ['Model calls', 'model calls'],
      ['Tool calls', 'tool calls'],
      ['Errors', 'errors'],
    ] as const) {
      const card = telemetryCard(markup, heading);

      expect(card.rows).toStrictEqual([]);
      expect(card.notes).toContain(`The API reported no ${plural} for this run.`);
      expect(card.notes).not.toContain(
        `This response did not carry ${plural}. That is not a claim that none occurred — the API did not answer the question.`,
      );
    }
  });

  it('renders every decision with its contextKey, its options and who attested the outcome', async () => {
    // "Decisions (contextKey visible; strategy evidence per §29)" — MVP_PLAN_V3.md:1785.
    // Every expected value below is the fixture's own field, transcribed by hand.
    stubApi({ '/v1/runs/run-telemetry': { status: 200, body: RUN_WITH_TELEMETRY } });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );
    const card = telemetryCard(markup, 'Decisions');

    expect(card.ids).toStrictEqual(['decision-01-strategy', 'decision-02-orphan-attestation']);
    expect(card.rows[0]).toStrictEqual({
      name: 'execution_strategy',
      marks: [],
      tag: 'SUCCESS',
      fields: [
        ['contextKey', 'batch:small'],
        ['contextKeyVersion', 'v1'],
        ['Options', 'sequential, parallel'],
        ['Selected', 'parallel'],
        ['Outcome attested by', 'CALLER'],
        ['Outcome observed', '2026-08-21T11:00:09.000Z'],
        ['Step', 'step-01'],
      ],
    });
  });

  it('marks a decision with no contextKey as excluded from aggregation rather than leaving it blank', async () => {
    // §14: "If a caller supplies no `contextKey`, the decision is stored but **excluded from
    // aggregation**." A reader who cannot see the null cannot tell a decision that will never
    // be grouped from one that will — `run-view.ts` says exactly that, and this is its alarm.
    stubApi({ '/v1/runs/run-telemetry': { status: 200, body: RUN_WITH_TELEMETRY } });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );
    const card = telemetryCard(markup, 'Decisions');

    expect(card.rows[1]).toStrictEqual({
      name: '(no decision.recorded event — attestation only)',
      marks: [
        'no contextKey · stored, excluded from aggregation',
        'attested for an id nothing recorded',
      ],
      tag: 'FAILURE',
      fields: [
        ['contextKey', 'none — excluded from aggregation'],
        ['contextKeyVersion', '—'],
        ['Options', '—'],
        ['Selected', '—'],
        ['Outcome attested by', 'UNKNOWN'],
        ['Outcome observed', '2026-08-21T11:00:08.000Z'],
        ['Step', '—'],
      ],
    });
  });

  it('shows the strategy evidence a §29 decision was taken on, not just the option it picked', async () => {
    // MVP_PLAN_V3.md:641-651 — `rawContext` is "the awarenessContext object". Without it the
    // Decisions view shows which strategy was chosen and nothing about why, which is the half
    // §29 calls evidence.
    stubApi({ '/v1/runs/run-telemetry': { status: 200, body: RUN_WITH_TELEMETRY } });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );

    expect(payloadsOf(markup, 'Decisions')).toStrictEqual([
      [
        'rawContext — the evidence this decision was taken on (§29)',
        '{"fanOut":3,"sharedState":false}',
      ],
    ]);
  });

  it('renders each model call, reporting an unreported token count as unreported and not as zero', async () => {
    stubApi({ '/v1/runs/run-telemetry': { status: 200, body: RUN_WITH_TELEMETRY } });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );
    const card = telemetryCard(markup, 'Model calls');

    expect(card.ids).toStrictEqual(['call-01-complete', 'call-02-no-usage']);
    expect(card.rows).toStrictEqual([
      {
        name: 'anthropic / claude-opus-4',
        marks: [],
        tag: '1200ms',
        fields: [
          ['Input tokens', '1,500'],
          ['Output tokens', '240'],
          ['Status', 'ok'],
          ['Step', 'step-01'],
          ['Recorded', '2026-08-21T11:00:02.000Z'],
        ],
      },
      {
        name: 'openai / gpt-5',
        marks: ['no token usage reported'],
        tag: '800ms',
        fields: [
          ['Input tokens', 'not reported'],
          ['Output tokens', 'not reported'],
          ['Status', 'error'],
          ['Step', 'step-01'],
          ['Recorded', '2026-08-21T11:00:03.000Z'],
        ],
      },
    ]);
  });

  it('flags a truncated tool payload with the size it had before it was cut', async () => {
    // "Tool Calls (truncation flagged)" — MVP_PLAN_V3.md:1787 — and the DoD line about a 1MB
    // output. §15's point is that truncation loses the payload and not the measurement.
    stubApi({ '/v1/runs/run-telemetry': { status: 200, body: RUN_WITH_TELEMETRY } });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );
    const card = telemetryCard(markup, 'Tool calls');

    expect(card.ids).toStrictEqual(['tool-01-truncated', 'tool-02-backwards']);
    expect(card.rows[0]?.name).toBe('fetch_ledger');
    expect(card.rows[0]?.marks).toStrictEqual(['succeeded']);
    // The truncation flag travels with the payload it is about, never in a summary line
    // elsewhere: §15's whole point is that a payload shown without its flag reads as complete.
    expect(payloadsOf(markup, 'Tool calls').slice(0, 2)).toStrictEqual([
      ['Input · 22 bytes', '{"accountId":"acct-9"}'],
      [
        'Output · truncated · 1,048,576 bytes before the cap',
        '{"rows":"the first 32KB of a very long answer"}',
      ],
    ]);
  });

  it('reports a tool call whose client clock ran backwards instead of tidying it into agreement', async () => {
    stubApi({ '/v1/runs/run-telemetry': { status: 200, body: RUN_WITH_TELEMETRY } });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );
    const card = telemetryCard(markup, 'Tool calls');

    expect(card.rows[1]).toStrictEqual({
      name: 'charge_card',
      marks: [
        'failed',
        'reversed client clock · completion precedes start',
        'negative duration as reported by the caller',
      ],
      // The caller's own number, verbatim and unclamped. A `0ms` here would be the Dashboard
      // adjudicating a measurement it has no basis to correct.
      tag: '-1000ms',
      fields: [
        ['Started', '2026-08-21T11:00:07.000Z'],
        ['Completed', '2026-08-21T11:00:06.000Z'],
        ['Error', 'card declined'],
        ['Step', 'step-01'],
      ],
    });
  });

  it('renders reported errors as the agent’s failures, not as ingestion rejections', async () => {
    // `run-view.ts`, ErrorView: these are errors "the *instrumented system* reported as
    // telemetry, not an ingestion rejection — rejections are `INGEST_ERROR_CODES` on the
    // ingest response and never become rows. A consumer that showed these under a heading
    // like 'ingestion errors' would be reporting the platform's health from the agent's
    // failures." This asserts the page does not make that mistake.
    stubApi({ '/v1/runs/run-telemetry': { status: 200, body: RUN_WITH_TELEMETRY } });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );
    const card = telemetryCard(markup, 'Errors');

    expect(card.ids).toStrictEqual(['error-01']);
    expect(card.rows[0]?.name).toBe('ToolTimeout');
    expect(card.rows[0]?.fields).toStrictEqual([
      ['Message', 'charge_card did not answer within 30s'],
      ['Step', 'step-01'],
      ['Recorded', '2026-08-21T11:00:07.500Z'],
    ]);
    expect(card.notes).toContain(
      'Reported by the instrumented system as telemetry. These are the agent’s own failures, not ingestion rejections — a rejected event never becomes a row.',
    );
  });

  it('says the dropped-event count is unreported, and why, rather than printing a zero', async () => {
    // "Ingestion Health (dropped events, if any)" — MVP_PLAN_V3.md:1789. §16's drop counters
    // are client-side SDK state; no envelope field, no ingest-response field and no column
    // carries them to the platform, so `GET /v1/runs/:id` has nothing to report and
    // `run-summary.ts` answers `null` on the one endpoint that names the field at all.
    // A `0` here would be the green that lies: "no events were dropped", asserted from the
    // absence of a signal the platform never receives.
    stubApi({ '/v1/runs/run-telemetry': { status: 200, body: RUN_WITH_TELEMETRY } });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );

    expect(labelledRow(markup, 'Dropped telemetry events')).toBe('not reported');
    expect(telemetryCard(markup, 'Ingestion health').notes).toContain(
      '§16’s drop counters are client-side SDK state. No envelope field, no ingest response and no column carries them to the platform, so no drop count has been reported for this run. That is not a claim that none were dropped.',
    );
  });

  // ADR 0014 decision 2: once a batch has reported a drop count, the summary endpoint
  // answers it and the card must show the real number instead of the blanket "not reported".
  it('shows the real dropped-event count once the run summary reports one', async () => {
    stubApi({
      '/v1/runs/run-telemetry': { status: 200, body: RUN_WITH_TELEMETRY },
      '/v1/runs/run-telemetry/summary': {
        status: 200,
        body: { runId: 'run-telemetry', droppedTelemetryEventCount: 17 },
      },
    });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );

    expect(labelledRow(markup, 'Dropped telemetry events')).toBe('17');
    // The "not reported" note only makes sense over an absence — it must not sit next to a
    // real number telling the reader the opposite.
    expect(telemetryCard(markup, 'Ingestion health').notes).not.toContain(
      '§16’s drop counters are client-side SDK state. No envelope field, no ingest response and no column carries them to the platform, so no drop count has been reported for this run. That is not a claim that none were dropped.',
    );
  });

  it('shows a real reported zero as 0, never as "not reported"', async () => {
    stubApi({
      '/v1/runs/run-telemetry': { status: 200, body: RUN_WITH_TELEMETRY },
      '/v1/runs/run-telemetry/summary': {
        status: 200,
        body: { runId: 'run-telemetry', droppedTelemetryEventCount: 0 },
      },
    });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );

    expect(labelledRow(markup, 'Dropped telemetry events')).toBe('0');
  });

  it('reports what the telemetry lost — truncation, token gaps and self-contradicting clocks', async () => {
    stubApi({ '/v1/runs/run-telemetry': { status: 200, body: RUN_WITH_TELEMETRY } });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );

    expect(labelledRow(markup, 'Tool inputs truncated')).toBe('0');
    expect(labelledRow(markup, 'Tool outputs truncated')).toBe('1');
    expect(labelledRow(markup, 'Payload bytes lost to truncation')).toBe('1,048,576 bytes');
    expect(labelledRow(markup, 'Tool calls with a self-contradicting clock')).toBe('1');
    expect(labelledRow(markup, 'Model calls missing an input token count')).toBe('1');
    expect(labelledRow(markup, 'Model calls missing an output token count')).toBe('1');
  });

  it('reports every loss measure as unanswered when its collection was never carried', async () => {
    // The nullable-count rule of `lib/run-telemetry.ts`, at the page. A health card printing
    // "0 truncated" over a response with no tool calls asserts a clean run from a signal that
    // never arrived — the same manufactured absence as the dropped-event count above.
    stubApi({ '/v1/runs/run-tree': { status: 200, body: RUN_WITH_TREE } });

    const markup = await renderPage(RunDetailPage({ params: Promise.resolve({ id: 'run-tree' }) }));

    expect(labelledRow(markup, 'Tool inputs truncated')).toBe('not reported');
    expect(labelledRow(markup, 'Payload bytes lost to truncation')).toBe('not reported');
    expect(labelledRow(markup, 'Tool calls with a self-contradicting clock')).toBe('not reported');
    expect(labelledRow(markup, 'Model calls missing an input token count')).toBe('not reported');
    expect(labelledRow(markup, 'Dropped telemetry events')).toBe('not reported');
  });

  it('states which of the four collections the API answered at all', async () => {
    // A run with only errors — one of the negative shapes this node was told to cover. Three
    // collections unanswered, one answered with a row, and the card says which is which.
    stubApi({
      '/v1/runs/run-telemetry': {
        status: 200,
        body: { ...RUN_WITH_TREE, id: 'run-telemetry', errors: RUN_WITH_TELEMETRY.errors },
      },
    });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );

    expect(labelledRow(markup, 'Decisions')).toBe('not answered by this response');
    expect(labelledRow(markup, 'Model calls')).toBe('not answered by this response');
    expect(labelledRow(markup, 'Tool calls')).toBe('not answered by this response');
    expect(labelledRow(markup, 'Errors')).toBe('1');
  });

  it('renders all eight required views, in the order the plan lists them', async () => {
    // MVP_PLAN_V3.md:1779-1789. The oracle false green this node was reopened for was a probe
    // that went green on three of these eight; the alarm for it is the list itself, read off
    // the rendered page in document order rather than counted.
    stubApi({ '/v1/runs/run-telemetry': { status: 200, body: RUN_WITH_TELEMETRY } });

    const markup = await renderPage(
      RunDetailPage({ params: Promise.resolve({ id: 'run-telemetry' }) }),
    );

    expect(
      [...markup.matchAll(/<h2 class="card-title">([\s\S]*?)<\/h2>/g)].map(
        (m) => stripTags(m[1] ?? '').split(' · ')[0],
      ),
    ).toStrictEqual([
      'checkout-agent',
      'Execution timeline',
      'Steps',
      'Decisions',
      'Model calls',
      'Tool calls',
      'Errors',
      'Ingestion health',
    ]);
  });
});
