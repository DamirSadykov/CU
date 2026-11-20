import { describe, expect, it } from "vitest";
import {
  activeFacetCount, attentionKinds, clearFacets, defaultTodoFilters, facetCounts, localToday, normalizeTodoFilters,
  projectTodos, toggleFacet, viewCounts, type TodoFilters,
} from "./todoFilter";

const rows: any[] = [
  { id: "1", number: 1, subject: "Alpha", description: "needle", status: "backlog", priority: "high", project: "a", created_by: "user", change: false, created_at: "2026-09-01", updated_at: "2026-09-02", scheduled_for: null },
  { id: "2", number: 2, subject: "Change", description: "", status: "done", priority: "low", project: "b", created_by: "claude", change: true, created_at: "2026-09-03", updated_at: "2026-09-05", scheduled_for: null },
];
const today = "2026-10-01";
const with_ = (overrides: Partial<TodoFilters>): TodoFilters => ({ ...defaultTodoFilters(), ...overrides });
const ids = (filters: TodoFilters, source: any[] = rows, context = {}) => projectTodos(source, filters, { today, ...context }).visible.map((row) => row.id);

describe("projectTodos", () => {
  it("filters with the indexed search text and omits done in the active view", () => {
    const result = projectTodos(rows, with_({ query: "needle" }), { indexes: { search: new Map([["1", "indexed needle"], ["2", "change"]]) } });
    expect(result.columns.backlog.map((x) => x.id)).toEqual(["1"]);
    expect(result.columns.done).toEqual([]);
  });

  it("splits tasks into the four view tabs", () => {
    expect(ids(with_({ view: "active" }))).toEqual(["1"]);
    expect(ids(with_({ view: "done" }))).toEqual(["2"]);
    expect(ids(with_({ view: "all" }))).toEqual(["1", "2"]);
  });

  it("treats a facet as any-of within itself and all-of across facets", () => {
    const source = [
      { ...rows[0], id: "a-high", priority: "high", project: "a" },
      { ...rows[0], id: "a-low", priority: "low", project: "a" },
      { ...rows[0], id: "b-high", priority: "high", project: "b" },
      { ...rows[0], id: "c-medium", priority: "medium", project: "c" },
    ];
    expect(ids(with_({ project: ["a", "b"], priority: ["high"] }), source)).toEqual(["a-high", "b-high"]);
    expect(ids(with_({ status: ["queue", "review"] }), [{ ...rows[0], id: "q", status: "queue" }, { ...rows[0], id: "r", status: "review" }, rows[0]])).toEqual(["q", "r"]);
  });

  it("keeps tasks created inside the chosen window of calendar days", () => {
    const source = [
      { ...rows[0], id: "today", created_at: "2026-10-01T09:00:00Z" },
      { ...rows[0], id: "six-days", created_at: "2026-09-25" },
      { ...rows[0], id: "week-ago", created_at: "2026-09-24" },
    ];
    expect(ids(with_({ created: "1" }), source)).toEqual(["today"]);
    expect(ids(with_({ created: "7" }), source)).toEqual(["today", "six-days"]);
  });

  it("orders done by completion date rather than a later edit", () => {
    const done = [
      { ...rows[1], id: "older-close", closed_at: "2026-09-04", updated_at: "2026-09-10" },
      { ...rows[1], id: "newer-close", closed_at: "2026-09-06", updated_at: "2026-09-07" },
    ];
    expect(projectTodos(done, with_({ view: "all" })).columns.done.map((x) => x.id)).toEqual(["newer-close", "older-close"]);
  });

  it("matches a merged project's canonical filter name without changing its label", () => {
    const result = projectTodos([{ ...rows[0], project: "old-alias", filterProject: "canonical" }], with_({ project: ["canonical"] }));
    expect(result.columns.backlog.map((x) => x.project)).toEqual(["old-alias"]);
  });
});

describe("search", () => {
  const source = [
    { ...rows[0], id: "t1268", number: 1268, subject: "Shell", change_id: "c-115" },
    { ...rows[0], id: "t126", number: 126, subject: "Other", change_id: "c-9" },
    { ...rows[0], id: "t115", number: 115, subject: "Loose" },
  ];
  const plans = new Map([["c-115", { number: 115, title: "Review bar core" }], ["c-9", { number: 9, title: "Old plan" }]]);

  it("reads a bare or hashed number as a task-number prefix", () => {
    expect(ids(with_({ query: "126" }), source, { plans })).toEqual(["t1268", "t126"]);
    expect(ids(with_({ query: "#1268" }), source, { plans })).toEqual(["t1268"]);
  });

  it("reads p#N and c#N as every task of that plan", () => {
    expect(ids(with_({ query: "p#115" }), source, { plans })).toEqual(["t1268"]);
    expect(ids(with_({ query: "c#115" }), source, { plans })).toEqual(["t1268"]);
  });

  it("finds a task by its plan's title as well as its own text", () => {
    expect(ids(with_({ query: "review bar" }), source, { plans })).toEqual(["t1268"]);
    expect(ids(with_({ query: "loose" }), source, { plans })).toEqual(["t115"]);
  });
});

describe("attention", () => {
  it("flags overdue unfinished, stale active and unprioritized active tasks", () => {
    expect(attentionKinds({ ...rows[0], status: "queue", scheduled_for: "2026-09-30", updated_at: "2026-09-30", priority: "high" }, today)).toEqual(["overdue"]);
    expect(attentionKinds({ ...rows[0], status: "review", updated_at: "2026-09-16", priority: "low" }, today)).toEqual(["stale"]);
    expect(attentionKinds({ ...rows[0], status: "queue", updated_at: "2026-09-17", priority: "low" }, today)).toEqual([]);
    expect(attentionKinds({ ...rows[0], status: "in_progress", updated_at: "2026-09-30", priority: "" }, today)).toEqual(["no_priority"]);
    expect(attentionKinds({ ...rows[1], scheduled_for: "2026-09-30" }, today)).toEqual([]);
    expect(attentionKinds({ ...rows[0], status: "backlog", priority: undefined, updated_at: "2026-09-01" }, today)).toEqual([]);
  });

  it("shows any of the three in the attention view", () => {
    const source = [
      { ...rows[0], id: "overdue", status: "queue", scheduled_for: "2026-09-30", updated_at: "2026-09-30" },
      { ...rows[0], id: "no-priority", status: "queue", priority: "", updated_at: "2026-09-30" },
      { ...rows[0], id: "calm", status: "queue", updated_at: "2026-09-30" },
    ];
    expect(ids(with_({ view: "attention" }), source)).toEqual(["overdue", "no-priority"]);
  });
});

describe("counts", () => {
  const source = [
    { ...rows[0], id: "a-queue", status: "queue", project: "a", updated_at: "2026-09-30" },
    { ...rows[0], id: "a-done", status: "done", project: "a" },
    { ...rows[0], id: "b-queue", status: "queue", project: "b", priority: "", updated_at: "2026-09-30" },
  ];

  it("counts every view tab under the other filters", () => {
    expect(viewCounts(source, with_({ project: ["a"] }), { today })).toEqual({ active: 1, attention: 0, done: 1, all: 2 });
  });

  it("counts a facet's options without the facet's own selection", () => {
    const counts = facetCounts(source, with_({ project: ["a"] }), {
      status: ["queue", "done"], project: ["a", "b"], priority: ["high"], created: ["30"],
    }, { today });
    expect(counts.project).toEqual({ a: 1, b: 1 });
    expect(counts.status).toEqual({ queue: 1, done: 0 });
    expect(counts.created).toEqual({ "30": 0 });
  });
});

describe("filter state", () => {
  it("toggles multi facets, replaces the single created window and counts non-empty sections", () => {
    let filters = toggleFacet(defaultTodoFilters(), "status", "queue");
    filters = toggleFacet(filters, "status", "review");
    filters = toggleFacet(filters, "created", "7");
    filters = toggleFacet(filters, "created", "30");
    expect(filters).toMatchObject({ status: ["queue", "review"], created: "30" });
    expect(activeFacetCount(filters)).toBe(2);
    expect(toggleFacet(filters, "status", "queue").status).toEqual(["review"]);
    expect(clearFacets({ ...filters, query: "x", view: "done" })).toEqual({ ...defaultTodoFilters(), view: "done" });
  });

  it("restores a persisted value and drops anything it does not recognise", () => {
    expect(normalizeTodoFilters({ view: "done", status: ["queue", "bogus"], priority: ["high", 3], created: "9", query: 4, attention: "stale" }))
      .toEqual({ view: "done", status: ["queue"], project: [], priority: ["high"], created: "", query: "" });
    expect(normalizeTodoFilters(null)).toEqual(defaultTodoFilters());
  });
});

describe("localToday", () => {
  it("formats the local calendar date, not the UTC one", () => {
    expect(localToday(new Date(2026, 9, 1, 23, 30))).toBe("2026-10-01");
    expect(localToday(new Date(2026, 0, 5, 0, 10))).toBe("2026-01-05");
  });
});
