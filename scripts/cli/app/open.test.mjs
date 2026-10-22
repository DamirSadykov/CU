import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRoutes, resolveRoute, run } from "./open.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function tabUnion(file) {
  const text = readFileSync(`${ROOT}${file}`, "utf8");
  const m = text.match(/type SettingsTab\s*=([^;]+);/);
  return [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]).sort();
}

function harness(registered = true) {
  const calls = { spawn: [], out: [] };
  const deps = {
    registered: () => registered,
    spawn: (url) => calls.spawn.push(url),
    out: (s) => calls.out.push(s),
  };
  return { calls, deps };
}

describe("cli open", () => {
  const table = loadRoutes();

  it("settings tabs match both SettingsTab unions", () => {
    const tabs = [...table.settingsTabs].sort();
    expect(tabUnion("src/windows/SettingsPanel.vue")).toEqual(tabs);
    expect(tabUnion("src/windows/SettingsWindow.vue")).toEqual(tabs);
  });

  it.each([
    ["settings", "cu://settings"],
    ["settings/tasks", "cu://settings/tasks"],
    ["cu://settings/limits/", "cu://settings/limits"],
    ["/tasks", "cu://tasks"],
    ["tasks/1187", "cu://tasks/1187"],
    ["tasks/t#1187", "cu://tasks/1187"],
    ["tasks/#42", "cu://tasks/42"],
    ["analytics", "cu://analytics"],
  ])("resolves %s", (input, url) => {
    expect(resolveRoute(input, table)).toEqual({ url });
  });

  it.each(["settings/nope", "tasks/abc", "tasks/0", "mini", "settings/tasks/extra", ""])("refuses %s", (input) => {
    expect(resolveRoute(input, table).error).toBeTruthy();
  });

  it("hands a valid route to the registered scheme", async () => {
    const { calls, deps } = harness();
    await run(["settings/tasks"], deps);
    expect(calls.spawn).toEqual(["cu://settings/tasks"]);
  });

  it("prints the link without opening anything", async () => {
    const { calls, deps } = harness();
    await run(["tasks/12", "--print"], deps);
    expect(calls.spawn).toEqual([]);
    expect(calls.out.join("")).toContain("cu://tasks/12");
  });

  it("fails with exit 1 when the scheme is not registered", async () => {
    const { calls, deps } = harness(false);
    await expect(run(["analytics"], deps)).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining("not registered") });
    expect(calls.spawn).toEqual([]);
  });

  it("lists the routes for an unknown route", async () => {
    const { deps } = harness();
    await expect(run(["mini"], deps)).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining("settings/<tab>") });
  });
});
