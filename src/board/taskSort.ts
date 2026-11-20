export const TODO_SORTS = ["updated", "created", "oldest", "number", "cost"] as const;
export type TodoSort = typeof TODO_SORTS[number];

export const TODO_DISPLAYS = ["tree", "feed"] as const;
export type TodoDisplay = typeof TODO_DISPLAYS[number];

export interface SortableTask {
  id: string;
  number?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  cost?: number | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function taskTime(row: SortableTask, sort: TodoSort): string {
  return (sort === "created" ? row.created_at : row.updated_at || row.created_at) || "";
}

const stamp = (value: string) => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
};
const numberOf = (row: SortableTask) => row.number ?? 0;
const costOf = (row: SortableTask) => Number.isFinite(row.cost) ? row.cost as number : 0;

export function compareTasks(sort: TodoSort): (left: SortableTask, right: SortableTask) => number {
  const byNumber = (left: SortableTask, right: SortableTask) => numberOf(left) - numberOf(right) || left.id.localeCompare(right.id);
  const newest = (left: SortableTask, right: SortableTask) =>
    stamp(taskTime(right, "updated")) - stamp(taskTime(left, "updated")) || numberOf(right) - numberOf(left);
  switch (sort) {
    case "created": return (left, right) => stamp(taskTime(right, "created")) - stamp(taskTime(left, "created")) || numberOf(right) - numberOf(left);
    case "oldest": return (left, right) => stamp(taskTime(left, "oldest")) - stamp(taskTime(right, "oldest")) || byNumber(left, right);
    case "number": return byNumber;
    case "cost": return (left, right) => costOf(right) - costOf(left) || newest(left, right);
    default: return newest;
  }
}

export const sortHasBuckets = (sort: TodoSort): boolean => sort !== "number" && sort !== "cost";

export const DAY_BUCKETS = ["today", "yesterday", "week", "month", "earlier"] as const;
export type DayBucket = typeof DAY_BUCKETS[number];

const startOfDay = (time: number) => {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const calendarDaysAgo = (time: number, now: number) => Math.round((startOfDay(now) - startOfDay(time)) / DAY);

export function dayBucket(value: string, now = Date.now()): DayBucket {
  const time = stamp(value);
  const days = calendarDaysAgo(time, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (now - time < 7 * DAY) return "week";
  if (now - time < 30 * DAY) return "month";
  return "earlier";
}

export type RelativeTime =
  | { unit: "minute" | "hour" | "day"; value: number }
  | { unit: "yesterday" }
  | { unit: "date"; value: Date };

export function relativeTime(value: string, now = Date.now()): RelativeTime {
  const time = stamp(value);
  const elapsed = Math.max(0, now - time);
  if (elapsed < HOUR) return { unit: "minute", value: Math.max(1, Math.round(elapsed / 60_000)) };
  const days = calendarDaysAgo(time, now);
  if (days <= 0) return { unit: "hour", value: Math.max(1, Math.round(elapsed / HOUR)) };
  if (days === 1) return { unit: "yesterday" };
  if (days < 7) return { unit: "day", value: days };
  return { unit: "date", value: new Date(time) };
}

export const isFresh = (value: string, now = Date.now()): boolean => now - stamp(value) < 6 * HOUR;
