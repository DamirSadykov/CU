# Plan graph format

Write a recordable draft plan in YAML: one task/work session per task. Omitted runner fields
are inferred; explicit values win.

## 0. When to write a draft plan

Scout: locate files and size each task S/M/L. Any L task or open branch requires
plan mode; use `<cli> todos apply` only for auto-runner work. Otherwise a draft
plan is optional. Keep its graph current. Decide after scouting, not by edit count.

## 1. Field legend

Document fields:

`change` — legacy key: creates/selects the plan record; use when the plan opens tasks.
`vision` — WHAT & WHY in 2–5 labelled blocks; use when creating/revising a plan.
`out` — decided non-goals (`what`, `why`, optional `ref`).
`measure` — outcomes (`what`, `how`, optional `target`, `actual`, `ok`, `note`).
`parallel` — justified group concurrency limit.
`budget` — justified group spend ceiling.
`steps` — legacy key for task nodes; required when the plan records work.

Task fields:

`title` — new task subject, verbatim; declare for a new task.
`task` — binds an existing task (`N`, `#N`, `t#N`, or uuid); use instead of `title` when continuing it.
`needs` — blocking edges; declare only blockers, not preferred order.
`produces` — files, interfaces, or records reconciled after work; declare durable outputs.
`verify` — exit-code authority; declare when a command can judge success.
`retry` — attempt limit; omit for runner default `2`, or declare only when `why` explains the exception.
`on-issue` — corrective target; declare only a decided target (omitted `retry` still becomes `2`).
`kind` — closing authority; omit for `auto` with `verify`, otherwise `manual`; an explicit value wins.
`size` — required for a new `auto` task: S = point edit, M = multi-file feature, L = connected rework with tests and a document.
`budget` — exceptional node spend ceiling; declare only with the reason in `why`, otherwise history translates `size` into dollars.
`red` — command that must fail on the base state; include the regression-test path in the command.
`red-tests` — regression-test paths protected during the red gate; omit to extract them from `red`, or declare explicitly.
`flow` — required for code in configured languages: method delta (`file`, `method`, `params`, `change`, `preserve`; `nth` = 1-based anchor) or `n/a <reason>`.
`risk` — exceptional routing; declare only `high` or `sensitive`.

`why` is the task's durable reasoning: its basis and risk. A refusal explains
invalid `out` and `measure` items.

## 2. Graph skeleton

```yaml
change: "PLAN: webhook delivery is observable"
vision: Delivery failures leave durable evidence for operators.
steps:
  1:
    title: Delivery state is recorded
    why: Both branches need receipt proof.
    size: S
    produces: [src/delivery.ts]
    verify: npm run test:delivery-state
    flow:
      file: src/delivery.ts
      method: deliver
      change:
        - insert: recordDeliveryState
          after: send
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
change: "PLAN: duplicate webhook regression"
steps:
  fix:
    title: Duplicate delivery has a regression test
    why: The new regression file fails on the old code.
    size: S
    produces: [test/webhook-duplicate.test.mjs]
    flow: n/a test only
    verify: npx vitest run test/webhook-duplicate.test.mjs
    red: npx vitest run test/webhook-duplicate.test.mjs
```

## 3. Recording and refusals

The ExitPlanMode hook records an approved plan. Fallback only when the hook says
it could not read the plan:

```
<cli> todos apply <plan>.yaml
<cli> todos apply <plan>.yaml --go
<cli> todos lint [<plan>] [--json]
```

`apply` prints every inferred value as `выведено` and writes that value to the
board. Re-applying explicit old graphs leaves their declarations explicit.
An automatic task explicitly declared without `verify` remains a gate.

For a draft plan that settles a question and records no work, start with:

```
discussion: <what is being settled, and why it opens no task>
```

Open [`plan-format-issues.md`](plan-format-issues.md) only when a task parks.
Open [`plan-format-cutting.md`](plan-format-cutting.md) only when a plan or task
must be split.
