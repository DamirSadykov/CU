import { readFileSync, readdirSync } from "node:fs";
import { extname, relative } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = new URL("..", import.meta.url);
const tokensCss = readFileSync(new URL("./cu-tokens.css", import.meta.url), "utf8");
const TRACE_COMPONENTS = new Set(["board/WorkTree.vue", "board/WorkTraceCharts.vue"]);
const SCALE = {
    "--fs-xs": 14,
    "--fs-sm": 15,
    "--fs-md": 16,
    "--fs-lg": 18,
    "--fs-xl": 20,
    "--fs-2xl": 24,
    "--fs-3xl": 26,
    "--fs-4xl": 30,
    "--fs-5xl": 34,
    "--fs-display": 44,
} as const;

function sourceFiles(directory = srcRoot): URL[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
        if (entry.isDirectory()) return sourceFiles(url);
        return [".css", ".vue"].includes(extname(entry.name)) ? [url] : [];
    });
}

function name(file: URL): string {
    return relative(srcRoot.pathname, file.pathname).replaceAll("\\", "/");
}

function styleSources(file: URL, source: string): string[] {
    if (extname(file.pathname) === ".css") return [source];
    return [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
}

function allowedFontSize(value: string, fileName: string): boolean {
    const allowedTokens = new Set<string>(Object.keys(SCALE));
    if (TRACE_COMPONENTS.has(fileName)) allowedTokens.add("--fs-trace");
    const referencedTokens = [...value.matchAll(/var\((--fs-[\w-]+)/g)].map((match) => match[1]);
    if (referencedTokens.length === 0 || referencedTokens.some((token) => !allowedTokens.has(token))) return false;
    if (/^var\(--fs-[\w-]+\)$/.test(value)) return true;
    if (/^var\(--[\w-]+,\s*var\(--fs-[\w-]+\)\)$/.test(value)) return true;
    const floorToken = value.match(/^max\(var\((--fs-[\w-]+)\),.+\)$/)?.[1];
    return Boolean(floorToken && allowedTokens.has(floorToken));
}

describe("interface font scale", () => {
    it("defines an ascending scale with a 14px floor and one 12px trace token", () => {
        for (const [token, size] of Object.entries(SCALE)) {
            expect(tokensCss, `${token} must be defined as ${size}px`).toMatch(
                new RegExp(`${token.replace("-", "\\-")}\\s*:\\s*${size}px\\b`),
            );
        }
        expect(tokensCss).toMatch(/--fs-trace\s*:\s*12px\b/);
        expect(Object.values(SCALE).every((size) => size >= 14)).toBe(true);
    });

    it("uses scale tokens instead of font-size literals in styles and templates", () => {
        const violations: string[] = [];

        for (const file of sourceFiles()) {
            const source = readFileSync(file, "utf8");
            const fileName = name(file);
            for (const match of source.matchAll(/font-size\s*:\s*([^;"'}\r\n]+)/g)) {
                const value = match[1].trim();
                if (!allowedFontSize(value, fileName)) {
                    violations.push(`${fileName}: font-size: ${value}`);
                }
            }
            for (const styles of styleSources(file, source)) {
                for (const match of styles.matchAll(/(?:^|[;{])\s*font\s*:\s*([^;}\r\n]+)/g)) {
                    const value = match[1].trim();
                    if (value !== "inherit" && !value.includes("var(--fs-")) {
                        violations.push(`${fileName}: font: ${value}`);
                    }
                }
            }
        }

        expect(violations).toEqual([]);
        expect(allowedFontSize("var(--fs-caption)", "App.vue")).toBe(false);
        expect(allowedFontSize("var(--fs-trace)", "App.vue")).toBe(false);
        expect(allowedFontSize("var(--fs-trace)", "board/WorkTree.vue")).toBe(true);
    });

    it("keeps programmatic chart and canvas labels above the same floor", () => {
        const violations: string[] = [];

        for (const file of sourceFiles()) {
            if (extname(file.pathname) !== ".vue") continue;
            const source = readFileSync(file, "utf8");
            const fileName = name(file);
            const floor = TRACE_COMPONENTS.has(fileName) ? 12 : 14;
            const sizes = [
                ...[...source.matchAll(/font\s*:\s*\{\s*size\s*:\s*(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1])),
                ...[...source.matchAll(/\.font\s*=\s*["'](\d+(?:\.\d+)?)px\b/g)].map((match) => Number(match[1])),
            ];
            for (const size of sizes) {
                if (size < floor) violations.push(`${fileName}: ${size}px is below ${floor}px`);
            }
        }

        expect(violations).toEqual([]);
    });
});
