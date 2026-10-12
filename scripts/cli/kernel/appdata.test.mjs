import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { appDataDir, appDataFile, writeJsonAtomic } from "./appdata.mjs";
import { acquireBoardLock, releaseBoardLock } from "./board-lock.mjs";

describe("app data paths", () => {
  it("uses the explicit roaming base", () => {
    const appData = path.join("C:", "Users", "tester", "AppData", "Roaming");
    const dir = path.join(appData, "com.cu.app");
    expect(appDataDir(appData)).toBe(dir);
    expect(appDataFile("todos.json", appData)).toBe(path.join(dir, "todos.json"));
  });

  it("uses APPDATA when no roaming base is supplied", () => {
    const previous = process.env.APPDATA;
    const appData = path.join("C:", "Users", "environment", "AppData", "Roaming");
    process.env.APPDATA = appData;
    try {
      expect(appDataDir()).toBe(path.join(appData, "com.cu.app"));
      expect(appDataFile("settings.json")).toBe(
        path.join(appData, "com.cu.app", "settings.json"),
      );
    } finally {
      if (previous === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previous;
    }
  });

  it("keeps using legacy data until the new directory has a marker", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "appdata-select-"));
    try {
      const oldDir = path.join(root, "com.claude-usage-tracker.app");
      const newDir = path.join(root, "com.cu.app");
      mkdirSync(oldDir);
      expect(appDataDir(root)).toBe(oldDir);
      mkdirSync(newDir);
      expect(appDataDir(root)).toBe(oldDir);
      writeFileSync(path.join(newDir, "migrated-from"), "{}");
      expect(appDataDir(root)).toBe(newDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["com.claude-usage-tracker.dev", "com.cu.dev"],
    ["com.claude-usage-tracker.preview", "com.cu.preview"],
  ])("keeps the %s environment inside its explicit pair", (oldIdentifier, newIdentifier) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "appdata-env-"));
    try {
      const oldDir = path.join(root, oldIdentifier);
      const newDir = path.join(root, newIdentifier);
      mkdirSync(oldDir);
      expect(appDataDir(root, newIdentifier)).toBe(oldDir);
      mkdirSync(newDir);
      writeFileSync(path.join(newDir, "migrated-from"), "{}");
      expect(appDataDir(root, newIdentifier)).toBe(newDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not invent a legacy directory for an unknown identifier", () => {
    const root = path.join("C:", "Users", "tester", "AppData", "Roaming");
    expect(appDataDir(root, "com.example.unknown")).toBe(path.join(root, "com.example.unknown"));
  });

  it("moves a writer that waited for migration to the marked directory", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "appdata-writer-"));
    const oldDir = path.join(root, "com.claude-usage-tracker.app");
    const newDir = path.join(root, "com.cu.app");
    mkdirSync(oldDir);
    writeFileSync(path.join(oldDir, "todos.json"), "{}");
    const holder = acquireBoardLock(path.join(oldDir, "todos.json"), { waitMs: 0, writer: "migration" });
    expect(holder.ok).toBe(true);

    try {
      const moduleUrl = new URL("./board-lock.mjs", import.meta.url).href;
      const script = [
        `import { writeFileSync } from "node:fs";`,
        `import path from "node:path";`,
        `import { withDataDir } from ${JSON.stringify(moduleUrl)};`,
        `writeFileSync(path.join(process.argv[1], "writer-ready"), "ready");`,
        `withDataDir((dir) => writeFileSync(path.join(dir, "writer.txt"), "new"), { appData: process.argv[1] });`,
      ].join("\n");
      const child = new Promise((resolve) => execFile(
        process.execPath,
        ["--input-type=module", "--eval", script, root],
        { encoding: "utf8", env: { ...process.env, BOARD_LOCK_WAIT_MS: "5000" }, windowsHide: true },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      ));

      const ready = path.join(root, "writer-ready");
      const deadline = Date.now() + 2000;
      while (!existsSync(ready) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(ready)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      mkdirSync(newDir);
      writeFileSync(path.join(newDir, "migrated-from"), "{}");
      releaseBoardLock(holder.lock);

      const result = await child;
      expect(result.error, result.stderr).toBeNull();
      expect(existsSync(path.join(oldDir, "writer.txt"))).toBe(false);
      expect(readFileSync(path.join(newDir, "writer.txt"), "utf8")).toBe("new");
    } finally {
      releaseBoardLock(holder.lock);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("writeJsonAtomic", () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("writes formatted JSON and leaves no temporary file", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "appdata-"));
    const file = path.join(dir, "data.json");
    const data = { task: 795, nested: { ready: true } };

    writeJsonAtomic(file, data);

    expect(readFileSync(file, "utf8")).toBe(JSON.stringify(data, null, 2) + "\n");
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });
});
