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
