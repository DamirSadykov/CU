<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettings } from "../kernel/settingsStore";
import type { UsageData, UsageLevels, CodexRateLimits } from "../contracts/types";
import { miniQuota } from "../analytics/miniQuota";
import { logWarn } from "../kernel/logging";

// Whole-system resource snapshot (CPU load + RAM), emitted by the backend
// sysmon loop. Reflects the entire machine, not just this app.
interface SysStats {
  cpu_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
  mem_percent: number;
}

const usage = ref<UsageData | null>(null);
const levels = ref<UsageLevels | null>(null);
const sys = ref<SysStats | null>(null);
// Layout switch: on → compact 2×2 with CPU/RAM; off → original two-row bars.
// Seeded from the store on mount, then kept in sync via `system-info-enabled`.
const systemInfo = ref(true);
const error = ref("");
const unlisteners: Array<() => void> = [];
const { settings, initSettings } = useSettings();
const codexLimits = ref<CodexRateLimits | null>(null);
const codexLimitsError = ref("");
const now = ref(Date.now());
let limitsTimer: ReturnType<typeof setInterval> | null = null;
const claudeConnected = computed(() => Boolean(settings.value.sessionKey && settings.value.orgId));
const provider = computed(() => settings.value.miniProvider === "auto"
  ? claudeConnected.value ? "claude" : "codex"
  : settings.value.miniProvider);
const providerName = computed(() => provider.value === "codex" ? "Codex" : "Claude");
const quotas = computed(() => miniQuota(provider.value, claudeConnected.value ? usage.value : null,
  levels.value, settings.value.ccAnalyticsEnabled ? codexLimits.value : null, now.value));

let limitsRequest = 0;
async function loadCodexLimits() {
  const request = ++limitsRequest;
  codexLimitsError.value = "";
  now.value = Date.now();
  if (!settings.value.ccAnalyticsEnabled || provider.value !== "codex") {
    codexLimits.value = null;
    return;
  }
  try {
    const limits = await invoke<CodexRateLimits | null>("get_codex_limits", { enabled: true });
    if (request === limitsRequest) codexLimits.value = limits;
  } catch (err) {
    if (request !== limitsRequest) return;
    codexLimits.value = null;
    codexLimitsError.value = String(err);
    void logWarn(`[mini] get_codex_limits failed: ${err}`);
  }
}

watch([provider, () => settings.value.ccAnalyticsEnabled], () => { void loadCodexLimits(); });
watch(claudeConnected, (connected) => {
  if (!connected) {
    usage.value = null;
    levels.value = null;
    error.value = "";
  }
});

function percentLabel(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(0)}%`;
}

const MINI_CLASSES = ["t-green", "t-yellow", "t-orange", "t-red"];
function cls(level: number | null | undefined): string {
  return MINI_CLASSES[level ?? 0];
}

// System load → colour bucket. Independent of the Claude-quota thresholds: a
// busy machine is orange/red regardless of how much quota is left.
function loadCls(percent: number): string {
  if (percent >= 90) return "t-red";
  if (percent >= 80) return "t-orange";
  if (percent >= 60) return "t-yellow";
  return "t-green";
}

function gb(mb: number): string {
  return (mb / 1024).toFixed(1);
}

async function startDrag() {
  await getCurrentWindow().startDragging();
}

onMounted(async () => {
  // Seed the layout flag through the shared settings layer — the mini window may
  // mount after the backend's last `configure`, so we can't rely on the
  // `system-info-enabled` event alone. That event stays the live channel below
  // (it also carries the drop-stale-readings side-effect).
  await initSettings();
  systemInfo.value = settings.value.systemInfoEnabled;
  const { listen } = await import("@tauri-apps/api/event");
  unlisteners.push(
    await listen<{ usage: UsageData; levels: UsageLevels }>("usage-updated", (e) => {
      if (!claudeConnected.value) return;
      usage.value = e.payload.usage;
      levels.value = e.payload.levels;
      error.value = "";
    }),
    await listen<{ message: string; reportable: boolean }>("usage-error", (e) => {
      if (!claudeConnected.value) return;
      error.value = String(e.payload?.message ?? e.payload);
    }),
    await listen<SysStats>("system-stats", (e) => {
      sys.value = e.payload;
    }),
    await listen<boolean>("system-info-enabled", (e) => {
      systemInfo.value = e.payload;
      // Drop stale readings so the bar layout never flashes old CPU/RAM.
      if (!e.payload) sys.value = null;
    }),
  );
  void loadCodexLimits();
  limitsTimer = setInterval(() => { void loadCodexLimits(); }, 30_000);
});

onUnmounted(() => {
  unlisteners.forEach((u) => u());
  if (limitsTimer) clearInterval(limitsTimer);
});
</script>

<template>
  <div class="mini" :aria-label="providerName" :title="provider === 'claude' ? error || providerName : codexLimitsError || providerName" @mousedown="startDrag">
    <div class="provider-name">{{ providerName }}</div>
      <div v-if="systemInfo" class="grid">
        <div v-for="(quota, index) in quotas" :key="index" class="cell">
          <span class="label">{{ quota.label }}</span>
          <span class="val" :class="quota.percent === null ? '' : cls(quota.level)">{{ percentLabel(quota.percent) }}</span>
        </div>
        <template v-if="sys">
          <div class="cell">
            <span class="label">CPU</span>
            <span class="val" :class="loadCls(sys.cpu_percent)">{{ sys.cpu_percent.toFixed(0) }}%</span>
          </div>
          <div class="cell" :title="`${gb(sys.mem_used_mb)} / ${gb(sys.mem_total_mb)} GB`">
            <span class="label">RAM</span>
            <span class="val" :class="loadCls(sys.mem_percent)">{{ gb(sys.mem_used_mb) }}G</span>
          </div>
        </template>
      </div>

      <!-- Original two-row bars (system info off) — rows are direct children of
           .mini so .track's flex:1 fills the full window width (a wrapper div
           collapsed the track to 0). -->
      <template v-else>
        <div v-for="(quota, index) in quotas" :key="index" class="row">
          <span class="label">{{ quota.label }}</span>
          <div class="track"><i :class="cls(quota.level)" :style="{ width: Math.min(quota.percent ?? 0, 100) + '%' }"></i></div>
          <span class="val" :class="quota.percent === null ? '' : cls(quota.level)">{{ percentLabel(quota.percent) }}</span>
        </div>
      </template>
  </div>
</template>

<style scoped>
.provider-name {
  color: var(--text-2);
  font: 600 var(--fs-11) / var(--lh-11) var(--mono);
}

.mini {
  width: 100%;
  height: 100%;
  padding: 10px 14px;
  background: color-mix(in srgb, var(--ink-1) 95%, transparent);
  border: 1px solid color-mix(in srgb, var(--paper) 8%, transparent);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  cursor: grab;
  user-select: none;
  font-family: "Segoe UI Variable", "Segoe UI", sans-serif;
}

/* --- Compact 2×2 layout (system info on) --- */
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
  pointer-events: none;
}

.cell {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.grid .label {
  width: 26px;
}

.grid .val {
  font-family: var(--mono);
  font-size: var(--fs-13);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  min-width: 36px;
  text-align: right;
}

/* --- Original two-row bars (system info off) --- */
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.row .label {
  width: 20px;
  font-size: var(--fs-11);
  color: color-mix(in srgb, var(--paper) 50%, transparent);
}

.track {
  flex: 1;
  height: 6px;
  background: color-mix(in srgb, var(--paper) 8%, transparent);
  border-radius: 3px;
  overflow: hidden;
}

.track i {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 300ms ease;
}

.track i.t-green { background: var(--ok); }
.track i.t-yellow { background: var(--warn); }
.track i.t-orange { background: var(--ag-claude); }
.track i.t-red { background: var(--crit); }

.row .val {
  font-family: var(--mono);
  font-size: var(--fs-13);
  font-weight: 600;
  width: 32px;
  text-align: right;
}

/* --- Shared --- */
.label {
  font-family: var(--mono);
  font-size: var(--fs-11);
  font-weight: 600;
  color: color-mix(in srgb, var(--paper) 45%, transparent);
  flex-shrink: 0;
}

.val {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.val.t-green { color: var(--ok); }
.val.t-yellow { color: var(--warn); }
.val.t-orange { color: var(--ag-claude); }
.val.t-red { color: var(--crit); }

.loading {
  color: color-mix(in srgb, var(--paper) 30%, transparent);
  font-size: var(--fs-12);
  text-align: center;
  pointer-events: none;
}
</style>
