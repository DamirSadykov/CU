import { describe, expect, it } from "vitest";
import { compareTasks, dayBucket, isFresh, relativeTime, sortHasBuckets, taskTime, type SortableTask } from "./taskSort";

const now = new Date(2026, 9, 17, 15, 0).getTime();
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const tasks: SortableTask[] = [
  { id: "a", number: 3, created_at: at(100), updated_at: at(1), cost: 2 },
  { id: "b", number: 1, created_at: at(10), updated_at: at(50), cost: 9 },
  { id: "c", number: 2, created_at: at(200), updated_at: at(5), cost: 0 },
];
const order = (sort: Parameters<typeof compareTasks>[0]) => [...tasks].sort(compareTasks(sort)).map((task) => task.id);

describe("compareTasks", () => {
  it("orders by each of the five sorts", () => {
    expect(order("updated")).toEqual(["a", "c", "b"]);
    expect(order("created")).toEqual(["b", "a", "c"]);
    expect(order("oldest")).toEqual(["b", "c", "a"]);
    expect(order("number")).toEqual(["b", "c", "a"]);
    expect(order("cost")).toEqual(["b", "a", "c"]);
  });

  it("reads the creation time for the newest sort and the activity time otherwise", () => {
    expect(taskTime(tasks[0], "created")).toBe(tasks[0].created_at);
    expect(taskTime(tasks[0], "oldest")).toBe(tasks[0].updated_at);
    expect(taskTime({ id: "x", created_at: "2026-01-01" }, "updated")).toBe("2026-01-01");
  });

  it("groups by day only for time sorts", () => {
    expect(sortHasBuckets("updated")).toBe(true);
    expect(sortHasBuckets("number")).toBe(false);
    expect(sortHasBuckets("cost")).toBe(false);
  });
});

describe("dayBucket", () => {
  it("uses calendar days for today and yesterday, elapsed days after that", () => {
    expect(dayBucket(at(14), now)).toBe("today");
    expect(dayBucket(at(16), now)).toBe("yesterday");
    expect(dayBucket(at(24 * 5), now)).toBe("week");
    expect(dayBucket(at(24 * 20), now)).toBe("month");
    expect(dayBucket(at(24 * 40), now)).toBe("earlier");
  });
});

describe("relativeTime", () => {
  it("speaks in minutes, hours, yesterday, days and then a date", () => {
    expect(relativeTime(at(0.2), now)).toEqual({ unit: "minute", value: 12 });
    expect(relativeTime(at(0), now)).toEqual({ unit: "minute", value: 1 });
    expect(relativeTime(at(3), now)).toEqual({ unit: "hour", value: 3 });
    expect(relativeTime(at(16), now)).toEqual({ unit: "yesterday" });
    expect(relativeTime(at(24 * 3), now)).toEqual({ unit: "day", value: 3 });
    expect(relativeTime(at(24 * 9), now)).toMatchObject({ unit: "date" });
  });

  it("marks under six hours as fresh", () => {
    expect(isFresh(at(5), now)).toBe(true);
    expect(isFresh(at(7), now)).toBe(false);
  });
});
