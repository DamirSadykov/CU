import { describe, expect, it } from "vitest";
import { guideText, run } from "./guide.mjs";
import { loadRoutes } from "./open.mjs";
import { contractBlock } from "../cc-hooks/hook.mjs";

describe("cli guide", () => {
  const text = guideText();
  const table = loadRoutes();

  it.each(loadRoutes().routes.map((r) => r.path))("describes route %s", (route) => {
    expect(text).toContain(`${table.scheme}://${route}`);
  });

  it.each(loadRoutes().settingsTabs)("names settings tab %s", (tab) => {
    expect(text).toContain(`settings/${tab}`);
  });

  it("states the open-on-request rule", () => {
    expect(text).toMatch(/only when the user asks/i);
  });

  it("prints the guide", async () => {
    const out = [];
    await run([], { out: (s) => out.push(s) });
    expect(out.join("")).toBe(text);
  });

  it("is announced by the session hook", () => {
    expect(contractBlock("startup")).toContain("<cli> guide");
  });
});
