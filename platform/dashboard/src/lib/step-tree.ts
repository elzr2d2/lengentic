import type { StepView } from '@lengentic/shared/read';

/**
 * Turns the flat `RunDetailView.steps` array into the tree the Run detail page renders.
 *
 * The API deliberately does not build this tree — see the note on `RunDetailViewSchema`.
 * `parentStepId` carries **no foreign key** (§13) and step ids are client-generated, so the
 * array is not guaranteed to be a well-formed forest. Every one of the malformed shapes
 * below is reachable from a buggy or partially-delivered client, and the failure mode that
 * matters is the silent one: a naive "attach each child to its parent, then collect the
 * nodes whose parent is null" pass drops every step it cannot place, and a Run detail page
 * that renders four of seven steps looks exactly like a Run that had four steps.
 *
 * So placement is total: **every input step appears exactly once in the output**, and the
 * reason it sits where it does is on the node, for the page to show.
 *
 * Totality is stated over *distinct step ids*, which is the precondition the read path
 * already guarantees: `Step.id` is a global primary key (`platform/api/prisma/schema.prisma`),
 * and `RunDetailView.steps` is built from one `step.findMany({ where: { runId } })`, so no
 * caller in the system can hand this function two steps sharing an id. Where it matters:
 * `placed` is keyed by `step.id`, so `[{id:'a',parent:null}, {id:'a',parent:'a'}]` yields one
 * node from two inputs, and the page's own count alarm would then fire on a Dashboard defect
 * that is not one. Left keyed by id rather than by array index deliberately — the precondition
 * holds for every present and planned caller (Phase 6 mock scenarios reach the Dashboard
 * through the SDK and the database like any other run, not by hand-building `StepView[]`), and
 * writing the precondition down is cheaper than defending against a shape the schema makes
 * unreachable. A future caller that constructs `StepView[]` outside the DB read path
 * invalidates this note; re-keying `placed` by array index is the fix if that day comes.
 */
export type StepPlacement =
  /** `parentStepId === null` — a root step, which §13 makes a deliberate signal. */
  | 'root'
  /** Attached under the parent it names, which is present in the same array. */
  | 'nested'
  /**
   * Names a parent the array never delivered. Rendered at top level *and marked*: promoting
   * it silently to `root` would assert the step had no parent, which is a claim about the
   * run the Dashboard cannot make — the parent may simply not have been ingested yet.
   */
  | 'orphaned'
  /**
   * Its parent chain never reaches a root: the step is part of a `parentStepId` cycle, or
   * descends from one. Distinct from `orphaned` — every parent in the chain is present, so
   * nothing is missing; the chain is impossible. Rendered at top level and marked, for the
   * same reason.
   */
  | 'cycle';

export interface StepNode {
  readonly step: StepView;
  readonly placement: StepPlacement;
  readonly children: readonly StepNode[];
}

/**
 * Preserves the server's ordering (`receivedAt asc, id asc`) among siblings and among the
 * top-level nodes, so the page is stable across reloads without re-sorting anything.
 */
export function buildStepTree(steps: readonly StepView[]): readonly StepNode[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const childrenByParent = new Map<string, StepView[]>();
  const topLevel: { step: StepView; placement: StepPlacement }[] = [];

  for (const step of steps) {
    const parentId = step.parentStepId;

    if (parentId === null) {
      topLevel.push({ step, placement: 'root' });
      continue;
    }

    if (!byId.has(parentId)) {
      topLevel.push({ step, placement: 'orphaned' });
      continue;
    }

    const siblings = childrenByParent.get(parentId);
    if (siblings === undefined) {
      childrenByParent.set(parentId, [step]);
    } else {
      siblings.push(step);
    }
  }

  const placed = new Set<string>();
  const nodes = topLevel.map(({ step, placement }) =>
    descend(step, placement, childrenByParent, placed),
  );

  // Anything still unplaced descends from a `parentStepId` cycle, so no root can reach it.
  // The first such step in server order becomes the visible entry point and its subtree
  // follows it; `placed` stops the walk from going round for ever. The emptiness check is
  // re-read on every iteration on purpose — each `descend` places a whole subtree, and a
  // list filtered up front would re-emit those members as top-level nodes as well.
  const stranded: StepNode[] = [];
  for (const step of steps) {
    if (placed.has(step.id)) continue;

    stranded.push(descend(step, 'cycle', childrenByParent, placed));
  }

  return [...nodes, ...stranded];
}

function descend(
  step: StepView,
  placement: StepPlacement,
  childrenByParent: ReadonlyMap<string, readonly StepView[]>,
  placed: Set<string>,
): StepNode {
  placed.add(step.id);

  const children = (childrenByParent.get(step.id) ?? [])
    .filter((child) => !placed.has(child.id))
    .map((child) => descend(child, 'nested', childrenByParent, placed));

  return { step, placement, children };
}

/** How many steps the tree actually renders — the invariant the page states out loud. */
export function countStepNodes(nodes: readonly StepNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countStepNodes(node.children), 0);
}

/** How many nodes carry one placement — what the Steps header reports as "N orphaned". */
export function countPlacement(nodes: readonly StepNode[], placement: StepPlacement): number {
  return nodes.reduce(
    (total, node) =>
      total + (node.placement === placement ? 1 : 0) + countPlacement(node.children, placement),
    0,
  );
}

/**
 * The anomaly clause the Steps header states out loud, or `''` when the tree is well formed.
 *
 * Both malformed placements are reported, not just orphans. `StepPlacement` gives `cycle` and
 * `orphaned` the same rationale — rendered at top level *and marked*, because promoting either
 * silently would assert something about the run the Dashboard cannot know — so a header that
 * counts one and omits the other tells a reader scanning "12 steps · 2 orphaned" that
 * orphans are the only anomaly on a run that also contains an impossible parent chain.
 *
 * Kept out of the page component so it can be proven in a node environment: the seam is the
 * sentence, not the JSX around it.
 */
export function describeStepAnomalies(nodes: readonly StepNode[]): string {
  const orphaned = countPlacement(nodes, 'orphaned');
  const cycle = countPlacement(nodes, 'cycle');

  return (
    (orphaned > 0 ? ` · ${String(orphaned)} orphaned` : '') +
    (cycle > 0 ? ` · ${String(cycle)} in a parent cycle` : '')
  );
}
