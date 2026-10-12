import { describe, expect, it } from "vitest";
import { normalizeUiSkin, normalizeUiTheme, resolveTheme, skinAllowed } from "./theme";

describe("resolveTheme", () => {
    it("follows Windows when the base is system", () => {
        expect(resolveTheme("system", "standard", false)).toBe("light");
        expect(resolveTheme("system", "standard", true)).toBe("dark");
    });

    it("ignores Windows when the base is explicit", () => {
        expect(resolveTheme("light", "standard", true)).toBe("light");
        expect(resolveTheme("dark", "standard", false)).toBe("dark");
    });

    it("puts acid on both bases", () => {
        expect(resolveTheme("light", "acid", true)).toBe("acid");
        expect(resolveTheme("dark", "acid", false)).toBe("acid-dark");
        expect(resolveTheme("system", "acid", true)).toBe("acid-dark");
    });

    it("keeps ultraviolet dark-only and falls back to light on a light base", () => {
        expect(resolveTheme("dark", "ultraviolet", false)).toBe("ultraviolet");
        expect(resolveTheme("system", "ultraviolet", true)).toBe("ultraviolet");
        expect(resolveTheme("system", "ultraviolet", false)).toBe("light");
        expect(resolveTheme("light", "ultraviolet", true)).toBe("light");
    });

    it("treats unknown persisted values as defaults", () => {
        expect(normalizeUiTheme("sepia")).toBe("system");
        expect(normalizeUiSkin(undefined)).toBe("standard");
        expect(resolveTheme(42, "blueprint", true)).toBe("dark");
    });

    it("allows ultraviolet only on a dark base", () => {
        expect(skinAllowed("ultraviolet", false)).toBe(false);
        expect(skinAllowed("ultraviolet", true)).toBe(true);
        expect(skinAllowed("acid", false)).toBe(true);
    });
});
