import { readFileSync, readdirSync } from "node:fs";
import { extname, relative } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = new URL("..", import.meta.url);
const tokensCss = readFileSync(new URL("./cu-tokens.css", import.meta.url), "utf8");
const ROLE_SIZES = [32, 22, 16, 13, 12, 11] as const;
const ROLE_TOKENS = ROLE_SIZES.map((size) => `--fs-${size}`);
const LEGACY_TOKENS = ["trace", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "display"];
const LOGO_FILES = new Set(["styles/cu-kit.css", "windows/KitWindow.vue"]);

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
    const blocks = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
    const inline = [...source.matchAll(/\sstyle\s*=\s*["']([^"']*)["']/g)].map((match) => match[1]);
    return [...blocks, ...inline];
}

function rules(styles: string): Array<{ selector: string; body: string }> {
    const parsed = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
        selector: match[1].trim(),
        body: match[2],
    }));
    return parsed.length > 0 || !styles.trim() ? parsed : [{ selector: "inline", body: styles }];
}

function declarations(body: string, property: string): string[] {
    const pattern = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;}]+)`, "g");
    return [...body.matchAll(pattern)].map((match) => match[1].trim());
}

function usesOnlyRoleSize(value: string, allowLogo: boolean): boolean {
    const tokens = [...value.matchAll(/var\((--fs-[\w-]+)/g)].map((match) => match[1]);
    const allowed = allowLogo ? [...ROLE_TOKENS, "--fs-logo"] : ROLE_TOKENS;
    return tokens.length > 0 && tokens.every((token) => allowed.includes(token));
}

function fileViolations(file: URL): string[] {
    const source = readFileSync(file, "utf8");
    const fileName = name(file);
    const allowLogo = LOGO_FILES.has(fileName);
    const violations: string[] = [];

    if (!allowLogo && source.includes("var(--fs-logo")) {
        violations.push("--fs-logo is reserved for cu-kit.css and KitWindow.vue");
    }
    if (fileName === "windows/KitWindow.vue") {
        for (const size of ROLE_SIZES) {
            if (!new RegExp(`class=["'][^"']*\\bt-${size}\\b`).test(source)) {
                violations.push(`missing t-${size} type specimen`);
            }
        }
    }

    for (const styles of styleSources(file, source)) {
        for (const rule of rules(styles)) {
            const context = rule.selector.replace(/\s+/g, " ");
            const report = (message: string) => violations.push(`${context}: ${message}`);
            const logoRule = allowLogo && /\.cu-(?:mark|wordmark)\b/.test(rule.selector);

            for (const value of declarations(rule.body, "font-size")) {
                if (!usesOnlyRoleSize(value, allowLogo)) report(`font-size: ${value}`);
            }
            for (const value of declarations(rule.body, "font")) {
                if (!usesOnlyRoleSize(value, allowLogo)) report(`font: ${value}`);
            }

            const weights = [
                ...declarations(rule.body, "font-weight"),
                ...declarations(rule.body, "font").flatMap(
                    (value) => value.match(/\b(?:[1-9]00|normal|bold(?:er)?)\b/g) ?? [],
                ),
            ];
            for (const weight of weights) {
                if (!["400", "600", "700"].includes(weight)) report(`font weight ${weight}`);
                if (weight === "700" && !logoRule && !/var\(--fs-(?:32|logo)\)/.test(rule.body)) {
                    report("font weight 700 requires --fs-32 or --fs-logo");
                }
            }

            for (const value of declarations(rule.body, "text-transform")) {
                if (value === "uppercase" && !logoRule && !/var\(--fs-(?:11|logo)\)/.test(rule.body)) {
                    report("uppercase requires --fs-11 or --fs-logo");
                }
            }
            for (const value of declarations(rule.body, "color")) {
                if (/var\(--(?:paper-4|text-4)\b/.test(value)) report(`color: ${value}`);
            }
        }
    }

    if (extname(file.pathname) === ".vue") {
        const chartSizes = [
            ...[...source.matchAll(/font\s*:\s*\{\s*size\s*:\s*(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1])),
            ...[...source.matchAll(/\.font\s*=\s*["'`]\s*(\d+(?:\.\d+)?)px\b/g)].map((match) => Number(match[1])),
        ];
        for (const size of chartSizes) {
            if (size < 11) violations.push(`chart label: ${size}px is below 11px`);
        }
    }

    return violations;
}

describe("interface type roles", () => {
    it("role tokens", () => {
        const expected = {
            32: [32, 1.1],
            22: [22, 1.2],
            16: [16, 1.3],
            13: [13, 1.45],
            12: [12, 1.4],
            11: [11, 1.2],
        } as const;

        for (const [role, [size, lineHeight]] of Object.entries(expected)) {
            expect(tokensCss, `--fs-${role}`).toMatch(new RegExp(`--fs-${role}\\s*:\\s*${size}px\\b`));
            expect(tokensCss, `--lh-${role}`).toMatch(new RegExp(`--lh-${role}\\s*:\\s*${lineHeight}\\b`));
        }
        expect(tokensCss).toMatch(/--fs-logo\s*:\s*\d+(?:\.\d+)?px\b/);
        for (const token of LEGACY_TOKENS) {
            expect(tokensCss, `legacy --fs-${token}`).not.toMatch(new RegExp(`--fs-${token}\\s*:`));
        }
    });

    for (const file of sourceFiles()) {
        const fileName = name(file);
        it(`type roles: ${fileName}`, () => {
            expect(fileViolations(file)).toEqual([]);
        });
    }
});
