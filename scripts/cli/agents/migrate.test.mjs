import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { migrateAgentConfig } from "./migrate.mjs";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

describe("agents v5 migration", () => {
  it.each([
    "current-openai-worker.v4.json",
    "legacy-v1.json",
    "legacy-v3-hooks-routes.json",
  ])("is idempotent for %s", (name) => {
    const once = migrateAgentConfig(fixture(name));
    expect(migrateAgentConfig(once)).toEqual(once);
    expect(once.version).toBe(5);
  });

  it("keeps custom v1 profiles and is idempotent", () => {
    const v1 = { version: 1, profiles: { worker: { provider: "openai", model: "gpt-5.6-sol" }, mine: { note: "x" } } };
    const once = migrateAgentConfig(v1);
    expect(once.profiles).toEqual({ mine: { note: "x" } });
    expect(migrateAgentConfig(once)).toEqual(once);
  });

  it("keeps the user's OpenAI worker first and adds a distinct starter reserve", () => {
    const migrated = migrateAgentConfig(fixture("current-openai-worker.v4.json"));
    expect(migrated.duties.worker.candidates).toMatchObject([
      { provider: "openai", model: "gpt-5.6-sol", reasoning_effort: "xhigh" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ]);
    expect(migrated.installation).toBe("keep-me");
    expect(migrated.duties.worker.customDutyKey).toBe(true);
  });

  it("preserves v3 mode switches, unknown keys, and turns high routes into lists", () => {
    const migrated = migrateAgentConfig(fixture("legacy-v3-hooks-routes.json"));
    expect(migrated.duties.critic.mode).toBe("agent");
    expect(migrated.duties.architect.mode).toBe("off");
    expect(migrated.unknownTopLevel).toBe("survives");
    expect(migrated.duties.pluginDuty).toEqual({ implementation: "external" });
    expect(migrated.routes.high.pluginDuty).toEqual({ implementation: "external" });
    expect(migrated.routes.experimental).toEqual({ pluginDuty: "untouched" });
    expect(migrated.routes.high.worker).toEqual([
      { provider: "openai", model: "gpt-5.6-luna", reasoning_effort: "high" },
    ]);
  });
});
