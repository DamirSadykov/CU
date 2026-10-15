import { describe, it, expect } from "vitest";
import { WORK_MODES, deriveWorkMode, workModeChanges, type WorkModeState } from "./workMode";

const custom: WorkModeState = {
    hookContextEnabled: true,
    workflowContextEnabled: true,
    runnerEnabled: true,
    architectMode: "off",
    reviewMode: "off",
};

describe("work mode", () => {
    it.each(WORK_MODES)("applying %s from any state reads back as %s", (mode) => {
        for (const start of [custom, { ...custom, hookContextEnabled: false }, { ...custom, runnerEnabled: false, architectMode: "agent" }]) {
            expect(deriveWorkMode({ ...start, ...workModeChanges(mode) })).toBe(mode);
        }
    });

    it("a fresh install reads as tasks in session", () => {
        expect(deriveWorkMode({ hookContextEnabled: true, workflowContextEnabled: false, runnerEnabled: true, architectMode: "off", reviewMode: "off" })).toBe("tasks");
    });

    it("workflow without the architect gate is custom", () => {
        expect(deriveWorkMode(custom)).toBe("custom");
    });

    it("the runner without review is custom", () => {
        expect(deriveWorkMode({ ...custom, architectMode: "agent" })).toBe("custom");
    });

    it("plan mode leaves the review duty as it was", () => {
        expect(workModeChanges("plan")).not.toHaveProperty("reviewMode");
        expect(deriveWorkMode({ ...custom, runnerEnabled: false, architectMode: "agent", reviewMode: "agent" })).toBe("plan");
    });
});
