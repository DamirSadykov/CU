import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_PROVIDER_MANIFEST,
  agentsBackupPath,
  agentsPath,
  checkAgentDuties,
  assertAgentDutiesAvailable,
  DUTY_MODES,
  emptyAgentConfig,
  readAgentConfig,
  resolveDuty,
  saveAgentConfig,
  criticMode,
  criticRunsAsAgent,
} from "./agents.mjs";
import { dutyModeReader } from "./duty-mode.mjs";

describe("lifecycle duty map", () => {
  let dir;
  let previous;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cut-agents-"));
    previous = process.env.APPDATA;
    process.env.APPDATA = dir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the starter duty map when no settings file exists", () => {
    expect(readAgentConfig()).toEqual(emptyAgentConfig());
    expect(resolveDuty("worker")).toMatchObject({ duty: "worker", mode: "always", provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(resolveDuty("critic")).toMatchObject({ mode: "session", provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(resolveDuty("architect")).toMatchObject({ mode: "agent", provider: "anthropic", model: "claude-opus-5-5" });
    expect(resolveDuty("review")).toMatchObject({ mode: "agent", provider: "anthropic", model: "claude-opus-5-5" });
  });

  it("keeps `enabled` and `runsAsAgent` apart for a session critic", () => {
    expect(resolveDuty("critic")).toMatchObject({ enabled: true, runsAsAgent: false });
    expect(resolveDuty("review")).toMatchObject({ enabled: true, runsAsAgent: true });
    expect(resolveDuty("worker")).toMatchObject({ enabled: true, runsAsAgent: true });
  });

  it("resolves models from lifecycle duties, never from task fields", () => {
    saveAgentConfig({
      version: 4,
      duties: {
        architect: { mode: "agent", provider: "openai", model: "gpt-5.6-sol", role: "architect" },
        worker: { mode: "always", provider: "anthropic", model: "sonnet", role: "worker" },
        review: { mode: "agent", provider: "anthropic", model: "opus", role: "reviewer" },
      },
    });
    expect(resolveDuty("architect")).toMatchObject({ duty: "architect", provider: "openai", model: "gpt-5.6-sol", enabled: true });
    expect(resolveDuty("worker")).toMatchObject({ duty: "worker", provider: "anthropic", model: "claude-sonnet-5-5" });
  });

  it("rejects a provider/model mismatch and keeps the valid family default", () => {
    saveAgentConfig({ version: 4, duties: { worker: { mode: "always", provider: "openai", model: "opus" } } });
    expect(resolveDuty("worker")).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
  });

  it("migrates a legacy Anthropic alias in a duty to its explicit model id", () => {
    saveAgentConfig({ version: 4, duties: { worker: { mode: "always", provider: "anthropic", model: "haiku" } } });
    expect(readAgentConfig().duties.worker.candidates[0].model).toBe("claude-haiku-4-5-20251001");
  });

  it("migrates a legacy Anthropic alias in a route to its explicit model id", () => {
    saveAgentConfig({
      version: 4,
      routes: { high: { worker: { provider: "anthropic", model: "opus" } } },
    });
    expect(resolveDuty("worker", undefined, { risk: "high" })).toMatchObject({
      provider: "anthropic", model: "claude-opus-5-5", route: { applied: true, risk: "high" },
    });
  });

  it("falls back to the starter profile for an unknown model", () => {
    saveAgentConfig({ version: 4, duties: { worker: { mode: "always", provider: "anthropic", model: "claude-unknown" } } });
    expect(resolveDuty("worker")).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
  });

  it("refuses a mode the duty does not offer and falls back to the starter one", () => {
    saveAgentConfig({
      version: 4,
      duties: { review: { mode: "session", provider: "anthropic", model: "opus" } },
    });
    expect(resolveDuty("review").mode).toBe("agent");
    expect(DUTY_MODES.review).toEqual(["off", "agent"]);
    expect(DUTY_MODES.worker).toEqual(["always"]);
  });

  it("migrates the v3 hooks map and criticMode into the one mode field", () => {
    saveAgentConfig({
      version: 3,
      duties: {
        critic: { provider: "openai", model: "gpt-5.6-terra" },
        architect: { provider: "openai", model: "gpt-5.6-terra" },
        worker: { provider: "anthropic", model: "sonnet" },
        review: { provider: "anthropic", model: "opus" },
      },
      hooks: { critic: true, architect: false, review: true },
      criticMode: "agent",
    });
    const cfg = readAgentConfig();
    expect(cfg.version).toBe(5);
    expect(cfg.duties.critic.mode).toBe("agent");
    expect(cfg.duties.architect.mode).toBe("off");
    expect(cfg.duties.review.mode).toBe("agent");
    expect(cfg.duties.worker.mode).toBe("always");
    expect(cfg.hooks).toBeUndefined();
    expect(cfg.criticMode).toBeUndefined();
  });

  it("reads a v3 critic that was switched off, whatever its criticMode said", () => {
    saveAgentConfig({
      version: 3,
      duties: { critic: { provider: "openai", model: "gpt-5.6-terra" } },
      hooks: { critic: false, architect: true, review: true },
      criticMode: "agent",
    });
    expect(criticMode()).toBe("off");
    expect(criticRunsAsAgent()).toBe(false);
  });

  it("resolveMode: a valid stored mode beats the legacy hooks/criticMode reading", () => {
    const { resolveMode } = dutyModeReader(AGENT_PROVIDER_MANIFEST);
    expect(resolveMode("critic", { mode: "off" }, { hooks: { critic: true }, criticMode: "agent" })).toBe("off");
    expect(resolveMode("review", { mode: "agent" }, { hooks: { review: false } })).toBe("agent");
  });

  it("resolveMode: a stored mode the duty does not allow falls through to the legacy reading", () => {
    const { resolveMode } = dutyModeReader(AGENT_PROVIDER_MANIFEST);
    expect(resolveMode("review", { mode: "session" }, { hooks: { review: true } })).toBe("agent");
    expect(resolveMode("critic", { mode: "bogus" }, { hooks: { critic: false } })).toBe("off");
  });

  it("resolveMode: no stored mode and no legacy keys lands on the starter mode", () => {
    const { resolveMode } = dutyModeReader(AGENT_PROVIDER_MANIFEST);
    expect(resolveMode("critic", undefined, undefined)).toBe("session");
    expect(resolveMode("architect", {}, {})).toBe("agent");
    expect(resolveMode("worker", undefined, undefined)).toBe("always");
  });

  it("routes a duty to the configured pair when the task's risk is high", () => {
    saveAgentConfig({
      version: 4,
      duties: { worker: { mode: "always", provider: "anthropic", model: "sonnet", role: "worker", instructions: "do the work" } },
      routes: { high: { worker: { provider: "openai", model: "gpt-5.6-sol" } } },
    });
    const resolved = resolveDuty("worker", undefined, { risk: "high" });
    expect(resolved).toMatchObject({
      provider: "openai", model: "gpt-5.6-sol",
      mode: "always", role: "worker", instructions: "do the work",
      route: { applied: true, risk: "high" },
    });
    expect(resolved.route.note).toMatch(/openai\/gpt-5\.6-sol/);
  });

  it("does not carry the duty's model-bound effort and prices onto the routed model", () => {
    saveAgentConfig({
      version: 4,
      duties: {
        worker: {
          mode: "always", provider: "openai", model: "gpt-5.6-terra", reasoning_effort: "high",
          input_cost_per_million: 1, output_cost_per_million: 2,
        },
      },
      routes: { high: { worker: { provider: "anthropic", model: "opus" } } },
    });
    const resolved = resolveDuty("worker", undefined, { risk: "high" });
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-opus-5-5");
    expect(resolved.reasoning_effort).toBeUndefined();
    expect(resolved.input_cost_per_million).toBeUndefined();
    expect(resolved.output_cost_per_million).toBeUndefined();
  });

  it("ignores the configured route when risk is absent, and carries no route field", () => {
    saveAgentConfig({
      version: 4,
      duties: { worker: { mode: "always", provider: "anthropic", model: "sonnet" } },
      routes: { high: { worker: { provider: "openai", model: "gpt-5.6-sol" } } },
    });
    const resolved = resolveDuty("worker");
    expect(resolved).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(resolved.route).toBeUndefined();
  });

  it("drops an invalid legacy route and falls back to the duty profile with a note", () => {
    saveAgentConfig({
      version: 4,
      duties: { review: { mode: "agent", provider: "anthropic", model: "opus" } },
      routes: { high: { review: { provider: "openai", model: "opus" } } },
    });
    const resolved = resolveDuty("review", undefined, { risk: "high" });
    expect(resolved).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", route: { applied: false, risk: "high" } });
    expect(resolved.route.note).toMatch(/no route configured/);
  });

  it("falls back to the duty profile with a note when no route is configured for that duty", () => {
    saveAgentConfig({
      version: 4,
      duties: { review: { mode: "agent", provider: "anthropic", model: "opus" } },
      routes: { high: { worker: { provider: "openai", model: "gpt-5.6-sol" } } },
    });
    const resolved = resolveDuty("review", undefined, { risk: "high" });
    expect(resolved).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", route: { applied: false, risk: "high" } });
    expect(resolved.route.note).toMatch(/no route configured for review/);
  });

  it("resolves models from lifecycle duties, never from task fields, even with routes present", () => {
    saveAgentConfig({
      version: 4,
      duties: {
        architect: { mode: "agent", provider: "openai", model: "gpt-5.6-sol", role: "architect" },
        worker: { mode: "always", provider: "anthropic", model: "sonnet", role: "worker" },
        review: { mode: "agent", provider: "anthropic", model: "opus", role: "reviewer" },
      },
      routes: { high: { worker: { provider: "openai", model: "gpt-5.6-luna" } } },
    });
    expect(resolveDuty("architect")).toMatchObject({ duty: "architect", provider: "openai", model: "gpt-5.6-sol", enabled: true });
    expect(resolveDuty("worker")).toMatchObject({ duty: "worker", provider: "anthropic", model: "claude-sonnet-5-5" });
  });

  it("defaults the critic to the main session and round-trips its mode", () => {
    expect(criticMode()).toBe("session");
    expect(criticRunsAsAgent()).toBe(false);
    const config = emptyAgentConfig();
    config.duties.critic.mode = "agent";
    saveAgentConfig(config);
    expect(readAgentConfig().duties.critic.mode).toBe("agent");
    expect(criticMode()).toBe("agent");
    expect(criticRunsAsAgent()).toBe(true);
  });

  it("writes one v4 backup and recovers an invalid v5 from it", () => {
    const file = agentsPath();
    mkdirSync(path.dirname(file), { recursive: true });
    const legacy = {
      version: 4,
      custom: "preserved",
      duties: { worker: { mode: "always", provider: "openai", model: "gpt-5.6-sol" } },
    };
    writeFileSync(file, JSON.stringify(legacy));
    const migrated = readAgentConfig();
    expect(migrated.duties.worker.candidates[0]).toMatchObject({ provider: "openai", model: "gpt-5.6-sol" });
    expect(existsSync(agentsBackupPath())).toBe(true);
    expect(JSON.parse(readFileSync(agentsBackupPath(), "utf8"))).toEqual(legacy);

    writeFileSync(file, JSON.stringify({ version: 5, duties: {} }));
    const recovered = readAgentConfig();
    expect(recovered.custom).toBe("preserved");
    expect(recovered.duties.worker.candidates[0]).toMatchObject({ provider: "openai", model: "gpt-5.6-sol" });
  });

  it("checks candidates in order and accepts a duty when its reserve is available", () => {
    const run = () => ({ status: 0, stderr: "" });
    const report = checkAgentDuties(undefined, { duties: ["worker"], run });
    expect(report.ok).toBe(true);
    expect(report.duties[0].candidates).toHaveLength(2);
  });

  it("accepts a duty whose primary is unavailable when the reserve is available", () => {
    let calls = 0;
    const run = () => ({ status: calls++ === 0 ? 1 : 0, stderr: "" });
    const report = checkAgentDuties(undefined, { duties: ["worker"], run });
    expect(report.duties[0].candidates[0].ok).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("preflight refuses an enabled duty before a run when every candidate is unavailable", () => {
    const run = () => ({ status: 1, stderr: "missing" });
    expect(() => assertAgentDutiesAvailable(undefined, { duties: ["worker"], run }))
      .toThrow(/no available candidate.*worker.*anthropic.*openai/i);
  });
});
