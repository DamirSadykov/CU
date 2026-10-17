import type { BoardChange } from "../contracts/board";
import type { BoardIndexes, BoardRow } from "./boardStore";
import { matchesTodoFilters, needsAttention, projectTodos, localToday, type PlanLabel, type TodoFilterContext, type TodoFilters } from "./todoFilter";
import { compareTasks, dayBucket, sortHasBuckets, taskTime, type DayBucket, type TodoSort } from "./taskSort";

export type BoardTreeNodeKind = "change" | "legacy" | "group" | "ungrouped" | "task";

export interface BoardTreeProgress {
  done: number;
  total: number;
}

export interface BoardTreeNode {
  kind: BoardTreeNodeKind;
  id: string;
  number: number | null;
  title: string;
  status: string | null;
  progress: BoardTreeProgress;
  cost: number;
  children: readonly BoardTreeNode[];
  closed: boolean;
  project?: string;
  time: string;
  attention: boolean;
  plan?: number | null;
}

export interface BoardTreeRow extends BoardRow {
  cost?: number | null;
  filterProject?: string | null;
}

export interface VisibleBoardTreeRow {
  node: BoardTreeNode;
  depth: number;
}

export interface BoardTreeSummary {
  active: number;
  total: number;
  cost: number;
}

export interface BoardTreeOptions {
  indexes?: Pick<BoardIndexes, "search">;
  sort?: TodoSort;
  today?: string;
}

export interface BoardFeedGroup {
  bucket: DayBucket | null;
  nodes: readonly BoardTreeNode[];
}

const closedTask = (row: BoardTreeRow) => row.status === "done";
const costOf = (row: BoardTreeRow) => Number.isFinite(row.cost) ? row.cost as number : 0;

function progress(rows: readonly BoardTreeRow[]): BoardTreeProgress {
  return { done: rows.filter(closedTask).length, total: rows.length };
}

export function planLabels(rows: readonly BoardTreeRow[], changes: readonly BoardChange[]): Map<string, PlanLabel> {
  const labels = new Map<string, PlanLabel>(changes.map((change) => [change.id, { number: change.number, title: change.title }]));
  for (const row of rows) if (row.change) labels.set(row.id, { number: row.number, title: row.subject });
  return labels;
}

function taskNode(row: BoardTreeRow, sort: TodoSort, today: string, plan: number | null = null): BoardTreeNode {
  return {
    kind: "task",
    id: row.id,
    number: row.number,
    title: row.subject,
    status: row.status,
    progress: { done: closedTask(row) ? 1 : 0, total: 1 },
    cost: costOf(row),
    children: [],
    closed: closedTask(row),
    time: taskTime(row, sort),
    attention: needsAttention(row, today),
    plan,
  };
}

interface Ranked {
  node: BoardTreeNode;
  best: BoardTreeRow;
  project: string;
}

export function buildBoardTree(
  rows: readonly BoardTreeRow[],
  changes: readonly BoardChange[],
  filters: TodoFilters,
  options: BoardTreeOptions = {},
): readonly BoardTreeNode[] {
  const sort = options.sort ?? "updated";
  const compare = compareTasks(sort);
  const today = options.today ?? localToday();
  const context: TodoFilterContext = { indexes: options.indexes, plans: planLabels(rows, changes), today };
  const visible = projectTodos(rows, filters, context).visible;
  const changeById = new Map(changes.map((change) => [change.id, change]));
  const legacyById = new Map(rows.filter((row) => row.change).map((row) => [row.id, row]));
  const primaryIds = new Set(visible.map((row) => row.id));
  const visibleIds = new Set(primaryIds);

  if (filters.view === "active") {
    for (const row of rows) {
      if (row.status !== "done" || !row.change_id) continue;
      const change = changeById.get(row.change_id);
      if (change && !change.closed_at && matchesTodoFilters(row, { ...filters, view: "all" }, context)) visibleIds.add(row.id);
    }
  }

  const memberRows = new Map<string, BoardTreeRow[]>();
  const allMemberRows = new Map<string, BoardTreeRow[]>();
  const groups = new Map<string, BoardTreeRow[]>();

  for (const row of rows) {
    if (row.change) continue;
    if (row.change_id && (changeById.has(row.change_id) || legacyById.has(row.change_id))) {
      const allMembers = allMemberRows.get(row.change_id) ?? [];
      allMembers.push(row);
      allMemberRows.set(row.change_id, allMembers);
      if (visibleIds.has(row.id)) {
        const members = memberRows.get(row.change_id) ?? [];
        members.push(row);
        memberRows.set(row.change_id, members);
      }
      continue;
    }
    if (!visibleIds.has(row.id)) continue;
    const project = row.filterProject ?? row.project ?? "";
    const members = groups.get(project) ?? [];
    members.push(row);
    groups.set(project, members);
  }

  const bestOf = (members: readonly BoardTreeRow[]) => {
    const ranked = members.filter((row) => primaryIds.has(row.id));
    return [...(ranked.length ? ranked : members)].sort(compare)[0];
  };

  const planNode = (
    kind: "change" | "legacy",
    id: string,
    number: number,
    title: string,
    members: readonly BoardTreeRow[],
    closed: boolean,
    allMembers: readonly BoardTreeRow[],
    project: string,
    best: BoardTreeRow,
  ): Ranked => ({
    node: {
      kind,
      id,
      number,
      title,
      status: null,
      progress: progress(members),
      cost: members.reduce((total, row) => total + costOf(row), 0),
      children: [...members].sort(compare).map((row) => taskNode(row, sort, today)),
      closed: closed || (allMembers.length > 0 && allMembers.every(closedTask)),
      project,
      time: taskTime(best, sort),
      attention: members.some((row) => needsAttention(row, today)),
    },
    best,
    project,
  });

  const planNodes: Ranked[] = [];
  for (const change of changes) {
    const members = memberRows.get(change.id) ?? [];
    if (!members.length) continue;
    const project = members[0]?.filterProject ?? change.project ?? members[0]?.project ?? "";
    planNodes.push(planNode("change", change.id, change.number, change.title, members, !!change.closed_at, allMemberRows.get(change.id) ?? members, project, bestOf(members)));
  }
  for (const legacy of legacyById.values()) {
    const members = memberRows.get(legacy.id) ?? [];
    if (!members.length && !primaryIds.has(legacy.id)) continue;
    const project = legacy.filterProject ?? legacy.project ?? "";
    const allRows = members.length ? members : [legacy];
    planNodes.push(planNode("legacy", legacy.id, legacy.number, legacy.subject, allRows, closedTask(legacy), allMemberRows.get(legacy.id) ?? allRows, project, bestOf(allRows)));
  }
  const byBest = (left: Ranked, right: Ranked) => compare(left.best, right.best);
  planNodes.sort(byBest);

  const projects = new Set<string>([...groups.keys(), ...planNodes.map((entry) => entry.project)]);
  const projectNodes: Ranked[] = [...projects].map((project) => {
    const loose = [...(groups.get(project) ?? [])].sort(compare);
    const plans = planNodes.filter((entry) => entry.project === project);
    const looseChildren = loose.map((row) => taskNode(row, sort, today));
    const looseBest = loose.length ? bestOf(loose) : null;
    const children: BoardTreeNode[] = plans.map((entry) => entry.node);
    if (looseChildren.length && looseBest) children.push({
      kind: "ungrouped",
      id: `project:${project}:ungrouped`,
      number: null,
      title: "",
      status: null,
      progress: progress(loose),
      cost: looseChildren.reduce((sum, node) => sum + node.cost, 0),
      children: looseChildren,
      closed: looseChildren.every((node) => node.closed),
      time: taskTime(looseBest, sort),
      attention: looseChildren.some((node) => node.attention),
    });
    const best = [...plans.map((entry) => entry.best), ...(looseBest ? [looseBest] : [])].sort(compare)[0];
    const done = children.reduce((sum, node) => sum + node.progress.done, 0);
    const total = children.reduce((sum, node) => sum + node.progress.total, 0);
    return {
      node: {
        kind: "group" as const,
        id: `project:${project}`,
        number: null,
        title: project,
        status: null,
        progress: { done, total },
        cost: children.reduce((sum, node) => sum + node.cost, 0),
        children,
        closed: children.every((node) => node.closed),
        time: taskTime(best, sort),
        attention: children.some((node) => node.attention),
      },
      best,
      project,
    };
  });
  projectNodes.sort(byBest);
  return projectNodes.map((entry) => entry.node);
}

export function buildTaskFeed(
  rows: readonly BoardTreeRow[],
  changes: readonly BoardChange[],
  filters: TodoFilters,
  options: BoardTreeOptions & { now?: number } = {},
): readonly BoardFeedGroup[] {
  const sort = options.sort ?? "updated";
  const today = options.today ?? localToday();
  const plans = planLabels(rows, changes);
  const visible = projectTodos(rows.filter((row) => !row.change), filters, { indexes: options.indexes, plans, today }).visible;
  const nodes = [...visible].sort(compareTasks(sort)).map((row) => taskNode(row, sort, today, row.change_id ? plans.get(row.change_id)?.number ?? null : null));
  if (!sortHasBuckets(sort)) return nodes.length ? [{ bucket: null, nodes }] : [];
  const groups: { bucket: DayBucket; nodes: BoardTreeNode[] }[] = [];
  for (const node of nodes) {
    const bucket = dayBucket(node.time, options.now);
    const last = groups[groups.length - 1];
    if (last?.bucket === bucket) last.nodes.push(node);
    else groups.push({ bucket, nodes: [node] });
  }
  return groups;
}

export function findBoardTreeNode(tree: readonly BoardTreeNode[], id: string): BoardTreeNode | null {
  for (const node of tree) {
    if (node.id === id) return node;
    const hit = findBoardTreeNode(node.children, id);
    if (hit) return hit;
  }
  return null;
}

export function visibleBoardTreeRows(
  tree: readonly BoardTreeNode[],
  collapsed: ReadonlySet<string>,
  options: { plansOnly?: boolean } = {},
): readonly VisibleBoardTreeRow[] {
  const visible: VisibleBoardTreeRow[] = [];
  const visit = (node: BoardTreeNode, depth: number) => {
    visible.push({ node, depth });
    if (collapsed.has(node.id)) return;
    if (options.plansOnly && node.kind !== "group") return;
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const node of tree) visit(node, 0);
  return visible;
}

export function boardTreeSummary(tree: readonly BoardTreeNode[]): BoardTreeSummary {
  const summary: BoardTreeSummary = { active: 0, total: 0, cost: 0 };
  const visit = (node: BoardTreeNode) => {
    if (node.kind === "task") {
      summary.total += 1;
      summary.active += Number(!node.closed);
      summary.cost += node.cost;
      return;
    }
    node.children.forEach(visit);
  };
  tree.forEach(visit);
  return summary;
}
