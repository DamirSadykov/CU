import { ref } from "vue";
import type { Ref } from "vue";
import {
    normalize,
    normalizeAlertTiers,
    normalizeAlertTypes,
} from "./thresholds";
import type { AlertTiers, AlertTypes } from "./thresholds";
import settingsContract from "../../scripts/cli/kernel/settings-contract.json";

export type FlowLanguage = "cs" | "rs" | "ts" | "js";
export const FLOW_LANGUAGES: readonly FlowLanguage[] = ["cs", "rs", "ts", "js"];
export const DEFAULT_FLOW_LANGUAGES: readonly FlowLanguage[] = ["ts", "js"];

export type QuietHoursSetting = { enabled: boolean; start: string; end: string };
export type RuntimeInsightsSetting = { enabled: boolean; kinds: string[] };
export type SpecsSetting = { enabled: boolean; deltaGuard: "on" | "off" };
export type ProviderSelection = "claude" | "codex" | "both";

// Single read-only access layer for settings.json (issue: unify settings reads).
//
// Why this exists: every window (App, Settings, Todos, Analytics, Mini, …) is its
// own WebView with its own JS heap, and each one used to re-implement the same
// ~30 `store.get(key) ?? default` reads plus the same normalization. That drifted
// (a default fixed in one window, missed in another) and a plain in-process event
// bus can't help — it doesn't cross WebViews. The cross-window signal is Tauri's
// `settings-changed` event, already emitted by the single writer (the main window)
// after every persisted change.
//
// So this module centralizes the SCHEMA (keys, defaults, normalization, one-shot
// migrations) in `readSettingsSnapshot()`, and layers a reactive singleton on top
// (`useSettings()`) that reads once and refreshes on `settings-changed`. It is
// read-only by contract: it exposes no setter. Writes still go through the main
// window (it stays the sole caller of `configure` and the sole writer of the
// store), so two windows never clobber each other.

export interface SettingsSnapshot {
    sessionKey: string;
    orgId: string;
    refreshInterval: number;
    autoStartSession: boolean;
    projectId: string;
    sessionThresholds: number[];
    weeklyThresholds: number[];
    notificationsEnabled: boolean;
    notifyForecastMinutes: number;
    forecastWindowMinutes: number;
    alertTiers: AlertTiers;
    alertTypes: AlertTypes;
    quietHours: QuietHoursSetting;
    providerSelection: ProviderSelection | null;
    ccAnalyticsEnabled: boolean;
    dailyBudget: number | null;
    goalCostPerHourMax: number | null;
    goalErrorRateMax: number | null;
    notificationsMutedUntil: string | null;
    serviceStatusEnabled: boolean;
    serviceStatusInterval: number;
    serviceStatusNotify: boolean;
    memoryBloatEnabled: boolean;
    todoNotificationsEnabled: boolean;
    runtimeInsights: RuntimeInsightsSetting;
    keepAwakeEnabled: boolean;
    systemInfoEnabled: boolean;
    correctionsEnabled: boolean;
    specs: SpecsSetting;
    // Raw persisted locale — null when unset. Callers decide whether to apply it
    // (validating "en"/"ru"); an unset value must NOT clobber the running locale.
    locale: string | null;
    uiTheme: string;
    uiSkin: string;
}

const UI_CONTRACT_KEYS = settingsContract.keys.filter(({ readers }) => readers.includes("ui"));
export const SNAPSHOT_KEYS = UI_CONTRACT_KEYS.filter((entry) => !("direct" in entry && entry.direct)).map(({ key }) => key);
export const DIRECT_KEYS = UI_CONTRACT_KEYS.filter((entry) => "direct" in entry && entry.direct).map(({ key }) => key);
export const RUNTIME_KEYS = ["projectId", "notificationsMutedUntil"] as const;

// The values a settings.json that has never been written yields. Kept in one place
// so App (writer) and every consumer window agree on defaults byte-for-byte.
export function defaultSettings(): SettingsSnapshot {
    return {
        sessionKey: "",
        orgId: "",
        refreshInterval: 60,
        autoStartSession: false,
        projectId: "",
        sessionThresholds: normalize(undefined),
        weeklyThresholds: normalize(undefined),
        notificationsEnabled: false,
        notifyForecastMinutes: 30,
        forecastWindowMinutes: 60,
        alertTiers: normalizeAlertTiers(undefined),
        alertTypes: normalizeAlertTypes(undefined),
        quietHours: { enabled: false, start: "23:00", end: "08:00" },
        providerSelection: null,
        ccAnalyticsEnabled: false,
        dailyBudget: null,
        goalCostPerHourMax: null,
        goalErrorRateMax: null,
        notificationsMutedUntil: null,
        serviceStatusEnabled: true,
        serviceStatusInterval: 90,
        serviceStatusNotify: true,
        memoryBloatEnabled: true,
        todoNotificationsEnabled: true,
        runtimeInsights: { enabled: false, kinds: ["long_session", "cold_rewrites"] },
        keepAwakeEnabled: false,
        systemInfoEnabled: true,
        correctionsEnabled: false,
        specs: { enabled: false, deltaGuard: "on" },
        locale: null,
        uiTheme: "system",
        uiSkin: "standard",
    };
}

export async function loadSettingsStoreForWrite() {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load("settings.json");
    await store.reload();
    return store;
}

export async function loadRuntimeStoreForWrite() {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load("runtime-state.json");
    await store.reload();
    return store;
}

export async function loadCacheStoreForWrite() {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load("cache.json");
    await store.reload();
    return store;
}

function asObject<T extends object>(value: T | null | undefined): T | undefined {
    return value && typeof value === "object" ? value : undefined;
}

// One-shot read of settings.json → a fully-defaulted, normalized snapshot. This is
// the single definition of "how a setting is read": consumers that only need a
// value now (e.g. the writer seeding its editable refs) call this directly.
export async function readSettingsSnapshot(): Promise<SettingsSnapshot> {
    const s = defaultSettings();
    try {
        const { load } = await import("@tauri-apps/plugin-store");
        const store = await load("settings.json");
        const runtimeStore = await load("runtime-state.json");
        const get = <T>(key: string) => store.get<T>(key);
        let settingsChanged = false;
        let runtimeChanged = false;

        // The pre-release Organization Usage integration stored a privileged
        // Admin API key here. Codex subscription limits now come only from local
        // rollout events, so remove that obsolete secret and its companion keys.
        for (const key of ["openAiAdminEnabled", "openAiAdminKey", "openAiUsageDays"]) {
            settingsChanged = (await store.delete(key)) || settingsChanged;
        }

        let quietHours = asObject(await get<Partial<QuietHoursSetting>>("quietHours"));
        {
            const enabled = await get<boolean>("quietHoursEnabled");
            const start = await get<string>("quietHoursStart");
            const end = await get<string>("quietHoursEnd");
            if (enabled !== undefined || start !== undefined || end !== undefined) {
                quietHours = {
                    enabled: quietHours?.enabled ?? enabled ?? false,
                    start: quietHours?.start ?? start ?? "23:00",
                    end: quietHours?.end ?? end ?? "08:00",
                };
                await store.set("quietHours", quietHours);
                settingsChanged = true;
            }
        }

        let dailyBudget = await get<number | null>("dailyBudget");
        const legacyBudgetEnabled = await get<boolean>("dailyBudgetEnabled");
        if (legacyBudgetEnabled !== undefined) {
            dailyBudget = legacyBudgetEnabled ? (dailyBudget ?? 0) : null;
            await store.set("dailyBudget", dailyBudget);
            settingsChanged = true;
        }

        let runtimeInsights = asObject(await get<Partial<RuntimeInsightsSetting>>("runtimeInsights"));
        {
            const enabled = await get<boolean>("runtimeInsightsEnabled");
            const kinds = await get<string[]>("runtimeInsightKinds");
            if (enabled !== undefined || kinds !== undefined) {
                runtimeInsights = {
                    enabled: runtimeInsights?.enabled ?? enabled ?? false,
                    kinds: Array.isArray(runtimeInsights?.kinds)
                        ? runtimeInsights.kinds
                        : Array.isArray(kinds) ? kinds : ["long_session", "cold_rewrites"],
                };
                await store.set("runtimeInsights", runtimeInsights);
                settingsChanged = true;
            }
        }
        if (Array.isArray(runtimeInsights?.kinds) && runtimeInsights.kinds.includes("idle_cache_gap")) {
            runtimeInsights = {
                enabled: runtimeInsights.enabled ?? false,
                kinds: runtimeInsights.kinds.map((kind) => kind === "idle_cache_gap" ? "cold_rewrites" : kind),
            };
            await store.set("runtimeInsights", runtimeInsights);
            settingsChanged = true;
        }

        let specs = asObject(await get<Partial<SpecsSetting>>("specs"));
        {
            const enabled = await get<boolean>("specsEnabled");
            const deltaGuard = await get<"on" | "off">("specDeltaGuard");
            if (enabled !== undefined || deltaGuard !== undefined) {
                specs = {
                    enabled: specs?.enabled ?? enabled ?? false,
                    deltaGuard: (specs?.deltaGuard ?? deltaGuard) === "off" ? "off" : "on",
                };
                await store.set("specs", specs);
                settingsChanged = true;
            }
        }

        for (const key of [
            "quietHoursEnabled", "quietHoursStart", "quietHoursEnd",
            "dailyBudgetEnabled", "runtimeInsightsEnabled", "runtimeInsightKinds",
            "specsEnabled", "specDeltaGuard",
        ]) {
            settingsChanged = (await store.delete(key)) || settingsChanged;
        }

        for (const key of RUNTIME_KEYS) {
            const current = await runtimeStore.get<unknown>(key);
            const legacy = await get<unknown>(key);
            if (current === undefined && legacy !== undefined) {
                await runtimeStore.set(key, legacy);
                runtimeChanged = true;
            }
            settingsChanged = (await store.delete(key)) || settingsChanged;
        }
        if (settingsChanged) await store.save();
        if (runtimeChanged) await runtimeStore.save();

        s.sessionKey = (await get<string>("sessionKey")) ?? s.sessionKey;
        s.orgId = (await get<string>("orgId")) ?? s.orgId;
        s.refreshInterval = (await get<number>("refreshInterval")) ?? s.refreshInterval;
        s.autoStartSession = (await get<boolean>("autoStartSession")) ?? s.autoStartSession;
        s.projectId = (await runtimeStore.get<string>("projectId")) ?? s.projectId;

        // `thresholds` is the pre-split legacy key; each of session/weekly falls
        // back to it, then normalize() fills any remaining gap with defaults.
        const legacy = await get<number[]>("thresholds");
        s.sessionThresholds = normalize((await get<number[]>("thresholdsSession")) ?? legacy);
        s.weeklyThresholds = normalize((await get<number[]>("thresholdsWeekly")) ?? legacy);

        s.notificationsEnabled = (await get<boolean>("notificationsEnabled")) ?? s.notificationsEnabled;
        s.notifyForecastMinutes = (await get<number>("notifyForecastMinutes")) ?? s.notifyForecastMinutes;
        s.forecastWindowMinutes = (await get<number>("forecastWindowMinutes")) ?? s.forecastWindowMinutes;
        s.alertTiers = normalizeAlertTiers(await get<Partial<AlertTiers>>("alertTiers"));
        s.alertTypes = normalizeAlertTypes(await get<Partial<AlertTypes>>("alertTypes"));
        s.quietHours = {
            enabled: quietHours?.enabled ?? s.quietHours.enabled,
            start: quietHours?.start ?? s.quietHours.start,
            end: quietHours?.end ?? s.quietHours.end,
        };
        const providerSelection = await get<string>("providerSelection");
        s.providerSelection = providerSelection === "claude"
            || providerSelection === "codex"
            || providerSelection === "both"
            ? providerSelection
            : null;
        s.ccAnalyticsEnabled = (await get<boolean>("ccAnalyticsEnabled")) ?? s.ccAnalyticsEnabled;
        s.dailyBudget = typeof dailyBudget === "number" ? dailyBudget : null;
        s.goalCostPerHourMax = (await get<number | null>("goalCostPerHourMax")) ?? null;
        s.goalErrorRateMax = (await get<number | null>("goalErrorRateMax")) ?? null;
        s.notificationsMutedUntil = (await runtimeStore.get<string>("notificationsMutedUntil")) ?? null;
        s.serviceStatusEnabled = (await get<boolean>("serviceStatusEnabled")) ?? s.serviceStatusEnabled;
        s.serviceStatusInterval = (await get<number>("serviceStatusInterval")) ?? s.serviceStatusInterval;
        s.serviceStatusNotify = (await get<boolean>("serviceStatusNotify")) ?? s.serviceStatusNotify;
        s.memoryBloatEnabled = (await get<boolean>("memoryBloatEnabled")) ?? s.memoryBloatEnabled;
        s.todoNotificationsEnabled = (await get<boolean>("todoNotificationsEnabled")) ?? s.todoNotificationsEnabled;
        const rk = runtimeInsights?.kinds;
        // Migrate the pre-release kind name idle_cache_gap → cold_rewrites so a
        // settings.json written before the rename keeps its runtime toggle.
        if (Array.isArray(rk)) {
            s.runtimeInsights.kinds = rk.map((k) => (k === "idle_cache_gap" ? "cold_rewrites" : k));
        }
        s.runtimeInsights.enabled = runtimeInsights?.enabled ?? s.runtimeInsights.enabled;

        s.keepAwakeEnabled = (await get<boolean>("keepAwakeEnabled")) ?? s.keepAwakeEnabled;
        s.systemInfoEnabled = (await get<boolean>("systemInfoEnabled")) ?? s.systemInfoEnabled;
        s.correctionsEnabled = (await get<boolean>("correctionsEnabled")) ?? s.correctionsEnabled;
        s.specs = {
            enabled: specs?.enabled ?? s.specs.enabled,
            deltaGuard: specs?.deltaGuard === "off" ? "off" : "on",
        };
        s.locale = (await get<string>("locale")) ?? null;
        s.uiTheme = (await get<string>("uiTheme")) ?? s.uiTheme;
        s.uiSkin = (await get<string>("uiSkin")) ?? s.uiSkin;
    } catch {
        // First run / not under Tauri — defaults stand.
    }
    return s;
}

// --- Reactive singleton (module-scoped so every importer in a window shares it) ---
const snapshot = ref<SettingsSnapshot>(defaultSettings());
let initialized = false;
const unlisteners: Array<() => void> = [];

async function refresh(): Promise<void> {
    snapshot.value = await readSettingsSnapshot();
}

// Read settings once and keep them fresh: the single writer emits `settings-changed`
// after every persist, and we reload on it. Idempotent — safe to call from every
// window's onMounted; only the first call wires the listener.
export async function initSettings(): Promise<void> {
    if (initialized) return;
    initialized = true;
    await refresh();
    try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisteners.push(
            await listen("settings-changed", () => {
                void refresh();
            }),
        );
    } catch {
        // not under Tauri — the initial defaults stand, no live refresh
    }
}

// The shared read-only view. `settings` is reactive; `refresh` forces a re-read
// (rarely needed — the listener handles it). No setter is exposed on purpose:
// writes go through the main window.
export function useSettings(): {
    settings: Ref<SettingsSnapshot>;
    initSettings: () => Promise<void>;
    refresh: () => Promise<void>;
} {
    return { settings: snapshot, initSettings, refresh };
}
