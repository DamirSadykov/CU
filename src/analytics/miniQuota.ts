import type { CodexLimitWindow, CodexRateLimits, UsageData, UsageLevels } from "../contracts/types";

export function miniQuota(
  provider: "claude" | "codex",
  claude: UsageData | null,
  levels: UsageLevels | null,
  codex: CodexRateLimits | null,
  now: number,
) {
  function codexWindow(value: CodexLimitWindow | null | undefined, fallback: string) {
    const minutes = value?.windowMinutes;
    const label = !minutes ? fallback : minutes % 1440 === 0 ? `${minutes / 1440}d`
      : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
    const percent = value ? value.resetsAt * 1000 <= now ? 0 : Math.max(0, Math.min(value.usedPercent, 100)) : null;
    const level = percent === null ? null : percent >= 90 ? 3 : percent >= 75 ? 2 : percent >= 50 ? 1 : 0;
    return { label, percent, level };
  }

  if (provider === "codex") {
    const windows = [codex?.primary, codex?.secondary].filter((w): w is CodexLimitWindow => !!w)
      .sort((a, b) => a.windowMinutes - b.windowMinutes);
    const weeklyOnly = windows.length === 1 && windows[0].windowMinutes >= 10080;
    return [
      codexWindow(weeklyOnly ? null : windows[0], "5h"),
      codexWindow(weeklyOnly ? windows[0] : windows[1], "7d"),
    ];
  }
  return [
    { label: "5h", percent: claude?.five_hour.percent_used ?? null, level: levels?.five_hour ?? null },
    { label: "7d", percent: claude?.seven_day.percent_used ?? null, level: levels?.seven_day ?? null },
  ];
}
