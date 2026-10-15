import { describe, it, expect, vi, beforeEach } from "vitest";

const stores = new Map<string, Map<string, unknown>>();

function storeFor(name: string) {
    if (!stores.has(name)) stores.set(name, new Map());
    const data = stores.get(name)!;
    return {
        reload: async () => {},
        get: async (key: string) => data.get(key),
        set: async (key: string, value: unknown) => { data.set(key, value); },
        delete: async (key: string) => data.delete(key),
        save: async () => {},
    };
}

vi.mock("@tauri-apps/plugin-store", () => ({ load: async (name: string) => storeFor(name) }));

import { readSettingsSnapshot } from "./settingsStore";

function seed(name: string, entries: Record<string, unknown>) {
    stores.set(name, new Map(Object.entries(entries)));
}

describe("settings migration to structured keys", () => {
    beforeEach(() => stores.clear());

    it("flat legacy keys become structured settings and are removed", async () => {
        seed("settings.json", {
            quietHoursEnabled: true,
            quietHoursStart: "22:00",
            quietHoursEnd: "07:00",
            dailyBudgetEnabled: true,
            dailyBudget: 12,
            runtimeInsightsEnabled: true,
            runtimeInsightKinds: ["long_session"],
            specsEnabled: true,
            specDeltaGuard: "off",
        });
        const s = await readSettingsSnapshot();
        expect(s.quietHours).toEqual({ enabled: true, start: "22:00", end: "07:00" });
        expect(s.dailyBudget).toBe(12);
        expect(s.runtimeInsights).toEqual({ enabled: true, kinds: ["long_session"] });
        expect(s.specs).toEqual({ enabled: true, deltaGuard: "off" });
        const left = [...stores.get("settings.json")!.keys()].sort();
        expect(left).toEqual(["dailyBudget", "quietHours", "runtimeInsights", "specs"]);
    });

    it("a partial structured key keeps its fields and takes the missing ones from legacy keys", async () => {
        seed("settings.json", {
            quietHours: { enabled: true },
            quietHoursStart: "21:30",
            quietHoursEnd: "06:45",
            runtimeInsights: { enabled: true },
            runtimeInsightKinds: ["cold_rewrites"],
            specs: { deltaGuard: "off" },
            specsEnabled: true,
        });
        const s = await readSettingsSnapshot();
        expect(s.quietHours).toEqual({ enabled: true, start: "21:30", end: "06:45" });
        expect(s.runtimeInsights).toEqual({ enabled: true, kinds: ["cold_rewrites"] });
        expect(s.specs).toEqual({ enabled: true, deltaGuard: "off" });
    });

    it("a disabled legacy budget becomes null", async () => {
        seed("settings.json", { dailyBudgetEnabled: false, dailyBudget: 5 });
        const s = await readSettingsSnapshot();
        expect(s.dailyBudget).toBeNull();
    });

    it("runtime values move to runtime-state.json without overwriting newer ones", async () => {
        seed("settings.json", { projectId: "old", notificationsMutedUntil: "2026-10-14T10:00:00Z" });
        seed("runtime-state.json", { projectId: "new" });
        const s = await readSettingsSnapshot();
        expect(s.projectId).toBe("new");
        expect(s.notificationsMutedUntil).toBe("2026-10-14T10:00:00Z");
        expect(stores.get("settings.json")!.size).toBe(0);
    });
});
