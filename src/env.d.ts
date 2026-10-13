/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module "*/duty-mode.mjs" {
  export interface DutyCandidate {
    provider: string;
    model: string;
    reasoning_effort?: string;
    [key: string]: unknown;
  }
  export interface DutyProfile {
    mode?: unknown;
    candidates?: DutyCandidate[];
    [key: string]: unknown;
  }
  export interface DutyModeLegacy {
    hooks?: Record<string, boolean> | null;
    criticMode?: string | null;
  }
  export interface DutyModeReader {
    dutyModes(duty: string): string[];
    starterMode(duty: string): string;
    cleanMode(duty: string, value: unknown): string;
    migratedMode(duty: string, legacy: DutyModeLegacy | null | undefined): string;
    resolveMode(
      duty: string,
      profile: DutyProfile | null | undefined,
      legacy: DutyModeLegacy | null | undefined,
    ): string;
  }
  export function dutyModeReader(manifest: unknown): DutyModeReader;
}
