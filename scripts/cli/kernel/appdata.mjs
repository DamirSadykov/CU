import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DATA_DIR_PAIRS = Object.freeze([
  ["com.claude-usage-tracker.app", "com.cu.app"],
  ["com.claude-usage-tracker.dev", "com.cu.dev"],
  ["com.claude-usage-tracker.preview", "com.cu.preview"],
]);

export function roamingBase(appData) {
  return (
    appData ||
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || "", "AppData", "Roaming")
  );
}

export function appDataDir(appData, identifier = "com.cu.app") {
  const root = roamingBase(appData);
  const pair = DATA_DIR_PAIRS.find(([, next]) => next === identifier);
  if (!pair) return path.join(root, identifier);
  const [oldIdentifier, newIdentifier] = pair;
  const oldDir = path.join(root, oldIdentifier);
  const newDir = path.join(root, newIdentifier);
  return existsSync(path.join(newDir, "migrated-from")) || !existsSync(oldDir) ? newDir : oldDir;
}

export function appDataLocation(file) {
  const dir = path.dirname(file);
  const name = path.basename(dir);
  const pair = DATA_DIR_PAIRS.find(([oldIdentifier, newIdentifier]) =>
    name === oldIdentifier || name === newIdentifier);
  return pair ? { appData: path.dirname(dir), identifier: pair[1] } : null;
}

export function appDataFile(name, appData) {
  return path.join(appDataDir(appData), name);
}

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}
