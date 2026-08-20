---
name: test-at-seams
description: Write tests that can actually fail — agree the seam first, source the expected value independently, then mutation-check the result. Use before writing any test, and when judging whether an existing test proves anything.
---

# Test At Seams

A test earns its place by being able to go **red** for the right reason. This skill is the
two rules that make that true, and the check that proves it.

`BACKLOG.md` records why this exists: an agent correctly identified a false-positive test,
then authored a replacement with the same defect in a different shape. "Detect false-positive
tests" is a goal. This is the method.

## 1. Agree the seam before writing

A **seam** is the public boundary you observe behaviour at without reaching inside. Tests
live at seams; a test reaching past one breaks on every refactor and proves nothing about
behaviour.

**No test is written at an unconfirmed seam.** Before the first assertion, state the seams
under test and get them confirmed. You cannot test everything — agreeing the seams up front
is how the effort lands on critical paths instead of on every edge case.

Ask it plainly: _what is the public interface here, and which seams should we test?_

When the shape of the interface is itself the question, the `codebase-design` skill holds the
vocabulary.

## 2. Source the expected value independently

The expected value comes from a source that cannot agree with the code by construction:

- a literal from the spec or the plan section,
- a worked example computed by hand,
- a second observable interface.

It never comes from the call that produced the actual, from a value the test itself just
wrote, or from re-running the implementation's own arithmetic.

**One outcome per assertion.** An oracle shaped `if (status === 200) expect a number; else
expect 400` is satisfied by both branches of the behaviour it claims to test. That is not a
contract; it is a description of the sky.

**Drive the code under test.** An input rejected by validation before reaching the code you
mean to cover tests the validator, whatever the test is named.

## 3. Mutation check — the completion criterion

> Would this test still pass if the code under test were deleted?

Answer it by **doing it**. Delete or invert the guard, the branch, the calculation the test
claims to cover. Run the test.

- Test goes **red** → it proves something. Restore the code.
- Test stays **green** → it proves nothing. Restore the code and fix the test.

Do this for tests you wrote in this session, not only for tests you inherited. Authoring the
replacement is exactly where the last false positive got in.

**Frequency is risk-based, not universal.** The mutation check is required for analyzers,
contract changes (`platform/shared/schema/**`), false-green repairs, and anything the packet
marks high-risk. It is skipped for docs, mechanical renames, and config-only changes — and
the skip is stated, never silent.

## Negative fixtures first

Write the failing case before the passing path. For anything that produces a recommendation
or a verdict, the false positive is the failure mode that kills the product — so the fixture
that must produce _no output_ is written first, and its absence of output is asserted.

## Judging a test you did not write

The rules above are how a test is authored. Judging one runs them backwards, plus what only
shows at runtime:

- **Circularity** — expected sourced from the call that produced actual; an assertion on a
  value the test itself just wrote; an assertion true of any response.
- **Superficial** — presence where the business outcome is a value; "no error thrown"
  standing in for "the right thing happened"; a snapshot that passes on wrong data.
- **Determinism** — run it in isolation, then after the rest of the suite. Order dependence,
  reliance on seed data another test mutates, and shared module-level state are findings.
- **Async honesty** — does the wait land on a real observable completion condition, or pass
  vacuously before the work finishes?
- **Second interface** — confirm important state through a different observable surface than
  the one under test. Disagreement between layers is a finding.

## Anti-patterns to name when you see them

- **Tautological** — the assertion recomputes the expected the way the code does, so it can
  never disagree with the code.
- **Implementation-coupled** — mocks an internal collaborator, or verifies through a side
  channel instead of the interface. The tell: it breaks on refactor while behaviour holds.
- **Horizontal slicing** — all the tests first, then all the implementation. Bulk tests
  verify _imagined_ behaviour. Work in vertical slices: one test, one implementation, repeat.
- **Green that lies** — any of the above, shipped.

`pnpm check:integrity` catches the lexical shapes of these. It cannot catch a tautological
oracle, which is why the mutation check is done by hand.
