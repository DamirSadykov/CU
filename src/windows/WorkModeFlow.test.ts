import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const flowSource = readFileSync(new URL("./WorkModeFlow.vue", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./SettingsPanel.vue", import.meta.url), "utf8");

describe("work mode flow", () => {
  it("shows the complete human-to-reviewer flow without Mermaid", () => {
    for (const stage of ["human", "session", "architect", "runner", "worker", "reviewer"]) {
      expect(flowSource).toContain(`"${stage}"`);
    }
    expect(flowSource).not.toMatch(/mermaid/i);
  });

  it("defines the acting order explicitly for each mode", () => {
    expect(flowSource).toContain('tracking: ["human"]');
    expect(flowSource).toContain('tasks: ["human", "session"]');
    expect(flowSource).toContain('plan: ["human", "architect", "session"]');
    expect(flowSource).toContain('runner: ["human", "session", "architect", "runner", "worker", "reviewer"]');
    expect(flowSource).toContain("index < activeRoute.length - 1");
  });

  it("opens the diagram from the same click that applies a mode", () => {
    expect(settingsSource).toContain('@click="selectWorkMode(m)"');
    expect(settingsSource).toContain("selectedWorkMode.value = mode");
    expect(settingsSource).toContain('<WorkModeFlow v-if="selectedWorkMode" :mode="selectedWorkMode" />');
  });
});
