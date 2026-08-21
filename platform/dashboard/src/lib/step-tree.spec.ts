import { describe, expect, it } from 'vitest';
import type { StepView } from '@lengentic/shared/read';
import {
  buildStepTree,
  countPlacement,
  countStepNodes,
  describeStepAnomalies,
  type StepNode,
} from './step-tree';

/**
 * Seam under test: `buildStepTree`, a pure function (see its doc comment). Confirmed with
 * the Coordinator's work packet for `p2.dashboard-runs`, re-dispatched: this is the one
 * seam this lane's allowed_paths (`platform/dashboard/src/**`) can prove without widening
 * anything, and it is where the packet's stated invariant lives —
 * "placement is total: every input step appears exactly once in the output" — and the
 * failure mode it names: a naive attach-then-collect pass drops steps it cannot place, and
 * a Run detail page rendering 4 of 7 steps looks exactly like a run that had 4 steps.
 *
 * `buildStepTree` only reads `id` and `parentStepId` off each step; the rest of `StepView`
 * is padding required by the type. `receivedAt` is set to increasing ISO instants in input
 * order, matching the server's own `receivedAt asc, id asc` — the module claims to preserve
 * that order without re-sorting, so the fixtures below rely on it rather than restate it.
 */

let clock = 0;
function step(id: string, parentStepId: string | null): StepView {
  clock += 1;
  return {
    id,
    runId: 'run-1',
    parentStepId,
    name: id,
    agentName: null,
    type: null,
    status: 'COMPLETED',
    startedAt: null,
    completedAt: null,
    receivedAt: new Date(2026, 0, 1, 0, 0, clock).toISOString(),
    metadata: null,
  };
}

/**
 * Flattens the tree in the order the page renders it — depth-first, children after their
 * parent, top-level nodes (including stranded cycle entry points) in the order
 * `buildStepTree` returns them. Enumerating a tree to check it is unavoidable; this walk
 * computes nothing `buildStepTree` computes — it does not decide placement, it only reads
 * the field already on each node.
 */
function flatten(nodes: readonly StepNode[]): { id: string; placement: string }[] {
  return nodes.flatMap((node) => [
    { id: node.step.id, placement: node.placement },
    ...flatten(node.children),
  ]);
}

/**
 * Every expectation below is a hand-written literal — id/placement pairs in the exact
 * render order — never derived by re-running `buildStepTree` or by re-walking its output
 * with equivalent logic.
 */
describe('buildStepTree', () => {
  it('places a root and its nested descendants, in server order', () => {
    const input = [step('a', null), step('b', 'a'), step('c', 'b')];

    const tree = buildStepTree(input);

    expect(flatten(tree)).toEqual([
      { id: 'a', placement: 'root' },
      { id: 'b', placement: 'nested' },
      { id: 'c', placement: 'nested' },
    ]);
  });

  it('nests a child that arrives before its parent in the array', () => {
    const input = [step('b', 'a'), step('a', null)];

    const tree = buildStepTree(input);

    expect(flatten(tree)).toEqual([
      { id: 'a', placement: 'root' },
      { id: 'b', placement: 'nested' },
    ]);
  });

  it('marks a step naming an absent parent as orphaned, not root', () => {
    const input = [step('x', 'ghost')];

    const tree = buildStepTree(input);

    expect(flatten(tree)).toEqual([{ id: 'x', placement: 'orphaned' }]);
  });

  it("keeps an orphan's own subtree nested beneath it", () => {
    const input = [step('x', 'ghost'), step('y', 'x')];

    const tree = buildStepTree(input);

    expect(flatten(tree)).toEqual([
      { id: 'x', placement: 'orphaned' },
      { id: 'y', placement: 'nested' },
    ]);
  });

  it('preserves top-level server order across a root and an orphan side by side', () => {
    const input = [step('r', null), step('x', 'ghost'), step('k', 'r')];

    const tree = buildStepTree(input);

    expect(flatten(tree)).toEqual([
      { id: 'r', placement: 'root' },
      { id: 'k', placement: 'nested' },
      { id: 'x', placement: 'orphaned' },
    ]);
  });

  it('preserves sibling order among multiple children of the same parent', () => {
    const input = [step('p', null), step('second', 'p'), step('first', 'p')];

    const tree = buildStepTree(input);

    // 'second' precedes 'first' in the input array, so it must precede it in the output —
    // the module claims to preserve arrival order, not to re-sort by id or name.
    expect(flatten(tree)).toEqual([
      { id: 'p', placement: 'root' },
      { id: 'second', placement: 'nested' },
      { id: 'first', placement: 'nested' },
    ]);
  });

  it('marks a two-step parentStepId cycle as cycle, not orphaned or root', () => {
    const input = [step('a', 'b'), step('b', 'a')];

    const tree = buildStepTree(input);

    expect(flatten(tree)).toEqual([
      { id: 'a', placement: 'cycle' },
      { id: 'b', placement: 'nested' },
    ]);
  });

  it('marks a self-parenting step as cycle', () => {
    const input = [step('a', 'a')];

    const tree = buildStepTree(input);

    expect(flatten(tree)).toEqual([{ id: 'a', placement: 'cycle' }]);
  });

  it('places root, orphaned and cycle shapes together, each labelled distinctly', () => {
    const input = [step('r', null), step('x', 'ghost'), step('a', 'b'), step('b', 'a')];

    const tree = buildStepTree(input);

    expect(flatten(tree)).toEqual([
      { id: 'r', placement: 'root' },
      { id: 'x', placement: 'orphaned' },
      { id: 'a', placement: 'cycle' },
      { id: 'b', placement: 'nested' },
    ]);
  });

  it('is total: every input step id appears exactly once, for any mix of shapes', () => {
    const input = [
      step('r1', null),
      step('r2', null),
      step('n1', 'r1'),
      step('n2', 'n1'),
      step('x', 'ghost'),
      step('y', 'x'),
      step('c1', 'c2'),
      step('c2', 'c1'),
      step('self', 'self'),
    ];
    // Sourced independently of the output: the id set is read straight off the input, not
    // computed by walking `buildStepTree`'s own result.
    const expectedIds = input.map((s) => s.id);

    const tree = buildStepTree(input);
    const renderedIds = flatten(tree).map((n) => n.id);

    expect(renderedIds.sort()).toEqual([...expectedIds].sort());
    expect(new Set(renderedIds).size).toBe(input.length);
    expect(countStepNodes(tree)).toBe(input.length);
  });

  it('reports placement counts for the Steps header across a mixed tree', () => {
    const input = [
      step('r', null),
      step('n', 'r'),
      step('x', 'ghost'),
      step('a', 'b'),
      step('b', 'a'),
    ];

    const tree = buildStepTree(input);

    expect(countPlacement(tree, 'root')).toBe(1);
    expect(countPlacement(tree, 'nested')).toBe(2); // 'n' under 'r', 'b' under 'a'
    expect(countPlacement(tree, 'orphaned')).toBe(1);
    expect(countPlacement(tree, 'cycle')).toBe(1);
  });
});

describe('describeStepAnomalies', () => {
  it('says nothing when every step is placed under a real parent or at a root', () => {
    const tree = buildStepTree([step('r', null), step('n', 'r')]);

    expect(describeStepAnomalies(tree)).toBe('');
  });

  it('reports orphans', () => {
    const tree = buildStepTree([step('r', null), step('x', 'ghost')]);

    expect(describeStepAnomalies(tree)).toBe(' · 1 orphaned');
  });

  it('reports a parent cycle, which the header used to omit while counting orphans', () => {
    // The regression this test exists for: `countPlacement(tree, 'cycle')` was implemented
    // and tested, and the header called it for 'orphaned' only. A reader of "2 steps" on a
    // run whose entire step list is an impossible parent chain was told nothing was wrong.
    const tree = buildStepTree([step('a', 'b'), step('b', 'a')]);

    expect(describeStepAnomalies(tree)).toBe(' · 1 in a parent cycle');
  });

  it('reports both, in the order the header renders them', () => {
    const tree = buildStepTree([
      step('r', null),
      step('n', 'r'),
      step('x', 'ghost'),
      step('a', 'b'),
      step('b', 'a'),
    ]);

    // Sourced from the placement counts the test above already pins independently:
    // 1 orphaned ('x'), 1 cycle ('a'); 'b' is nested beneath 'a' and is not counted twice.
    expect(describeStepAnomalies(tree)).toBe(' · 1 orphaned · 1 in a parent cycle');
  });
});
