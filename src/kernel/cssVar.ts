let probe: HTMLSpanElement | null = null;

export function themeColor(css: string): string {
    if (typeof document === "undefined") return css;
    if (!probe || !probe.isConnected) {
        probe = document.createElement("span");
        probe.style.display = "none";
        document.body.appendChild(probe);
    }
    probe.style.color = "";
    probe.style.color = css;
    return getComputedStyle(probe).color || css;
}

export function themeMix(token: string, percent: number): string {
    return themeColor(`color-mix(in srgb, var(${token}) ${percent}%, transparent)`);
}

export function chartTooltip() {
    return {
        backgroundColor: themeColor("var(--ink-1)"),
        titleColor: themeColor("var(--paper)"),
        bodyColor: themeColor("var(--paper-2)"),
        footerColor: themeColor("var(--paper-3)"),
        borderColor: themeColor("var(--line-2)"),
        borderWidth: 1,
    };
}

export function onThemeChange(callback: () => void): () => void {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
    const observer = new MutationObserver(() => callback());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
}
