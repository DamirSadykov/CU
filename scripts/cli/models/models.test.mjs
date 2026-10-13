import { describe, expect, it, vi } from "vitest";
import { classifyFailure } from "./engine.mjs";
import { claudeCodeArgv } from "./claude-code.mjs";
import { codexArgv } from "./codex.mjs";
import { createCandidate } from "./candidate.mjs";
import { getProvider, openAiCost } from "./providers.mjs";

describe("model engines", () => {
  it("keeps provider choice separate from engine syntax", () => {
    expect(getProvider("anthropic").engine.id).toBe("claude-code");
    expect(getProvider("openai").engine.id).toBe("codex");
    expect(claudeCodeArgv({ model: "sonnet" }, { bin: "claude", allowedTools: [] }).args).toContain("-p");
    expect(codexArgv({ model: "gpt-5.6-sol" }, { bin: "codex" }).args.at(-1)).toBe("-");
  });

  it("passes the Claude runner guard through settingsPath", () => {
    expect(claudeCodeArgv({}, { settingsPath: "C:/tmp/cu-settings.json" }).args)
      .toContain("C:/tmp/cu-settings.json");
  });

  it.each([
    [{ error: { code: "ENOENT" } }, "missing"],
    [{ stderr: "401 authentication required", code: 1 }, "auth"],
    [{ stderr: "429 rate limit exceeded", code: 1 }, "limit"],
    [{ timedOut: true }, "timeout"],
    [{ stderr: "model not found", code: 1 }, "model"],
  ])("classifies failures into fallback policy reasons", (failure, reason) => {
    expect(classifyFailure(failure)).toBe(reason);
  });

  it("prices OpenAI cache and output tokens in the provider", () => {
    expect(openAiCost("gpt-5.6-sol", { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }))
      .toBe((60 * 4 + 40 * 0.4 + 10 * 20) / 1_000_000);
  });
});

describe("Candidate", () => {
  it("builds runner environment, parses output and calculates cost", async () => {
    const spawn = vi.fn(async (_file, _args, options) => ({
      code: 0, stderr: "", timedOut: false,
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
      ].join("\n"),
      env: options.env,
    }));
    const result = await createCandidate({ provider: "openai", model: "gpt-5.6-luna", reasoning_effort: "high" })
      .run({ spawn, prompt: "work", duty: "reviewer", sandbox: "read-only" });
    expect(result).toMatchObject({ ok: true, engine: "codex", provider: "openai", sessionId: "thread-1", answer: "done", reason: null });
    expect(spawn.mock.calls[0][2].env).toMatchObject({ TRACKER_DUTY: "reviewer", TRACKER_SESSION_KIND: "runner" });
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("does not restore a parent session removed from an explicit environment", async () => {
    const previous = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = "parent";
    try {
      const spawn = vi.fn(async (_file, _args, options) => ({
        code: 0, stderr: "", timedOut: false,
        stdout: JSON.stringify({ session_id: "child", result: "done" }),
        seenEnv: options.env,
      }));
      await createCandidate({ provider: "anthropic", model: "claude-sonnet-5-5" })
        .run({ spawn, env: { PATH: process.env.PATH }, prompt: "work" });
      expect(spawn.mock.calls[0][2].env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = previous;
    }
  });

  it("returns a classified failure instead of rejecting", async () => {
    const result = await createCandidate({ provider: "anthropic", model: "claude-sonnet-5-5" }).run({
      spawn: async () => { const error = new Error("spawn missing"); error.code = "ENOENT"; throw error; },
    });
    expect(result).toMatchObject({ ok: false, reason: "missing", engine: "claude-code" });
  });

  it("reports binary and guard independently during preflight", () => {
    const check = createCandidate({ provider: "openai", model: "gpt-5.6-sol" }).check({
      bin: "codex", rulesFile: "Z:/definitely-absent/cu-guard.rules",
      run: () => ({ status: 0, stderr: "" }),
    });
    expect(check).toMatchObject({ ok: true, binary: { available: true }, guard: { active: false } });
  });
});
