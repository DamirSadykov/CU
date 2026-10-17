import { describe, expect, it } from "vitest";
import type { BoardChange } from "../contracts/board";
import type { BoardTreeRow } from "./boardTree";
import { closedTaskAverage, fillDays, filterChangeRows, periodRange, projectOverview } from "./projectOverview";

const TODAY = "2026-10-12";

function row(id: string, number: number, patch: Partial<BoardTreeRow> = {}): BoardTreeRow {
  return {
    id, number, subject: `task ${number}`, description: "", status: "backlog", priority: "medium", kind: "auto",
    change: false, change_id: null, project: "p", links: [], depends_on: [],
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-11T00:00:00Z", ref_count: 0, comment_count: 0,
    ...patch,
  };
}

const change = (id: string, number: number, patch: Partial<BoardChange> = {}): BoardChange => ({ id, number, title: `change ${number}`, ...patch });

describe("project overview", () => {
  it("counts tasks by status, blocked by an open dependency", () => {
    const rows = [
      row("a", 1, { status: "done" }),
      row("b", 2, { status: "in_progress" }),
      row("c", 3, { status: "review" }),
      row("d", 4, { depends_on: ["b"] }),
      row("e", 5),
      row("x", 6, { project: "other" }),
    ];
    const overview = projectOverview("p", rows, [], "30d", TODAY);
    expect(overview.tasks).toEqual({ done: 1, total: 5, counts: { done: 1, running: 1, review: 1, blocked: 1, queued: 1 } });
  });

  it("uses the canonical project and skips legacy change roots", () => {
    const rows = [row("a", 1, { project: "alias", filterProject: "p" }), row("root", 2, { change: true })];
    expect(projectOverview("p", rows, [], "30d", TODAY).tasks.total).toBe(1);
  });

  it("derives change rows: progress, wave, cost against budget", () => {
    const rows = [
      row("a", 1, { change_id: "c1", status: "done", cost: 4 }),
      row("b", 2, { change_id: "c1", depends_on: ["a"], status: "in_progress", cost: 5 }),
      row("c", 3, { change_id: "c1", depends_on: ["b"], cost: 1 }),
      row("d", 4, { change_id: "c2", status: "done", cost: 2 }),
    ];
    const changes = [change("c1", 10, { budget_usd: 8 }), change("c2", 11, { budget_usd: 5 }), change("c3", 12, { project: "other" })];
    const overview = projectOverview("p", rows, changes, "30d", TODAY);
    expect(overview.changes.map((item) => item.number)).toEqual([10, 11]);
    expect(overview.changes[0]).toMatchObject({ done: 1, total: 3, wave: 2, waves: 3, status: "running", cost: 10, budget: 8, over: true, closed: false });
    expect(overview.changes[0].counts).toEqual({ done: 1, running: 1, review: 0, blocked: 1, queued: 0 });
    expect(overview.changes[1]).toMatchObject({ wave: 1, waves: 1, status: "done", closed: true, over: false });
    expect(overview.openChanges).toBe(1);
    expect(overview.overBudget).toBe(1);
  });

  it("keeps an empty open change and places a change with no tasks by its own project", () => {
    const overview = projectOverview("p", [], [change("c1", 7, { project: "p" })], "30d", TODAY);
    expect(overview.changes[0]).toMatchObject({ total: 0, wave: 0, waves: 0, status: "queued", closed: false, budget: null, over: false });
  });

  it("marks a change blocked only when nothing in it can start", () => {
    const rows = [row("a", 1, { status: "done", change_id: "c0" }), row("b", 2, { change_id: "c1", depends_on: ["z"] }), row("z", 3, { project: "q" })];
    const overview = projectOverview("p", rows, [change("c1", 1)], "30d", TODAY);
    expect(overview.changes[0].status).toBe("blocked");
  });

  it("lists attention: review, over budget, overdue, stale — each task once", () => {
    const rows = [
      row("r", 1, { status: "review", change_id: "c1", cost: 9, updated_at: "2026-09-01T00:00:00Z" }),
      row("o", 2, { status: "queue", scheduled_for: "2026-10-01", updated_at: "2026-09-01T00:00:00Z" }),
      row("s", 3, { status: "in_progress", updated_at: "2026-09-20T00:00:00Z" }),
      row("f", 4, { status: "in_progress" }),
    ];
    const overview = projectOverview("p", rows, [change("c1", 5, { budget_usd: 3 })], "30d", TODAY);
    expect(overview.attention).toEqual([
      { kind: "review", taskId: "r", number: 1, title: "task 1", change: 5 },
      { kind: "over_budget", changeId: "c1", number: 5, title: "change 5", cost: 9, budget: 3 },
      { kind: "overdue", taskId: "o", number: 2, title: "task 2", change: null, since: "2026-10-01" },
      { kind: "stale", taskId: "s", number: 3, title: "task 3", change: null, days: 22 },
    ]);
  });

  it("averages closed task cost in the period against the previous one", () => {
    const rows = [
      row("a", 1, { status: "done", closed_at: "2026-10-10T10:00:00Z", cost: 2 }),
      row("b", 2, { status: "done", closed_at: "2026-10-06T10:00:00Z", cost: 4 }),
      row("c", 3, { status: "done", closed_at: "2026-10-01T10:00:00Z", cost: 4 }),
      row("d", 4, { status: "done", closed_at: "2026-10-11T10:00:00Z" }),
    ];
    expect(closedTaskAverage(rows, "7d", TODAY)).toEqual({ value: 3, previous: 4, delta: -0.25, count: 2 });
    expect(closedTaskAverage(rows, "all", TODAY)).toEqual({ value: 10 / 3, previous: null, delta: null, count: 3 });
    expect(closedTaskAverage([], "30d", TODAY)).toEqual({ value: null, previous: null, delta: null, count: 0 });
  });

  it("filters change rows by open/closed and by p# or text", () => {
    const rows = projectOverview("p", [row("a", 1, { change_id: "c2", status: "done" })], [change("c1", 12, { project: "p", title: "Экран проекта" }), change("c2", 40)], "30d", TODAY).changes;
    expect(filterChangeRows(rows, false, "").map((item) => item.number)).toEqual([12]);
    expect(filterChangeRows(rows, true, "").map((item) => item.number)).toEqual([40]);
    expect(filterChangeRows(rows, false, "p#12").map((item) => item.number)).toEqual([12]);
    expect(filterChangeRows(rows, false, "экран").map((item) => item.number)).toEqual([12]);
    expect(filterChangeRows(rows, false, "40")).toEqual([]);
  });
});

describe("spend by day", () => {
  it("builds the period range and fills missing days with zero", () => {
    expect(periodRange("7d", TODAY)).toEqual({ from: "2026-10-06", to: TODAY, days: 7 });
    expect(periodRange("all", TODAY)).toEqual({ from: null, to: TODAY, days: null });
    expect(fillDays([{ date: "2026-10-07", cost: 2 }], "2026-10-06", "2026-10-08")).toEqual([
      { date: "2026-10-06", cost: 0 }, { date: "2026-10-07", cost: 2 }, { date: "2026-10-08", cost: 0 },
    ]);
    expect(fillDays([{ date: "2026-10-11", cost: 1 }], null, TODAY).map((day) => day.date)).toEqual(["2026-10-11", TODAY]);
    expect(fillDays([], null, TODAY)).toEqual([{ date: TODAY, cost: 0 }]);
  });
});
