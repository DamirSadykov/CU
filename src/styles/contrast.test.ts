import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokensCss = readFileSync(new URL("./cu-tokens.css", import.meta.url), "utf8");

const EXPECTED_THEMES = ["light", "dark", "acid", "acid-dark", "ultraviolet"] as const;

function channelToLinear(channel: number): number {
    const normalized = channel / 255;
    return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
    const channels = hex
        .slice(1)
        .match(/.{2}/g)
        ?.map((channel) => channelToLinear(Number.parseInt(channel, 16)));

    if (!channels || channels.length !== 3) {
        throw new Error(`Expected a six-digit hex color, received ${hex}`);
    }

    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first: string, second: string): number {
    const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
    const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
    return (lighter + 0.05) / (darker + 0.05);
}

function themeTokens(css: string): Map<string, Map<string, string>> {
    const themes = new Map<string, Map<string, string>>();

    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)}/g)) {
        const selector = match[1];
        const body = match[2];
        const explicitTheme = selector.match(/\[data-theme=["']([^"']+)["']]/)?.[1];
        const theme = selector.includes(":root") ? "light" : explicitTheme;
        if (!theme) continue;

        const declarations = new Map<string, string>();
        for (const declaration of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\b/gi)) {
            declarations.set(declaration[1], declaration[2]);
        }
        themes.set(theme, declarations);
    }

    return themes;
}

describe("pale text contrast", () => {
    it("keeps --paper-4 at WCAG AA contrast on --ink-0 in every theme", () => {
        const themes = themeTokens(tokensCss);
        expect([...themes.keys()].sort()).toEqual([...EXPECTED_THEMES].sort());

        for (const theme of EXPECTED_THEMES) {
            const tokens = themes.get(theme);
            const foreground = tokens?.get("--paper-4");
            const background = tokens?.get("--ink-0");

            expect(foreground, `${theme} must define --paper-4 as a six-digit hex color`).toBeDefined();
            expect(background, `${theme} must define --ink-0 as a six-digit hex color`).toBeDefined();

            const ratio = contrastRatio(foreground!, background!);
            expect(ratio, `${theme}: ${foreground} on ${background} has ${ratio.toFixed(2)}:1 contrast`).toBeGreaterThanOrEqual(4.5);
        }
    });
});
