import type { BoardIndexes } from "./boardStore";
import { parsePlanRef } from "../../scripts/cli/kernel/terms.mjs";

export const TODO_STATUSES = ["backlog", "queue", "in_progress", "review", "done"] as const;
export type TodoStatus = typeof TODO_STATUSES[number];

export const TODO_VIEWS = ["active", "attention", "done", "all"] as const;
export type TodoView = typeof TODO_VIEWS[number];

export const TODO_PRIORITIES = ["high", "medium", "low"] as const;

export const CREATED_WINDOWS = ["1", "7", "30"] as const;
export type CreatedWindow = typeof CREATED_WINDOWS[number];

export const TODO_FACETS = ["status", "project", "priority", "created"] as const;
export type TodoFacet = typeof TODO_FACETS[number];

export interface TodoFilters {
  view: TodoView;
  status: string[];
  project: string[];
  priority: string[];
  created: CreatedWindow | "";
  query: string;
}

export const defaultTodoFilters = (): TodoFilters => ({
  view: "active", status: [], project: [], priority: [], created: "", query: "",
});

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item !== ""))] : [];

export function normalizeTodoFilters(value: unknown): TodoFilters {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const view = TODO_VIEWS.includes(raw.view as TodoView) ? raw.view as TodoView : "active";
  const created = CREATED_WINDOWS.includes(raw.created as CreatedWindow) ? raw.created as CreatedWindow : "";
  return {
    view,
    status: stringList(raw.status).filter((status) => (TODO_STATUSES as readonly string[]).includes(status)),
    project: stringList(raw.project),
    priority: stringList(raw.priority).filter((priority) => (TODO_PRIORITIES as readonly string[]).includes(priority)),
    created,
    query: typeof raw.query === "string" ? raw.query : "",
  };
}

export function activeFacetCount(filters: TodoFilters): number {
  return TODO_FACETS.filter((facet) => facetSelection(filters, facet).length > 0).length;
}

export function facetSelection(filters: TodoFilters, facet: TodoFacet): readonly string[] {
  return facet === "created" ? (filters.created ? [filters.created] : []) : filters[facet];
}

export function toggleFacet(filters: TodoFilters, facet: TodoFacet, value: string): TodoFilters {
  if (facet === "created") return { ...filters, created: filters.created === value ? "" : value as CreatedWindow };
  const current = filters[facet];
  return { ...filters, [facet]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] };
}

export const clearFacets = (filters: TodoFilters): TodoFilters => ({ ...filters, status: [], project: [], priority: [], created: "", query: "" });

export interface FilterableTodoRow {
  id: string; number?: number; subject: string; description: string; status: string;
  priority?: string; project?: string | null; change?: boolean; change_id?: string | null; created_at: string;
  updated_at: string; scheduled_for?: string | null; created_by?: string;
  closed_at?: string | null;
  filterProject?: string | null;
}
export interface TodoProjection<T extends FilterableTodoRow = FilterableTodoRow> {
  columns: Record<TodoStatus, T[]>;
  visible: T[];
}

export interface TodoCardRow extends FilterableTodoRow {
  from?: string | null;
  aliases: string[];
  mergedInto?: string | null;
  refCount: number;
  cost?: number;
  costTitle?: string;
  importedAt?: string | null;
  hasPlan: boolean;
  spec: string[];
}

export interface PlanLabel {
  number: number;
  title: string;
}

export interface TodoFilterContext {
  indexes?: Pick<BoardIndexes, "search">;
  plans?: ReadonlyMap<string, PlanLabel>;
  today?: string;
}

const emptyColumns = <T>(): Record<TodoStatus, T[]> => ({
  backlog: [], queue: [], in_progress: [], review: [], done: [],
});

function datePart(value: string | null | undefined): string { return (value ?? "").slice(0, 10); }

export type AttentionKind = "overdue" | "stale" | "no_priority";

const ACTIVE_STATUSES = new Set(["queue", "in_progress", "review"]);

export function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function daysBefore(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export function attentionKinds(row: FilterableTodoRow, today = localToday()): AttentionKind[] {
  const kinds: AttentionKind[] = [];
  if (row.status !== "done" && !!row.scheduled_for && datePart(row.scheduled_for) < today) kinds.push("overdue");
  if (ACTIVE_STATUSES.has(row.status) && datePart(row.updated_at) < daysBefore(today, 14)) kinds.push("stale");
  if (ACTIVE_STATUSES.has(row.status) && !row.priority) kinds.push("no_priority");
  return kinds;
}

export const needsAttention = (row: FilterableTodoRow, today = localToday()): boolean => attentionKinds(row, today).length > 0;

function viewMatches(row: FilterableTodoRow, view: TodoView, today: string): boolean {
  if (view === "active") return row.status !== "done";
  if (view === "attention") return needsAttention(row, today);
  if (view === "done") return row.status === "done";
  return true;
}

function facetMatches(row: FilterableTodoRow, filters: TodoFilters, facet: TodoFacet, today: string): boolean {
  const selected = facetSelection(filters, facet);
  if (!selected.length) return true;
  if (facet === "status") return selected.includes(row.status);
  if (facet === "project") return selected.includes((row.filterProject ?? row.project) || "");
  if (facet === "priority") return selected.includes(row.priority ?? "");
  return datePart(row.created_at) >= daysBefore(today, Number(selected[0]) - 1);
}

function planOf(row: FilterableTodoRow, plans: ReadonlyMap<string, PlanLabel> | undefined): PlanLabel | undefined {
  if (!plans) return undefined;
  return (row.change_id ? plans.get(row.change_id) : undefined) ?? (row.change ? plans.get(row.id) : undefined);
}

function queryMatches(row: FilterableTodoRow, rawQuery: string, context: TodoFilterContext): boolean {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return true;
  const plan = planOf(row, context.plans);
  const planNumber = parsePlanRef(query);
  if (planNumber !== null) return plan?.number === planNumber;
  const numberQuery = query.replace(/^#/, "");
  if (/^\d+$/.test(numberQuery)) return String(row.number ?? "").startsWith(numberQuery);
  const haystack = context.indexes?.search.get(row.id)
    ?? [row.number, row.subject, row.description, row.project ?? ""].join(" ").toLocaleLowerCase();
  return haystack.includes(query) || !!plan?.title.toLocaleLowerCase().includes(query);
}

export function matchesTodoFilters(
  row: FilterableTodoRow, filters: TodoFilters, context: TodoFilterContext = {}, skip?: TodoFacet | "view",
): boolean {
  const today = context.today ?? localToday();
  if (skip !== "view" && !viewMatches(row, filters.view, today)) return false;
  for (const facet of TODO_FACETS) {
    if (facet !== skip && !facetMatches(row, filters, facet, today)) return false;
  }
  return queryMatches(row, filters.query, context);
}

export function projectTodos<T extends FilterableTodoRow>(
  rows: readonly T[], filters: TodoFilters, context: TodoFilterContext = {},
): TodoProjection<T> {
  const columns = emptyColumns<T>();
  const visible: T[] = [];
  const scoped = { ...context, today: context.today ?? localToday() };
  for (const row of rows) {
    if (!matchesTodoFilters(row, filters, scoped)) continue;
    const column = columns[row.status as TodoStatus];
    if (!column) continue;
    column.push(row);
    visible.push(row);
  }
  for (const status of TODO_STATUSES) {
    columns[status].sort((a, b) => {
      if (status === "done") {
        return (b.closed_at || "").localeCompare(a.closed_at || "")
          || (b.updated_at || "").localeCompare(a.updated_at || "");
      }
      const left = a.scheduled_for || "9999-99-99";
      const right = b.scheduled_for || "9999-99-99";
      return left === right ? (b.updated_at || "").localeCompare(a.updated_at || "") : left.localeCompare(right);
    });
  }
  return { columns, visible };
}

export function viewCounts<T extends FilterableTodoRow>(
  rows: readonly T[], filters: TodoFilters, context: TodoFilterContext = {},
): Record<TodoView, number> {
  const today = context.today ?? localToday();
  const counts: Record<TodoView, number> = { active: 0, attention: 0, done: 0, all: 0 };
  for (const row of rows) {
    if (!matchesTodoFilters(row, filters, { ...context, today }, "view")) continue;
    for (const view of TODO_VIEWS) if (viewMatches(row, view, today)) counts[view] += 1;
  }
  return counts;
}

export type FacetCounts = Record<TodoFacet, Record<string, number>>;

export function facetCounts<T extends FilterableTodoRow>(
  rows: readonly T[], filters: TodoFilters, options: Readonly<Record<TodoFacet, readonly string[]>>, context: TodoFilterContext = {},
): FacetCounts {
  const today = context.today ?? localToday();
  const scoped = { ...context, today };
  const counts = Object.fromEntries(TODO_FACETS.map((facet) => [facet, Object.fromEntries(options[facet].map((option) => [option, 0]))])) as FacetCounts;
  for (const facet of TODO_FACETS) {
    for (const row of rows) {
      if (!matchesTodoFilters(row, filters, scoped, facet)) continue;
      for (const option of options[facet]) {
        if (facetMatches(row, toggleFacet({ ...filters, [facet]: facet === "created" ? "" : [] }, facet, option), facet, today)) counts[facet][option] += 1;
      }
    }
  }
  return counts;
}
