export type WorkMode = "tracking" | "tasks" | "plan" | "runner";

export const WORK_MODES: WorkMode[] = ["tracking", "tasks", "plan", "runner"];

export interface WorkModeState {
    hookContextEnabled: boolean;
    workflowContextEnabled: boolean;
    runnerEnabled: boolean;
    architectMode: string;
    reviewMode: string;
}

export function workModeChanges(mode: WorkMode): Partial<WorkModeState> {
    switch (mode) {
        case "tracking":
            return { hookContextEnabled: false };
        case "tasks":
            return { hookContextEnabled: true, workflowContextEnabled: false };
        case "plan":
            return { hookContextEnabled: true, workflowContextEnabled: true, runnerEnabled: false, architectMode: "agent" };
        case "runner":
            return {
                hookContextEnabled: true,
                workflowContextEnabled: true,
                runnerEnabled: true,
                architectMode: "agent",
                reviewMode: "agent",
            };
    }
}

export function deriveWorkMode(state: WorkModeState): WorkMode | "custom" {
    if (!state.hookContextEnabled) return "tracking";
    if (!state.workflowContextEnabled) return "tasks";
    if (state.architectMode !== "agent") return "custom";
    if (!state.runnerEnabled) return "plan";
    return state.reviewMode === "agent" ? "runner" : "custom";
}
