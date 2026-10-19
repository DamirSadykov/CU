<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import type { BoardChange } from "../contracts/board";
import { useSettings } from "../kernel/settingsStore";
import type { BoardTreeRow } from "./boardTree";
import ProjectChecks from "./ProjectChecks.vue";
import { localToday } from "./todoFilter";
import { formatRef } from "../../scripts/cli/kernel/terms.mjs";
import {
  fillDays,
  filterChangeRows,
  periodRange,
  projectOverview,
  type AttentionItem,
  type ChangeOverviewRow,
  type DayCost,
  type OverviewPeriod,
  type OverviewStatus,
  type StatusCounts,
} from "./projectOverview";

interface VendorUsage {
  vendor: string;
  cost: number;
}
interface ProjectSpend {
  totals: { cost: number };
  daily: DayCost[];
  by_vendor: VendorUsage[];
}

const props = defineProps<{ project: string; rows: readonly BoardTreeRow[]; changes: readonly BoardChange[] }>();
const emit = defineEmits<{ (e: "open-change", id: string): void; (e: "open-task", id: string): void }>();
const { t, locale } = useI18n();
const { settings } = useSettings();

const PERIODS: OverviewPeriod[] = ["7d", "30d", "all"];
const STATUS_ORDER: Array<keyof StatusCounts> = ["done", "running", "review", "blocked", "queued"];
const SEGMENT_LIMIT = 40;

const period = ref<OverviewPeriod>("30d");
const showClosed = ref(false);
const query = ref("");
const today = ref(localToday());
const spend = ref<ProjectSpend | null>(null);
const spendFailed = ref(false);

const range = computed(() => periodRange(period.value, today.value));
const overview = computed(() => projectOverview(props.project, props.rows, props.changes, period.value, today.value));
const openRows = computed(() => overview.value.changes.filter((row) => !row.closed));
const closedRows = computed(() => overview.value.changes.filter((row) => row.closed));
const shownRows = computed(() => filterChangeRows(overview.value.changes, showClosed.value, query.value));

const dailyLimit = computed(() => (settings.value.dailyBudget ?? 0) > 0 ? settings.value.dailyBudget : null);
const days = computed(() => fillDays(spend.value?.daily ?? [], range.value.from, range.value.to));
const periodLimit = computed(() => dailyLimit.value !== null && range.value.days !== null ? dailyLimit.value * range.value.days : null);
const spent = computed(() => spend.value?.totals.cost ?? 0);
const chartMax = computed(() => Math.max(dailyLimit.value ?? 0, ...days.value.map((day) => day.cost)) * 1.15 || 1);
const vendors = computed(() => {
  const list = (spend.value?.by_vendor ?? []).filter((item) => item.cost > 0);
  const total = list.reduce((sum, item) => sum + item.cost, 0);
  return list.map((item) => ({ ...item, share: total ? item.cost / total * 100 : 0 }));
});
const axis = computed(() => {
  const list = days.value;
  if (!list.length) return [];
  const picks = list.length > 2 ? [list[0], list[Math.floor((list.length - 1) / 2)], list[list.length - 1]] : list;
  return picks.map((day) => dayLabel(day.date));
});

async function loadSpend() {
  today.value = localToday();
  const target = { project: props.project, period: period.value };
  const from = range.value.from ? new Date(`${range.value.from}T00:00:00`).toISOString() : new Date(0).toISOString();
  const to = new Date(`${range.value.to}T23:59:59.999`).toISOString();
  try {
    const data = await invoke<ProjectSpend>("get_analytics_ext", { from, to, project: props.project || null, topN: 1 });
    if (target.project !== props.project || target.period !== period.value) return;
    spend.value = data;
    spendFailed.value = false;
  } catch {
    if (target.project === props.project) { spend.value = null; spendFailed.value = true; }
  }
}
watch(() => [props.project, period.value], () => { void loadSpend(); }, { immediate: true });

const money = (value: number) => "$" + (value >= 100 ? String(Math.round(value)) : value.toFixed(2));
const plain = (value: number) => (value >= 100 ? String(Math.round(value)) : value.toFixed(2));
const dayLabel = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(locale.value, { day: "numeric", month: "short" });
const periodLabel = (value: OverviewPeriod) => t(value === "7d" ? "poPeriod7" : value === "30d" ? "poPeriod30" : "poPeriodAll");
const statusLabel = (status: OverviewStatus) => t(`poStatus_${status}`);
const vendorClass = (vendor: string) => (vendor === "codex" ? "codex" : "claude");

function segments(counts: StatusCounts, total: number): Array<{ cls: keyof StatusCounts; grow: number }> {
  if (total <= SEGMENT_LIMIT) return STATUS_ORDER.flatMap((cls) => Array.from({ length: counts[cls] }, () => ({ cls, grow: 1 })));
  return STATUS_ORDER.filter((cls) => counts[cls]).map((cls) => ({ cls, grow: counts[cls] }));
}

const averageDelta = computed(() => {
  const delta = overview.value.average.delta;
  if (delta === null) return "";
  const pct = Math.round(delta * 100);
  return t("poVsPrev", { d: `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}%` });
});

const spentFill = computed(() => periodLimit.value ? Math.min(100, spent.value / periodLimit.value * 100) : 0);
const spentOver = computed(() => periodLimit.value !== null && spent.value > periodLimit.value);

function costFill(row: ChangeOverviewRow): number {
  return row.budget ? Math.min(100, row.cost / row.budget * 100) : 0;
}

function attentionStatus(item: AttentionItem): OverviewStatus {
  return item.kind === "review" ? "review" : item.kind === "over_budget" ? "running" : item.kind === "overdue" ? "blocked" : "queued";
}
function attentionTitle(item: AttentionItem): string {
  return item.kind === "over_budget" ? `${formatRef(item.number)} ${item.title}` : `#${item.number} ${item.title}`;
}
function attentionNote(item: AttentionItem): string {
  const prefix = item.kind !== "over_budget" && item.change !== null ? `${formatRef(item.change)} · ` : "";
  if (item.kind === "review") return prefix + t("poAttReview");
  if (item.kind === "over_budget") return `${money(item.cost)} / ${money(item.budget)} · ${t("poAttOver", { p: Math.round((item.cost / item.budget - 1) * 100) })}`;
  if (item.kind === "overdue") return prefix + t("poAttOverdue", { date: item.since ? dayLabel(item.since) : "—" });
  return prefix + t("poAttStale", { n: item.days });
}
function openAttention(item: AttentionItem) {
  if (item.kind === "over_budget") emit("open-change", item.changeId);
  else emit("open-task", item.taskId);
}
</script>

<template>
  <section class="po">
    <header class="po-top">
      <h1>{{ project || t("poNoProject") }}</h1>
      <div class="po-meta">
        <span v-for="item in vendors" :key="item.vendor" class="cu-agent" :class="vendorClass(item.vendor)">{{ item.vendor }}</span>
        <span class="cu-tag">{{ t("poOpenChanges", { n: overview.openChanges }) }}</span>
        <span class="po-sp">
          <span class="cu-seg">
            <button v-for="value in PERIODS" :key="value" type="button" :class="{ on: period === value }" @click="period = value">{{ periodLabel(value) }}</button>
          </span>
        </span>
      </div>
    </header>

    <div class="po-content">
      <div class="po-kpis cu-box">
        <div class="po-kpi">
          <span class="cu-t-cap">{{ t("poKpiTasks") }}</span>
          <div class="po-v"><b>{{ overview.tasks.done }}</b><s>{{ t("poOf", { n: overview.tasks.total }) }}</s></div>
          <div class="po-prog"><div class="po-bar"><i v-for="(seg, index) in segments(overview.tasks.counts, overview.tasks.total)" :key="index" :class="seg.cls" :style="{ flexGrow: seg.grow }"></i></div></div>
        </div>
        <div class="po-kpi">
          <span class="cu-t-cap">{{ t("poKpiChanges") }}</span>
          <div class="po-v"><b>{{ overview.openChanges }}</b><s :class="{ crit: overview.overBudget }">{{ overview.overBudget ? t("poOverBudget", { n: overview.overBudget }) : t("poWithinBudget") }}</s></div>
        </div>
        <div class="po-kpi">
          <span class="cu-t-cap">{{ t("poKpiSpend", { period: periodLabel(period) }) }}</span>
          <div class="po-v"><b>{{ spend ? money(spent) : "—" }}</b><s v-if="periodLimit !== null">{{ t("poOf", { n: money(periodLimit) }) }}</s></div>
          <div v-if="periodLimit !== null" class="cu-scale thin po-scale"><div class="trk"></div><div class="fill" :class="{ over: spentOver }" :style="{ width: `${spentFill}%` }"></div></div>
        </div>
        <div class="po-kpi">
          <span class="cu-t-cap">{{ t("poKpiAverage") }}</span>
          <div class="po-v"><b>{{ overview.average.value !== null ? money(overview.average.value) : "—" }}</b><s>{{ averageDelta || t("poClosedTasks", { n: overview.average.count }) }}</s></div>
        </div>
      </div>

      <div class="po-grid">
        <section class="cu-box">
          <div class="cu-box-h">
            <span class="tt">{{ t("poChanges") }}</span>
            <span class="sp">
              <button type="button" class="cu-chip" :class="{ on: !showClosed }" @click="showClosed = false">{{ t("poChipOpen", { n: openRows.length }) }}</button>
              <button type="button" class="cu-chip" :class="{ on: showClosed }" @click="showClosed = true">{{ t("poChipClosed", { n: closedRows.length }) }}</button>
              <label class="cu-field po-search"><span class="pfx">⌕</span><input v-model="query" :placeholder="t('poSearch')"></label>
            </span>
          </div>
          <div class="po-ct-h">
            <span class="cu-t-cap">#</span><span class="cu-t-cap">{{ t("poChanges") }}</span><span class="cu-t-cap">{{ t("poColTasks") }}</span><span class="cu-t-cap">{{ t("poColWave") }}</span><span class="cu-t-cap">{{ t("poColStatus") }}</span><span class="cu-t-cap po-right">{{ t("poColCost") }}</span>
          </div>
          <button v-for="row in shownRows" :key="row.id" type="button" class="po-ct-r" :class="{ closed: row.closed }" @click="emit('open-change', row.id)">
            <span class="cu-id">{{ formatRef(row.number) }}</span>
            <span class="po-ti"><b>{{ row.title }}</b></span>
            <span class="po-prog">
              <span class="po-bar"><i v-for="(seg, index) in segments(row.counts, row.total)" :key="index" :class="seg.cls" :style="{ flexGrow: seg.grow }"></i><i v-if="!row.total"></i></span>
              <span>{{ row.done }} / {{ row.total }}</span>
            </span>
            <span class="po-wv">{{ row.total ? `W${row.wave}` : "—" }}<s v-if="row.total"> / {{ row.waves }}</s></span>
            <span class="cu-st" :class="row.status"><i></i><span>{{ statusLabel(row.status) }}</span></span>
            <span class="po-mini">
              <span class="cu-cost" :class="{ crit: row.over }">{{ plain(row.cost) }}</span>
              <span v-if="row.budget !== null" class="po-g" :class="{ over: row.over }"><i :style="{ width: `${costFill(row)}%` }"></i></span>
              <span class="cu-t-cap po-limit">{{ row.budget !== null ? t("poBudget", { v: money(row.budget) }) : t("poNoBudget") }}</span>
            </span>
          </button>
          <div v-if="!shownRows.length" class="po-empty">{{ t("poNoChanges") }}</div>
        </section>

        <aside class="po-side">
          <section class="cu-box">
            <div class="cu-box-h"><span class="tt">{{ t("poSpendByDay") }}</span><span class="sp cu-t-cap">{{ periodLabel(period) }}</span></div>
            <div class="cu-box-b">
              <div v-if="spendFailed" class="po-empty">{{ t("poSpendFailed") }}</div>
              <template v-else>
                <div class="po-chart" :class="{ dense: days.length > 60 }">
                  <i v-for="day in days" :key="day.date" :class="{ hi: dailyLimit !== null && day.cost > dailyLimit }" :style="{ height: `${day.cost / chartMax * 100}%` }" :title="`${dayLabel(day.date)} · ${money(day.cost)}`"></i>
                  <div v-if="dailyLimit !== null" class="po-lim" :style="{ bottom: `${dailyLimit / chartMax * 100}%` }"><span>{{ t("poPerDay", { v: money(dailyLimit) }) }}</span></div>
                </div>
                <div class="po-axis"><span v-for="(label, index) in axis" :key="index">{{ label }}</span></div>
                <template v-if="vendors.length">
                  <div class="po-split"><i v-for="item in vendors" :key="item.vendor" :class="vendorClass(item.vendor)" :style="{ width: `${item.share}%` }"></i></div>
                  <div v-for="item in vendors" :key="item.vendor" class="po-kv"><span class="cu-agent" :class="vendorClass(item.vendor)">{{ item.vendor }}</span><b>{{ money(item.cost) }}</b></div>
                </template>
              </template>
            </div>
          </section>
          <section class="cu-box">
            <div class="cu-box-h"><span class="tt">{{ t("poAttention") }}</span><span class="sp"><span v-if="overview.attention.length" class="cu-tag route">{{ overview.attention.length }}</span></span></div>
            <div v-for="item in overview.attention" :key="`${item.kind}-${'taskId' in item ? item.taskId : item.changeId}`" class="po-att">
              <span class="cu-st" :class="attentionStatus(item)"><i></i></span>
              <span class="po-att-t">{{ attentionTitle(item) }}<small>{{ attentionNote(item) }}</small></span>
              <button type="button" class="cu-btn sm" @click="openAttention(item)">{{ item.kind === "review" ? t("poBtnReview") : t("poBtnOpen") }}</button>
            </div>
            <div v-if="!overview.attention.length" class="po-empty">{{ t("poAttentionEmpty") }}</div>
          </section>
          <ProjectChecks :project="project" />
        </aside>
      </div>
    </div>
  </section>
</template>

<style scoped>
.po { display: flex; flex-direction: column; min-width: 0; color: var(--paper); font-family: var(--sans); }
.po-top { display: flex; flex-direction: column; gap: 12px; padding: 16px 28px 18px; border-bottom: 1px solid var(--line-2); }
.po-top h1 { margin: 0; font-family: var(--cond); font-weight: 700; font-size: var(--fs-32); line-height: var(--lh-32); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.po-meta { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.po-sp { margin-left: auto; display: flex; gap: 8px; }
.po-content { display: flex; flex-direction: column; gap: 24px; padding: 24px 28px 36px; }
.po-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.po-kpi { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 14px 16px; border-right: 1px solid var(--line-2); }
.po-kpi:last-child { border-right: 0; }
.po-v { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.po-v b { font-family: var(--cond); font-weight: 700; font-size: var(--fs-32); line-height: var(--lh-32); font-variant-numeric: tabular-nums; }
.po-v s { text-decoration: none; font-family: var(--mono); font-size: var(--fs-12); line-height: var(--lh-12); color: var(--paper-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.po-v s.crit { color: var(--crit); }
.po-scale { margin-top: 4px; }
.po-scale .fill { background: var(--hemp); }
.po-scale .fill.over { background: var(--hazard); }
.po-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 24px; align-items: start; }
.po-side { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
.po-search { height: 26px; width: 180px; }
.po-ct-h, .po-ct-r { display: grid; grid-template-columns: 56px minmax(0, 1fr) 150px 72px 92px 110px; gap: 14px; align-items: center; padding: 0 14px; }
.po-ct-h { height: 32px; border-bottom: 1px solid var(--line-2); background: var(--ink-2); }
.po-ct-r { width: 100%; min-height: 58px; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: inherit; text-align: left; cursor: pointer; }
.po-ct-r:last-of-type { border-bottom: 0; }
.po-ct-r:hover { background: var(--ink-2); }
.po-ct-r:focus-visible { outline: 2px solid var(--hemp); outline-offset: -2px; }
.po-ti { min-width: 0; }
.po-ti b { display: block; font-weight: 600; font-size: var(--fs-13); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.po-ct-r.closed .po-ti b { color: var(--paper-3); }
.po-right { text-align: right; }
.po-prog { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.po-bar { display: flex; gap: 2px; height: 8px; }
.po-bar i { flex: 1 1 0; min-width: 0; border-radius: 2px; background: var(--ink-3); }
.po-bar i.done { background: var(--ok); }
.po-bar i.running { background: var(--next); }
.po-bar i.review { background: var(--warn); }
.po-bar i.blocked { background: var(--crit); }
.po-prog > span:last-child { font-family: var(--mono); font-size: var(--fs-12); color: var(--paper-3); font-variant-numeric: tabular-nums; }
.po-wv { font-family: var(--mono); font-size: var(--fs-13); font-weight: 600; font-variant-numeric: tabular-nums; }
.po-wv s { text-decoration: none; color: var(--paper-3); font-weight: 400; }
.po-mini { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; min-width: 0; }
.po-mini .cu-cost.crit { color: var(--crit); }
.po-g { position: relative; width: 100%; height: 6px; border-radius: 3px; background: var(--ink-3); overflow: hidden; }
.po-g i { position: absolute; inset: 0 auto 0 0; border-radius: 3px; background: var(--hemp); }
.po-g.over i { background: var(--hazard); }
.po-limit { font-size: var(--fs-13); }
.po-empty { padding: 14px; font-size: var(--fs-12); line-height: var(--lh-12); color: var(--paper-3); }
.po-chart { position: relative; display: flex; align-items: flex-end; gap: 3px; height: 120px; padding-top: 10px; }
.po-chart.dense { gap: 1px; }
.po-chart i { flex: 1 1 0; min-width: 0; min-height: 2px; border-radius: 2px 2px 0 0; background: var(--bold); }
.po-chart i.hi { background: var(--hemp); }
.po-lim { position: absolute; left: 0; right: 0; border-top: 1.5px dashed var(--crit); pointer-events: none; }
.po-lim span { position: absolute; right: 0; top: -16px; font-family: var(--mono); font-size: var(--fs-11); font-weight: 600; letter-spacing: .06em; line-height: var(--lh-11); color: var(--crit); font-variant-numeric: tabular-nums; text-transform: uppercase; }
.po-axis { display: flex; justify-content: space-between; margin-top: 6px; font-family: var(--mono); font-size: var(--fs-11); font-weight: 600; letter-spacing: .06em; line-height: var(--lh-11); color: var(--paper-3); font-variant-numeric: tabular-nums; text-transform: uppercase; }
.po-split { display: flex; gap: 2px; height: 10px; margin: 12px 0 8px; border-radius: 5px; overflow: hidden; }
.po-split i.claude { background: var(--ag-claude); }
.po-split i.codex { background: var(--ag-codex); }
.po-kv { display: flex; align-items: center; justify-content: space-between; padding: 7px 0; border-top: 1px solid var(--line); font-size: var(--fs-13); }
.po-kv b { font-family: var(--mono); font-weight: 400; font-size: var(--fs-13); font-variant-numeric: tabular-nums; }
.po-att { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 10px 14px; border-bottom: 1px solid var(--line); font-size: var(--fs-13); }
.po-att:last-of-type { border-bottom: 0; }
.po-att .cu-st { padding-top: 3px; }
.po-att-t { line-height: 1.4; min-width: 0; overflow-wrap: anywhere; }
.po-att-t small { display: block; margin-top: 2px; font-family: var(--mono); font-size: var(--fs-12); line-height: var(--lh-12); color: var(--paper-3); }
@media (max-width: 1240px) { .po-grid { grid-template-columns: 1fr; } }
@media (max-width: 900px) {
  .po-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .po-kpi:nth-child(2) { border-right: 0; }
  .po-kpi:nth-child(-n+2) { border-bottom: 1px solid var(--line-2); }
  .po-ct-h, .po-ct-r { grid-template-columns: 56px minmax(0, 1fr) 110px; }
  .po-ct-h > :nth-child(n+4), .po-ct-r > :nth-child(n+4) { display: none; }
}
</style>
