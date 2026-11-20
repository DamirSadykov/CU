import { createSSRApp, nextTick, ref } from "vue";
import { renderToString } from "@vue/server-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vue", async (original) => ({
  ...await original<typeof import("vue")>(),
  onMounted: vi.fn(),
  onUnmounted: vi.fn(),
  useSSRContext: () => ({}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../kernel/logging", () => ({ logWarn: vi.fn() }));
vi.mock("../kernel/settingsStore", () => ({
  useSettings: () => ({ settings, initSettings: vi.fn() }),
}));

import MiniPanel from "./MiniPanel.vue";
import { invoke } from "@tauri-apps/api/core";
import type { CodexRateLimits } from "../contracts/types";

const settings = ref({ sessionKey: "", orgId: "", miniProvider: "auto", ccAnalyticsEnabled: true });
const future = Math.floor(Date.now() / 1000) + 3600;
const limits: CodexRateLimits = {
  observedAt: new Date().toISOString(), limitId: "codex", planType: "plus",
  primary: { usedPercent: 42, windowMinutes: 300, resetsAt: future },
  secondary: { usedPercent: 73, windowMinutes: 10080, resetsAt: future },
  credits: null, rateLimitReachedType: null,
};

function setup() {
  return (MiniPanel as unknown as { setup: Function }).setup({}, { expose: vi.fn() });
}

describe("mini panel providers", () => {
  beforeEach(() => {
    settings.value = { sessionKey: "", orgId: "", miniProvider: "auto", ccAnalyticsEnabled: true };
  });

  it("automatically switches from Claude to Codex after credentials are cleared", async () => {
    settings.value.sessionKey = "key";
    settings.value.orgId = "org";
    const panel = setup();
    expect(panel.provider.value).toBe("claude");
    settings.value.sessionKey = "";
    await nextTick();
    expect(panel.provider.value).toBe("codex");
  });

  it.each(["claude", "codex"])("honours explicit %s selection", (provider) => {
    settings.value.miniProvider = provider;
    expect(setup().provider.value).toBe(provider);
  });

  it.each([true, false])("renders Codex quotas with system info %s", async (systemInfo) => {
    const panel = setup();
    panel.systemInfo.value = systemInfo;
    panel.codexLimits.value = limits;
    const html = await renderToString(createSSRApp({ ...MiniPanel, setup: () => panel }));
    expect(html).toContain("Codex");
    expect(html).toContain("42%");
    expect(html).toContain("73%");
    expect(html).toContain(systemInfo ? 'class="grid"' : 'class="row"');
  });

  it("exposes a Codex read failure in the tooltip", async () => {
    const panel = setup();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("limits unavailable"));
    await panel.loadCodexLimits();
    expect(panel.codexLimitsError.value).toContain("limits unavailable");
    const html = await renderToString(createSSRApp({ ...MiniPanel, setup: () => panel }));
    expect(html).toContain('title="Error: limits unavailable"');
  });

  it("keeps newer quotas when an older read fails late", async () => {
    const panel = setup();
    let fail!: (error: Error) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockResolvedValueOnce(limits);
    const pending = panel.loadCodexLimits();
    await panel.loadCodexLimits();
    fail(new Error("previous request"));
    await pending;
    expect(panel.codexLimits.value).toEqual(limits);
    expect(panel.codexLimitsError.value).toBe("");
  });

  it("places a weekly primary window in the weekly slot", async () => {
    const panel = setup();
    panel.codexLimits.value = {
      ...limits,
      primary: { usedPercent: 9, windowMinutes: 10080, resetsAt: future },
      secondary: null,
    };
    expect(panel.quotas.value.map((quota: { percent: number | null }) => quota.percent)).toEqual([null, 9]);
    const html = await renderToString(createSSRApp({ ...MiniPanel, setup: () => panel }));
    expect(html).toContain("9%");
  });

  it("preserves both short windows with their actual durations", () => {
    const panel = setup();
    panel.codexLimits.value = { ...limits, secondary: { ...limits.secondary!, windowMinutes: 1440 } };
    expect(panel.quotas.value.map((q: { label: string; percent: number }) => [q.label, q.percent]))
      .toEqual([["5h", 42], ["1d", 73]]);
  });

  it("shows missing windows as unavailable and clears expired consumption", () => {
    const panel = setup();
    panel.codexLimits.value = { ...limits, primary: { ...limits.primary!, resetsAt: 1 }, secondary: null };
    expect(panel.quotas.value.map((quota: { percent: number | null }) => quota.percent)).toEqual([0, null]);
    expect(panel.percentLabel(null)).toBe("—");
  });

  it.each([true, false])("renders Claude quotas with system info %s", async (systemInfo) => {
    settings.value.sessionKey = "key";
    settings.value.orgId = "org";
    const panel = setup();
    panel.systemInfo.value = systemInfo;
    panel.usage.value = { five_hour: { percent_used: 15 }, seven_day: { percent_used: 60 } };
    panel.levels.value = { five_hour: 0, seven_day: 2 };
    const html = await renderToString(createSSRApp({ ...MiniPanel, setup: () => panel }));
    expect(html).toContain("Claude");
    expect(html).toContain("15%");
    expect(html).toContain("60%");
  });

  it("does not display Codex data when local analytics are disabled", () => {
    const panel = setup();
    panel.codexLimits.value = limits;
    settings.value.ccAnalyticsEnabled = false;
    expect(panel.quotas.value.every((quota: { percent: number | null }) => quota.percent === null)).toBe(true);
  });
});
