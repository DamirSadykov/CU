import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSSRApp, ref } from "vue";
import { renderToString } from "@vue/server-renderer";

const { invoke, emit, set, save } = vi.hoisted(() => {
    vi.stubGlobal("window", { location: { hash: "" } });
    return { invoke: vi.fn(), emit: vi.fn(), set: vi.fn(), save: vi.fn() };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("ru") }) }));
vi.mock("vue", async (original) => ({
    ...await original<typeof import("vue")>(),
    onMounted: vi.fn(),
    onUnmounted: vi.fn(),
    useSSRContext: () => ({}),
}));
vi.mock("./kernel/updater", () => ({ useUpdater: () => ({}), initUpdater: vi.fn() }));
vi.mock("./kernel/logging", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("./kernel/settingsStore", async (original) => ({
    ...await original<typeof import("./kernel/settingsStore")>(),
    loadSettingsStoreForWrite: async () => ({ set, save }),
    loadRuntimeStoreForWrite: async () => ({ set, save }),
}));
vi.mock("./windows/SettingsWindow.vue", () => ({ default: {} }));
vi.mock("./windows/MiniPanel.vue", () => ({ default: {} }));
vi.mock("./windows/AnalyticsWindow.vue", () => ({ default: {} }));
vi.mock("./windows/TodoWindow.vue", () => ({ default: {} }));
vi.mock("./windows/AboutPanel.vue", () => ({ default: {} }));
vi.mock("./windows/KitWindow.vue", () => ({ default: {} }));
vi.mock("./process/pipeline/PipelineWindow.vue", () => ({ default: {} }));
vi.mock("./analytics/AnalyticsPanel.vue", () => ({ default: {} }));
vi.mock("./analytics/ServiceStatusBar.vue", () => ({ default: { render: () => null } }));

import App from "./App.vue";
import { defaultSettings } from "./kernel/settingsStore";

function setup() {
    return (App as unknown as { setup: Function }).setup({}, { expose: vi.fn() });
}

describe("optional Claude connection", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        invoke.mockResolvedValue(null);
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it("persists cleared credentials, disables Claude polling and keeps Codex available", async () => {
        const app = setup();
        app.sessionKey.value = "old-key";
        app.orgId.value = "old-org";
        app.projectId.value = "old-project";
        app.usage.value = { five_hour: { percent_used: 50 } };
        app.error.value = "old Claude error";
        app.sessionExpired.value = true;
        app.forecast.value = {};

        await app.handleSave({ ...defaultSettings(), ccAnalyticsEnabled: true });

        expect(set).toHaveBeenCalledWith("sessionKey", "");
        expect(set).toHaveBeenCalledWith("orgId", "");
        expect(set).toHaveBeenCalledWith("projectId", "");
        expect(set).toHaveBeenCalledWith("miniProvider", "auto");
        expect(save).toHaveBeenCalled();
        expect(invoke).toHaveBeenCalledWith("configure", {
            config: expect.objectContaining({ session_key: "", org_id: "", service_status_enabled: false }),
        });
        expect(app.usage.value).toBeNull();
        expect(app.forecast.value).toBeNull();
        expect(app.error.value).toBe("");
        expect(app.sessionExpired.value).toBe(false);
        expect(app.loading.value).toBe(false);
        expect(invoke).toHaveBeenCalledWith("get_codex_limits", { enabled: true });
        expect(emit).toHaveBeenCalledWith("settings-changed");
    });

    it("applies independent settings without a Claude account", async () => {
        const app = setup();
        await app.handleKeepAwakeChange(true);
        expect(invoke).toHaveBeenCalledWith("configure", {
            config: expect.objectContaining({ session_key: "", keep_awake_enabled: true }),
        });
    });

    it("refreshes Codex without requesting Claude usage", async () => {
        const app = setup();
        app.ccAnalyticsEnabled.value = true;
        await app.refresh();
        expect(invoke).toHaveBeenCalledWith("get_codex_limits", { enabled: true });
        expect(invoke).not.toHaveBeenCalledWith("refresh_now");
    });

    it("ignores a late limits response after Codex is disabled", async () => {
        const app = setup();
        app.ccAnalyticsEnabled.value = true;
        let finish!: (value: unknown) => void;
        invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const pending = app.loadCodexLimits();
        app.ccAnalyticsEnabled.value = false;
        await app.loadCodexLimits();
        finish({ planType: "old" });
        await pending;
        expect(app.codexLimits.value).toBeNull();
        expect(app.codexLimitsError.value).toBe("");
    });

    it("continues configuring Claude when both credentials are present", async () => {
        const app = setup();
        await app.handleSave({ ...defaultSettings(), sessionKey: "key", orgId: "org" });
        expect(invoke).toHaveBeenCalledWith("configure", {
            config: expect.objectContaining({ session_key: "key", org_id: "org", service_status_enabled: true }),
        });
        expect(app.loading.value).toBe(true);
    });

    it("offers provider setup without requiring Claude when no usage is available", async () => {
        const app = setup();
        app.providerDetectionReady.value = true;
        const html = await renderToString(createSSRApp({ ...App, setup: () => app }));
        expect(html).toContain("chooseProvider");
        expect(html).toContain("providerCodex");
        expect(html).not.toContain('aria-label="Claude"');
        expect(html).not.toContain("focusTitle");
    });

    it.each(["missing", "failed"])("leaves setup after confirming Codex with %s limits", async (state) => {
        const app = setup();
        app.providerDetectionReady.value = true;
        app.providerSelection.value = "codex";
        invoke.mockImplementation(async (command) => {
            if (command === "get_codex_limits" && state === "failed") throw new Error("read failed");
            return null;
        });
        await app.confirmProviderSelection();
        expect(set).toHaveBeenCalledWith("providerSelection", "codex");
        expect(set).toHaveBeenCalledWith("ccAnalyticsEnabled", true);
        expect(app.showProviderSetup.value).toBe(false);
        const html = await renderToString(createSSRApp({ ...App, setup: () => app }));
        expect(html).not.toContain("chooseProvider");
        expect(html).toContain('aria-label="Codex"');
        expect(html).toContain(state === "failed" ? "codexLimitsFailed" : "codexLimitsPending");
        if (state === "failed") expect(html).toContain("read failed");
    });

    it("shows a saved Codex selection without reopening setup when limits are absent", async () => {
        const app = setup();
        app.savedProviderSelection.value = "codex";
        app.ccAnalyticsEnabled.value = true;
        const html = await renderToString(createSSRApp({ ...App, setup: () => app }));
        expect(html).not.toContain("chooseProvider");
        expect(html).toContain("codexLimitsPending");
    });

    it.each(["claude", "codex", "both"])("keeps focus and notification controls available for %s without usage", async (provider) => {
        const app = setup();
        app.savedProviderSelection.value = provider;
        app.ccAnalyticsEnabled.value = provider !== "claude";
        const html = await renderToString(createSSRApp({ ...App, setup: () => app }));
        expect(html.match(/class="cards focus-controls"/g)).toHaveLength(1);
        expect(html).toContain("focusTitle");
        expect(html).toContain("focusStart");
        expect(html).toContain("pauseNotif");
        expect(html).toContain("pause30m");
    });

    it("labels a weekly primary window as weekly", async () => {
        const app = setup();
        app.savedProviderSelection.value = "codex";
        app.codexLimits.value = {
            primary: { usedPercent: 9, windowMinutes: 10080, resetsAt: 9999999999 },
            secondary: null,
        };
        const html = await renderToString(createSSRApp({ ...App, setup: () => app }));
        expect(html).toContain("codexWeekly");
        expect(html).not.toContain("codexSession5h");
        expect(html).toContain("9.0%");
    });

    it("does not label a daily secondary window as weekly", async () => {
        const app = setup();
        app.savedProviderSelection.value = "codex";
        app.codexLimits.value = {
            primary: null, secondary: { usedPercent: 12, windowMinutes: 1440, resetsAt: 9999999999 },
        };
        const html = await renderToString(createSSRApp({ ...App, setup: () => app }));
        expect(html).toContain("codexWindowMinutes");
        expect(html).not.toContain("codexWeekly");
        expect(html).toContain("12.0%");
    });

    it.each(["disconnected", "loading", "error", "ready"])("keeps Codex separate while Claude is %s", async (state) => {
        const app = setup();
        app.savedProviderSelection.value = "codex";
        app.codexLimits.value = {
            primary: { usedPercent: 42, windowMinutes: 300, resetsAt: 9999999999 },
            secondary: null,
        };
        if (state !== "disconnected") {
            app.sessionKey.value = "key";
            app.orgId.value = "org";
        }
        if (state === "error") app.error.value = "Claude unavailable";
        if (state === "ready") {
            app.usage.value = {
                five_hour: { percent_used: 25, reset_at: null },
                seven_day: { percent_used: 50, reset_at: null },
                seven_day_opus: null, seven_day_sonnet: null, scoped_weekly: [],
                extra_usage: null, prepaid_balance: null, prepaid_currency: null,
            };
            app.levels.value = { five_hour: 1, seven_day: 2 };
        }
        const html = await renderToString(createSSRApp({ ...App, setup: () => app }));
        expect(html.match(/aria-label="Codex"/g)).toHaveLength(1);
        expect(html.match(/class="card codex-card"/g)).toHaveLength(1);
        expect(html.includes('aria-label="Claude"')).toBe(state !== "disconnected");
        expect(html).not.toContain("configureClaude");
        expect(html.match(/class="cards focus-controls"/g)).toHaveLength(1);
        expect(html).toContain("focusStart");
        expect(html).toContain("pauseNotif");
    });
});
