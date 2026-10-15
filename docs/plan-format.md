# Plan graph format

Write recordable YAML: one task/work session per step. Omitted runner fields
are inferred; explicit values win.

## 0. When to write a plan

Scout: locate files and size each step S/M/L. Any L step or open branch requires
plan mode; use `<cli> todos apply` only for auto-runner work. Otherwise a plan
is optional. Keep graphs current. Decide after scouting, not by edit count.

## 1. Field legend

Document fields:

`change` — creates/selects the root; use when the plan opens tasks.
`vision` — WHAT & WHY in 2–5 labelled blocks; use when creating/revising a change.
`out` — decided non-goals (`what`, `why`, optional `ref`).
`measure` — outcomes (`what`, `how`, optional `target`, `actual`, `ok`, `note`).
`parallel` — justified group concurrency limit.
`budget` — justified group spend ceiling.
`steps` — graph nodes; required when the plan records work.

Step fields:

`title` — new task subject, verbatim; declare for a new task.
`task` — binds an existing task (`N`, `#N`, `t#N`, or uuid); use instead of `title` when continuing it.
`needs` — blocking edges; declare only blockers, not preferred order.
`produces` — files, interfaces, or records reconciled after work; declare durable outputs.
`verify` — exit-code authority; declare when a command can judge success.
`retry` — attempt limit; omit for runner default `2`, or declare only when `why` explains the exception.
`on-issue` — corrective target; declare only a decided target (omitted `retry` still becomes `2`).
`kind` — closing authority; omit for `auto` with `verify`, otherwise `manual`; an explicit value wins.
`size` — required for a new `auto` step: S = point edit, M = multi-file feature, L = connected rework with tests and a document.
`budget` — exceptional node spend ceiling; declare only with the reason in `why`, otherwise history translates `size` into dollars.
`red` — command that must fail on the base state; include the regression-test path in the command.
`red-tests` — regression-test paths protected during the red gate; omit to extract them from `red`, or declare explicitly.
`flow` — method delta for configured source (`file`, `method`, `params`, `change`, `preserve`), or `n/a <reason>`; `nth` in `change` selects the 1-based anchor occurrence.
`risk` — exceptional routing; declare only `high` or `sensitive`.

`why` is the task's durable reasoning: its basis and risk. A refusal explains
invalid `out` and `measure` items.

## 2. Graph skeleton

```yaml
change: "CHANGE: webhook delivery is observable"
vision: Delivery failures leave durable evidence for operators.
steps:
  1:
    title: Delivery state is recorded
    why: Receipt must leave evidence for both downstream branches.
    size: S
    produces: [src/delivery-state.ts]
    verify: npm run test:delivery-state
  2:
    title: Operators accept dashboard thresholds
    why: Threshold usefulness needs human judgement.
    needs: [1]
  3:
    task: 318
    why: The existing runbook task joins recorded state and accepted thresholds.
    needs: [1, 2]
    produces: [docs/delivery-runbook.md]
    verify: npm run docs:check
```

Bug-fix gate (the test path in `red` makes `red-tests` inferable):

```yaml
change: "CHANGE: duplicate webhook regression"
steps:
  fix:
    title: Duplicate delivery has a regression test
    why: The command isolates the new regression file on the old implementation.
    size: S
    produces: [test/webhook-duplicate.test.mjs]
    verify: npx vitest run test/webhook-duplicate.test.mjs
    red: npx vitest run test/webhook-duplicate.test.mjs
```

## 3. Recording and refusals

The ExitPlanMode hook records an approved plan. Fallback only when the hook says
it could not read the plan:

```
<cli> todos apply <plan>.yaml
<cli> todos apply <plan>.yaml --go
<cli> todos lint [<change>] [--json]
```

`apply` prints every inferred value as `выведено` and writes that value to the
board. Re-applying explicit old graphs leaves their declarations explicit.
An automatic step explicitly declared without `verify` remains a gate.

For a plan that settles a question and records no work, start with:

```
discussion: <what is being settled, and why it opens no task>
```

Open [`plan-format-issues.md`](plan-format-issues.md) only when a step parks.
Open [`plan-format-cutting.md`](plan-format-cutting.md) only when a plan or step
must be split.
