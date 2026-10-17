import { describe, expect, it } from "vitest";
import type { BoardChange } from "../contracts/board";
import type { BoardRow } from "./boardStore";
import { boardTreeSummary, buildBoardTree, buildTaskFeed, visibleBoardTreeRows, type BoardTreeRow } from "./boardTree";
import { defaultTodoFilters } from "./todoFilter";

const row = (overrides: Partial<BoardTreeRow> = {}): BoardTreeRow => ({
  id: "task-1", number: 1, subject: "Task", description: "", status: "queue", priority: "medium",
  kind: "auto", change: false, links: [], depends_on: [], created_at: "2026-09-01", updated_at: "2026-09-01",
  ref_count: 0, comment_count: 0, project: "app", ...overrides,
} as BoardRow & BoardTreeRow);

const change = (overrides: Partial<BoardChange> = {}): BoardChange => ({
  id: "c-1", number: 1, title: "Modern change", updated_at: "2026-09-02", ...overrides,
});

describe("buildBoardTree", () => {
  it("orders plans by their freshest task and keeps done tasks of an open plan visible", () => {
    const tree = buildBoardTree([
      row({ id: "a", number: 2, subject: "Done", status: "done", change_id: "c-1", cost: 1.25 }),
      row({ id: "b", number: 1, subject: "Open", change_id: "c-1", cost: 2 }),
      row({ id: "c", number: 3, change_id: "c-2", updated_at: "2026-09-03" }),
    ], [change(), change({ id: "c-2", number: 2, title: "Newest" })], defaultTodoFilters());
    expect(tree.map((node) => node.id)).toEqual(["project:app"]);
    const changes = tree[0].children;
    expect(changes.map((node) => node.title)).toEqual(["Newest", "Modern change"]);
    expect(changes[1]).toMatchObject({ kind: "change", progress: { done: 1, total: 2 }, cost: 3.25, closed: false });
    expect(changes[1].children.map((node) => node.number)).toEqual([2, 1]);
  });

  it("represents old change roots and puts unassigned tasks in canonical project groups", () => {
    const tree = buildBoardTree([
      row({ id: "root", number: 10, subject: "Old root", change: true, status: "done" }),
      row({ id: "member", number: 11, change_id: "root" }),
      row({ id: "alias", number: 12, filterProject: "canonical", project: "old-name", cost: 4 }),
    ], [], defaultTodoFilters());
    const app = tree.find((node) => node.id === "project:app")!;
    const canonical = tree.find((node) => node.id === "project:canonical")!;
    expect(app.children[0]).toMatchObject({ kind: "legacy", id: "root", title: "Old root", closed: true });
    expect(app.children[0].children.map((node) => node.id)).toEqual(["member"]);
    expect(canonical).toMatchObject({ kind: "group", title: "canonical", cost: 4 });
    expect(canonical.children).toMatchObject([{ kind: "ungrouped", progress: { done: 0, total: 1 }, cost: 4 }]);
    expect(canonical.children[0].children.map((node) => node.id)).toEqual(["alias"]);
  });

  it("filters tasks through projectTodos while retaining their non-empty parent", () => {
    const filters = defaultTodoFilters();
    filters.status = ["queue"];
    const tree = buildBoardTree([
      row({ id: "queue", change_id: "c-1", status: "queue" }),
      row({ id: "done", change_id: "c-1", status: "done" }),
      row({ id: "hidden", status: "backlog" }),
    ], [change()], filters);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((node) => node.id)).toEqual(["c-1"]);
    expect(tree[0].children[0].children.map((node) => node.id)).toEqual(["queue"]);
  });

  it("marks a change complete when it is closed or all of its tasks are done", () => {
    const allDone = buildBoardTree([
      row({ id: "done-a", change_id: "c-1", status: "done" }),
      row({ id: "done-b", change_id: "c-1", status: "done" }),
    ], [change()], { ...defaultTodoFilters(), view: "all" as const });
    const explicitlyClosed = buildBoardTree([
      row({ id: "open", change_id: "c-1" }),
    ], [change({ closed_at: "2026-09-03" })], defaultTodoFilters());

    expect(allDone[0].children[0].closed).toBe(true);
    expect(explicitlyClosed[0].children[0].closed).toBe(true);
  });

  it("does not mark a partially done change complete when a status filter hides its open task", () => {
    const filters = { ...defaultTodoFilters(), view: "all" as const, status: ["done"] };
    const tree = buildBoardTree([
      row({ id: "done", change_id: "c-1", status: "done" }),
      row({ id: "open", change_id: "c-1", status: "queue" }),
    ], [change()], filters);

    expect(tree[0].children[0]).toMatchObject({
      progress: { done: 1, total: 1 },
      closed: false,
    });
  });

  it("orders tasks, plans and projects by the chosen sort through their best task", () => {
    const source = [
      row({ id: "old-plan-task", number: 1, change_id: "c-1", updated_at: "2026-09-01", project: "first" }),
      row({ id: "fresh-plan-task", number: 2, change_id: "c-2", updated_at: "2026-09-20", project: "first" }),
      row({ id: "fresh-plan-older", number: 3, change_id: "c-2", updated_at: "2026-09-10", project: "first" }),
      row({ id: "other-project", number: 4, updated_at: "2026-09-15", project: "second" }),
    ];
    const plans = [change({ id: "c-1", number: 1 }), change({ id: "c-2", number: 2 })];
    const fresh = buildBoardTree(source, plans, defaultTodoFilters(), { sort: "updated" });
    expect(fresh.map((node) => node.id)).toEqual(["project:first", "project:second"]);
    expect(fresh[0].children.map((node) => node.id)).toEqual(["c-2", "c-1"]);
    expect(fresh[0].children[0].children.map((node) => node.id)).toEqual(["fresh-plan-task", "fresh-plan-older"]);
    expect(fresh[0].children[0].time).toBe("2026-09-20");

    const byNumber = buildBoardTree(source, plans, defaultTodoFilters(), { sort: "number" });
    expect(byNumber[0].children.map((node) => node.id)).toEqual(["c-1", "c-2"]);
    expect(byNumber[0].children[1].children.map((node) => node.number)).toEqual([2, 3]);

    const oldest = buildBoardTree(source, plans, defaultTodoFilters(), { sort: "oldest" });
    expect(oldest.map((node) => node.id)).toEqual(["project:first", "project:second"]);
    expect(oldest[0].children.map((node) => node.id)).toEqual(["c-1", "c-2"]);
  });

  it("finds every task of a plan by p#N and by the plan's title", () => {
    const source = [
      row({ id: "member", subject: "Unrelated task", change_id: "c-1" }),
      row({ id: "other", subject: "release notes task", change_id: "c-2" }),
      row({ id: "hidden", change_id: "c-3" }),
    ];
    const plans = [
      change({ id: "c-1", number: 71, title: "Release notes" }),
      change({ id: "c-2", number: 72, title: "Other change" }),
      change({ id: "c-3", number: 73, title: "Hidden change" }),
    ];
    const byTitle = buildBoardTree(source, plans, { ...defaultTodoFilters(), query: "release notes" });
    expect(byTitle[0].children.map((node) => node.id).sort()).toEqual(["c-1", "c-2"]);
    const byRef = buildBoardTree(source, plans, { ...defaultTodoFilters(), query: "p#71" });
    expect(byRef[0].children.map((node) => node.id)).toEqual(["c-1"]);
  });

  it("flags attention on the task and on every branch above it", () => {
    const tree = buildBoardTree([row({ id: "late", change_id: "c-1", status: "queue", scheduled_for: "2026-09-01" })], [change()], defaultTodoFilters(), { today: "2026-10-01" });
    expect(tree[0].attention).toBe(true);
    expect(tree[0].children[0].attention).toBe(true);
    expect(tree[0].children[0].children[0].attention).toBe(true);
  });
});

describe("buildTaskFeed", () => {
  const now = new Date(2026, 9, 17, 15, 0).getTime();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const source = [
    row({ id: "today", number: 5, change_id: "c-1", updated_at: at(1) }),
    row({ id: "yesterday", number: 3, updated_at: at(20) }),
    row({ id: "today-older", number: 4, updated_at: at(3) }),
    row({ id: "root", number: 9, change: true, updated_at: at(0.5) }),
  ];

  it("lists tasks flat, newest first, under day groups with the plan number", () => {
    const feed = buildTaskFeed(source, [change({ number: 115 })], defaultTodoFilters(), { sort: "updated", now });
    expect(feed.map((group) => [group.bucket, group.nodes.map((node) => node.id)])).toEqual([
      ["today", ["today", "today-older"]], ["yesterday", ["yesterday"]],
    ]);
    expect(feed[0].nodes[0].plan).toBe(115);
  });

  it("drops the day groups for the number and cost sorts", () => {
    const feed = buildTaskFeed(source, [change()], defaultTodoFilters(), { sort: "number", now });
    expect(feed).toHaveLength(1);
    expect(feed[0].bucket).toBeNull();
    expect(feed[0].nodes.map((node) => node.number)).toEqual([3, 4, 5]);
  });
});

describe("boardTreeSummary", () => {
  it("counts task leaves once, including tasks in the without-change group", () => {
    const tree = buildBoardTree([
      row({ id: "open", change_id: "c-1", cost: 1.25 }),
      row({ id: "done", status: "done", cost: 2.5 }),
    ], [change()], { ...defaultTodoFilters(), view: "all" as const });
    expect(boardTreeSummary(tree)).toEqual({ active: 1, total: 2, cost: 3.75 });
  });
});

describe("visibleBoardTreeRows", () => {
  it("flattens expanded branches with depth and skips collapsed descendants", () => {
    const tree = buildBoardTree([row({ id: "a", change_id: "c-1" })], [change()], defaultTodoFilters());
    expect(visibleBoardTreeRows(tree, new Set()).map(({ node, depth }) => [node.id, depth])).toEqual([["project:app", 0], ["c-1", 1], ["a", 2]]);
    expect(visibleBoardTreeRows(tree, new Set(["c-1"])).map(({ node }) => node.id)).toEqual(["project:app", "c-1"]);
    expect(visibleBoardTreeRows(tree, new Set(), { plansOnly: true }).map(({ node }) => node.id)).toEqual(["project:app", "c-1"]);
  });
});
