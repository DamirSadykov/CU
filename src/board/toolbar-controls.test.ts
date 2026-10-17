import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const todoWindow = readFileSync(new URL("../windows/TodoWindow.vue", import.meta.url), "utf8");
const filtersBar = readFileSync(new URL("./TodoFiltersBar.vue", import.meta.url), "utf8");
const projectAutocomplete = readFileSync(new URL("../kernel/ProjectAutocomplete.vue", import.meta.url), "utf8");

function rule(source: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    expect(match, `missing ${selector} rule`).not.toBeNull();
    return match![1];
}

describe("task toolbar controls", () => {
    it("uses one height, font token, and control radius in the header", () => {
        expect(rule(todoWindow, ".tw-root")).toContain("--tw-toolbar-control-height: 30px");

        for (const selector of [".tw-search", ".tw-guide", ".tw-viewtoggle", ".tw-add", ".tw-modes"]) {
            expect(rule(todoWindow, selector), selector).toContain("height: var(--tw-toolbar-control-height)");
        }
        for (const selector of [".tw-search", ".tw-guide", ".tw-viewtoggle", ".tw-add", ".tw-modes", ".tw-mode"]) {
            expect(rule(todoWindow, selector), selector).toContain("border-radius: var(--r-ctl)");
        }
        for (const selector of [".tw-search-input", ".tw-guide", ".tw-vt", ".tw-add", ".tw-mode"]) {
            expect(rule(todoWindow, selector), selector).toContain("font-size: var(--fs-xs)");
        }
    });

    it("gives filter controls the same toolbar contract", () => {
        expect(rule(filtersBar, ".tw-filters")).toContain("--pa-control-height: var(--tw-toolbar-control-height)");
        for (const selector of [".tw-search", ".tw-filter-chip"]) {
            expect(rule(filtersBar, selector), selector).toContain("height: var(--tw-toolbar-control-height)");
            expect(rule(filtersBar, selector), selector).toContain("border-radius: var(--r-ctl)");
        }
        expect(rule(filtersBar, ".tw-search-input")).toContain("font: var(--fs-xs)/1 var(--segoe)");
        expect(rule(filtersBar, ".tw-filter-chip")).toContain("font: var(--fs-xs)/1 var(--segoe)");

        for (const selector of [".tw-facet-option", ".tw-sort-option", ".tw-pop-reset"]) {
            expect(rule(filtersBar, selector), selector).toContain("border-radius: var(--r-ctl)");
            expect(rule(filtersBar, selector), selector).toContain("font: var(--fs-xs)/");
        }
        expect(filtersBar.match(/class="tw-filter-chip"/g)).toHaveLength(2);

        const input = rule(projectAutocomplete, ".pa-input");
        expect(input).toContain("height: var(--pa-control-height, auto)");
        expect(input).toContain("border-radius: var(--pa-control-radius, var(--card-radius, 6px))");
        expect(input).toContain("font-size: var(--pa-control-font-size, var(--fs-xs))");
    });

    it("keeps the description editor toggle separate from toolbar modes", () => {
        expect(todoWindow.match(/^\.tw-mode\s*\{/gm)).toHaveLength(1);
        expect(todoWindow).toContain('class="tw-editor-mode"');
        expect(rule(todoWindow, ".tw-editor-mode")).not.toContain("height: var(--tw-toolbar-control-height)");
    });
});
