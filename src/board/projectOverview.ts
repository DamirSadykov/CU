import type { BoardChange } from "../contracts/board";
import { wavesOf } from "./waves";
import type { BoardTreeRow } from "./boardTree";
import { attentionKinds, defaultTodoFilters, projectTodos } from "./todoFilter";
import { formatRef, parseRef } from "../../scripts/cli/kernel/terms.mjs";

export type OverviewPeriod = "7d" | "30d" | "all";
export type OverviewStatus = "done" | "running" | "review" | "blocked" | "queued";

export interface StatusCounts {
  done: number;
  running: number;
  review: number;
  blocked: number;
  queued: number;
}

export interface ChangeOverviewRow {
  id: string;
  number: number;
  title: string;
  counts: StatusCounts;
  done: number;
  total: number;
  wave: number;
  waves: number;
  status: OverviewStatus;
  cost: number;
  budget: number | null;
  over: boolean;
  closed: boolean;
}

export type AttentionItem =
  | { kind: "review"; taskId: string; number: number; title: string; change: number | null }
  | { kind: "over_budget"; changeId: string; number: number; title: string; cost: number; budget: number }
  | { kind: "overdue"; taskId: string; number: number; title: string; change: number | null; since: string }
  | { kind: "stale"; taskId: string; number: number; title: string; change: number | null; days: number };

export interface ClosedTaskAverage {
  value: number | null;
  previous: number | null;
  delta: number | null;
  count: number;
}

export interface ProjectOverview {
  tasks: { done: number; total: number; counts: StatusCounts };
  openChanges: number;
  overBudget: number;
  average: ClosedTaskAverage;
  changes: ChangeOverviewRow[];
  attention: AttentionItem[];
}

export interface PeriodRange {
  from: string | null;
  to: string;
  days: number | null;
}

const PERIOD_DAYS: Record<OverviewPeriod, number | null> = { "7d": 7, "30d": 30, all: null };
const DAY_MS = 86_400_000;

export function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function periodRange(period: OverviewPeriod, today: string): PeriodRange {
  const days = PERIOD_DAYS[period];
  return days === null ? { from: null, to: today, days: null } : { from: shiftDay(today, 1 - days), to: today, days };
}

const emptyCounts = (): StatusCounts => ({ done: 0, running: 0, review: 0, blocked: 0, queued: 0 });

const projectOf = (row: BoardTreeRow) => row.filterProject ?? row.project ?? "";
const costOf = (row: BoardTreeRow) => (Number.isFinite(row.cost) ? (row.cost as number) : 0);

function taskStatus(row: BoardTreeRow, byId: ReadonlyMap<string, BoardTreeRow>): OverviewStatus {
  if (row.status === "done") return "done";
  if (row.status === "in_progress") return "running";
  if (row.status === "review") return "review";
  const blocked = (row.depends_on ?? []).some((id) => {
    const dep = byId.get(id);
    return !!dep && dep.status !== "done";
  });
  return blocked ? "blocked" : "queued";
}

function countStatuses(rows: readonly BoardTreeRow[], byId: ReadonlyMap<string, BoardTreeRow>): StatusCounts {
  const counts = emptyCounts();
  for (const row of rows) counts[taskStatus(row, byId)] += 1;
  return counts;
}

function changeStatus(closed: boolean, counts: StatusCounts): OverviewStatus {
  if (closed) return "done";
  if (counts.running) return "running";
  if (counts.review) return "review";
  if (counts.blocked && !counts.queued) return "blocked";
  return "queued";
}

function changeWave(members: readonly BoardTreeRow[]): { wave: number; waves: number } {
  if (!members.length) return { wave: 0, waves: 0 };
  const edges = members.flatMap((row) => (row.depends_on ?? []).map((from) => ({ from, to: row.id })));
  const levels = wavesOf(members.map((row) => row.id), edges);
  const waves = Math.max(...levels.values());
  const open = members.filter((row) => row.status !== "done").map((row) => levels.get(row.id) ?? 1);
  return { wave: open.length ? Math.min(...open) : waves, waves };
}

function changeRow(change: BoardChange, members: readonly BoardTreeRow[], byId: ReadonlyMap<string, BoardTreeRow>): ChangeOverviewRow {
  const counts = countStatuses(members, byId);
  const closed = !!change.closed_at || (members.length > 0 && members.every((row) => row.status === "done"));
  const cost = members.reduce((sum, row) => sum + costOf(row), 0);
  const budget = Number.isFinite(change.budget_usd) ? (change.budget_usd as number) : null;
  return {
    id: change.id,
    number: change.number,
    title: change.title,
    counts,
    done: counts.done,
    total: members.length,
    ...changeWave(members),
    status: changeStatus(closed, counts),
    cost,
    budget,
    over: budget !== null && cost > budget,
    closed,
  };
}

function averageCost(rows: readonly BoardTreeRow[], from: string | null, to: string): { value: number | null; count: number } {
  const closed = rows.filter((row) => {
    const day = (row.closed_at ?? "").slice(0, 10);
    return row.status === "done" && !!day && (from === null || day >= from) && day <= to && costOf(row) > 0;
  });
  if (!closed.length) return { value: null, count: 0 };
  return { value: closed.reduce((sum, row) => sum + costOf(row), 0) / closed.length, count: closed.length };
}

export function closedTaskAverage(rows: readonly BoardTreeRow[], period: OverviewPeriod, today: string): ClosedTaskAverage {
  const range = periodRange(period, today);
  const current = averageCost(rows, range.from, range.to);
  if (range.from === null || range.days === null) return { value: current.value, previous: null, delta: null, count: current.count };
  const previous = averageCost(rows, shiftDay(range.from, -range.days), shiftDay(range.from, -1));
  const delta = current.value !== null && previous.value ? (current.value - previous.value) / previous.value : null;
  return { value: current.value, previous: previous.value, delta, count: current.count };
}

function attentionItems(
  project: string,
  rows: readonly BoardTreeRow[],
  changes: readonly ChangeOverviewRow[],
  changeNumber: ReadonlyMap<string, number>,
  today: string,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  const changeOf = (row: BoardTreeRow) => (row.change_id ? changeNumber.get(row.change_id) ?? null : null);
  for (const row of rows) {
    if (row.status !== "review") continue;
    seen.add(row.id);
    items.push({ kind: "review", taskId: row.id, number: row.number, title: row.subject, change: changeOf(row) });
  }
  for (const change of changes) {
    if (change.closed || !change.over || change.budget === null) continue;
    items.push({ kind: "over_budget", changeId: change.id, number: change.number, title: change.title, cost: change.cost, budget: change.budget });
  }
  const projectRows = projectTodos(rows, { ...defaultTodoFilters(), project: [project] }, { today }).visible;
  for (const row of projectRows.filter((item) => attentionKinds(item, today).includes("overdue"))) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    items.push({ kind: "overdue", taskId: row.id, number: row.number, title: row.subject, change: changeOf(row), since: (row.scheduled_for ?? "").slice(0, 10) });
  }
  for (const row of projectRows.filter((item) => attentionKinds(item, today).includes("stale"))) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    items.push({ kind: "stale", taskId: row.id, number: row.number, title: row.subject, change: changeOf(row), days: daysBetween(row.updated_at.slice(0, 10), today) });
  }
  return items;
}

export function projectOverview(
  project: string,
  rows: readonly BoardTreeRow[],
  changes: readonly BoardChange[],
  period: OverviewPeriod,
  today: string,
): ProjectOverview {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const projectRows = rows.filter((row) => !row.change && projectOf(row) === project);
  const membersByChange = new Map<string, BoardTreeRow[]>();
  for (const row of rows) {
    if (row.change || !row.change_id) continue;
    const members = membersByChange.get(row.change_id) ?? [];
    members.push(row);
    membersByChange.set(row.change_id, members);
  }
  const changeRows = changes
    .filter((change) => {
      const members = membersByChange.get(change.id) ?? [];
      const owner = members[0] ? projectOf(members[0]) : change.project ?? "";
      return owner === project;
    })
    .map((change) => changeRow(change, membersByChange.get(change.id) ?? [], byId))
    .sort((left, right) => Number(left.closed) - Number(right.closed) || right.number - left.number);
  const counts = countStatuses(projectRows, byId);
  const open = changeRows.filter((change) => !change.closed);
  return {
    tasks: { done: counts.done, total: projectRows.length, counts },
    openChanges: open.length,
    overBudget: open.filter((change) => change.over).length,
    average: closedTaskAverage(projectRows, period, today),
    changes: changeRows,
    attention: attentionItems(project, projectRows, changeRows, new Map(changeRows.map((change) => [change.id, change.number])), today),
  };
}

export function filterChangeRows(rows: readonly ChangeOverviewRow[], closed: boolean, query: string): ChangeOverviewRow[] {
  const normalized = query.trim().toLocaleLowerCase();
  const numeric = parseRef(normalized);
  return rows.filter((row) => {
    if (row.closed !== closed) return false;
    if (!normalized) return true;
    if (numeric !== null) return String(row.number).includes(String(numeric));
    return row.title.toLocaleLowerCase().includes(normalized) || formatRef(row).includes(normalized);
  });
}

export interface DayCost {
  date: string;
  cost: number;
}

export function fillDays(points: readonly DayCost[], from: string | null, to: string): DayCost[] {
  const byDate = new Map(points.map((point) => [point.date, point.cost]));
  const start = from ?? points.map((point) => point.date).sort()[0] ?? to;
  const days: DayCost[] = [];
  for (let day = start; day <= to; day = shiftDay(day, 1)) days.push({ date: day, cost: byDate.get(day) ?? 0 });
  return days;
}
