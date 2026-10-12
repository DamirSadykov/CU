import { watch } from "vue";
import { useSettings } from "./settingsStore";

export type UiTheme = "system" | "light" | "dark";
export type UiSkin = "standard" | "acid" | "ultraviolet";
export type ThemeId = "light" | "dark" | "acid" | "acid-dark" | "ultraviolet";

export const UI_THEMES: readonly UiTheme[] = ["system", "light", "dark"];
export const UI_SKINS: readonly UiSkin[] = ["standard", "acid", "ultraviolet"];
export const DEFAULT_UI_THEME: UiTheme = "system";
export const DEFAULT_UI_SKIN: UiSkin = "standard";
export const THEME_IDS: readonly ThemeId[] = ["light", "dark", "acid", "acid-dark", "ultraviolet"];

const CACHE_KEY = "cu-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function normalizeUiTheme(value: unknown): UiTheme {
    return UI_THEMES.includes(value as UiTheme) ? (value as UiTheme) : DEFAULT_UI_THEME;
}

export function normalizeUiSkin(value: unknown): UiSkin {
    return UI_SKINS.includes(value as UiSkin) ? (value as UiSkin) : DEFAULT_UI_SKIN;
}

export function skinAllowed(skin: UiSkin, dark: boolean): boolean {
    return skin !== "ultraviolet" || dark;
}

export function resolveTheme(uiTheme: unknown, uiSkin: unknown, systemDark: boolean): ThemeId {
    const base = normalizeUiTheme(uiTheme);
    const skin = normalizeUiSkin(uiSkin);
    const dark = base === "system" ? systemDark : base === "dark";
    if (skin === "acid") return dark ? "acid-dark" : "acid";
    if (skin === "ultraviolet" && dark) return "ultraviolet";
    return dark ? "dark" : "light";
}

export function applyTheme(id: ThemeId): void {
    document.documentElement.dataset.theme = id;
    try {
        localStorage.setItem(CACHE_KEY, id);
    } catch {
        return;
    }
}

export function readCachedTheme(): ThemeId | null {
    try {
        const id = localStorage.getItem(CACHE_KEY);
        return THEME_IDS.includes(id as ThemeId) ? (id as ThemeId) : null;
    } catch {
        return null;
    }
}

function systemDark(): boolean {
    return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
}

let installed = false;

export function installTheme(): void {
    if (installed) return;
    installed = true;
    const { settings, initSettings } = useSettings();
    applyTheme(readCachedTheme() ?? resolveTheme(DEFAULT_UI_THEME, DEFAULT_UI_SKIN, systemDark()));
    const sync = () => applyTheme(resolveTheme(settings.value.uiTheme, settings.value.uiSkin, systemDark()));
    void initSettings().then(() => {
        sync();
        watch(() => [settings.value.uiTheme, settings.value.uiSkin], sync);
        if (typeof matchMedia === "function") matchMedia(DARK_QUERY).addEventListener("change", sync);
    });
}
