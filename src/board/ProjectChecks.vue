<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { DEFAULT_FLOW_LANGUAGES, FLOW_LANGUAGES, loadSettingsStoreForWrite } from "../kernel/settingsStore";
import type { FlowLanguage } from "../kernel/settingsStore";
import CuToggle from "../kernel/ui/CuToggle.vue";

type MutationSettings = { enabled: boolean; step: boolean; plan: boolean; stepMaxLevel: number };
const DEFAULT_MUTATIONS: MutationSettings = { enabled: false, step: true, plan: true, stepMaxLevel: 1 };

const props = defineProps<{ project: string }>();
const { t } = useI18n();

const ownLanguages = ref<FlowLanguage[]>([]);
const mutations = ref<MutationSettings>({ ...DEFAULT_MUTATIONS });
const languages = computed(() => ownLanguages.value.length ? ownLanguages.value : [...DEFAULT_FLOW_LANGUAGES]);

function asMap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isFlowLanguage(value: unknown): value is FlowLanguage {
  return typeof value === "string" && (FLOW_LANGUAGES as readonly string[]).includes(value);
}

function normalizeMutations(value: unknown): MutationSettings {
  const v = asMap(value) as Partial<MutationSettings>;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_MUTATIONS.enabled,
    step: typeof v.step === "boolean" ? v.step : DEFAULT_MUTATIONS.step,
    plan: typeof v.plan === "boolean" ? v.plan : DEFAULT_MUTATIONS.plan,
    stepMaxLevel: Number.isInteger(v.stepMaxLevel) && v.stepMaxLevel! >= 0 && v.stepMaxLevel! <= 3
      ? v.stepMaxLevel!
      : DEFAULT_MUTATIONS.stepMaxLevel,
  };
}

async function load() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    const store = await loadStore("settings.json");
    const configured = asMap(await store.get<unknown>("flowLanguages"))[props.project];
    ownLanguages.value = Array.isArray(configured) ? [...new Set(configured.filter(isFlowLanguage))] : [];
    mutations.value = normalizeMutations(asMap(await store.get<unknown>("mutations"))[props.project]);
  } catch {}
}

async function writeProjectEntry(key: "flowLanguages" | "mutations", value: unknown) {
  try {
    const store = await loadSettingsStoreForWrite();
    const map = { ...asMap(await store.get<unknown>(key)) };
    if (value === undefined) delete map[props.project];
    else map[props.project] = value;
    await store.set(key, map);
    await store.save();
  } catch {}
}

async function toggleLanguage(language: FlowLanguage) {
  const current = languages.value;
  const next = current.includes(language) ? current.filter((value) => value !== language) : [...current, language];
  if (!next.length) return;
  ownLanguages.value = FLOW_LANGUAGES.filter((value) => next.includes(value));
  await writeProjectEntry("flowLanguages", ownLanguages.value);
}

async function resetLanguages() {
  ownLanguages.value = [];
  await writeProjectEntry("flowLanguages", undefined);
}

async function setMutations(patch: Partial<MutationSettings>) {
  mutations.value = { ...mutations.value, ...patch };
  await writeProjectEntry("mutations", mutations.value);
}

watch(() => props.project, load, { immediate: true });
</script>

<template>
  <section class="cu-box pc">
    <div class="cu-box-h"><span class="tt">{{ t("flowChecksTitle") }}</span></div>
    <div class="cu-box-b">
      <div class="pc-label">
        <span>{{ t("flowLanguagesLabel") }}</span>
        <span v-if="!ownLanguages.length" class="cu-tag">{{ t("flowLanguagesDefault") }}</span>
        <button v-else type="button" class="pc-reset" @click="resetLanguages">{{ t("flowLanguagesRemove") }}</button>
      </div>
      <div class="pc-row">
        <CuToggle
          v-for="language in FLOW_LANGUAGES"
          :key="language"
          :model-value="languages.includes(language)"
          @update:model-value="toggleLanguage(language)"
        >{{ language }}</CuToggle>
      </div>
      <p class="pc-hint">{{ t("flowLanguagesHint") }}</p>

      <div class="pc-label pc-gap"><span>{{ t("mutationChecksTitle") }}</span></div>
      <div class="pc-row">
        <CuToggle :model-value="mutations.enabled" @update:model-value="setMutations({ enabled: $event })">{{ t("mutationEnabled") }}</CuToggle>
      </div>
      <div class="pc-row" :class="{ off: !mutations.enabled }">
        <CuToggle :model-value="mutations.step" :disabled="!mutations.enabled" @update:model-value="setMutations({ step: $event })">{{ t("mutationStepLabel") }}</CuToggle>
        <CuToggle :model-value="mutations.plan" :disabled="!mutations.enabled" @update:model-value="setMutations({ plan: $event })">{{ t("mutationPlanLabel") }}</CuToggle>
        <label class="pc-level">
          <span>{{ t("mutationStepMaxLevel") }}</span>
          <select
            :value="mutations.stepMaxLevel"
            :disabled="!mutations.enabled || !mutations.step"
            @change="setMutations({ stepMaxLevel: Number(($event.target as HTMLSelectElement).value) })"
          >
            <option v-for="level in [0, 1, 2, 3]" :key="level" :value="level">{{ level }}</option>
          </select>
        </label>
      </div>
      <p class="pc-hint">{{ t("mutationChecksDesc") }}</p>
    </div>
  </section>
</template>

<style scoped>
.pc-label { display: flex; align-items: center; gap: 8px; color: var(--paper-3); font: 600 var(--fs-16)/var(--lh-16) var(--sans); }
.pc-gap { margin-top: 14px; }
.pc-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-top: 8px; }
.pc-row.off { opacity: .5; }
.pc-reset { border: 0; padding: 0; background: transparent; color: var(--paper-3); cursor: pointer; font: 400 var(--fs-13)/var(--lh-13) var(--sans); text-decoration: underline; }
.pc-reset:hover { color: var(--paper); }
.pc-level { display: inline-flex; align-items: center; gap: 6px; color: var(--paper-2); font: 400 var(--fs-13)/var(--lh-13) var(--sans); }
.pc-level select { border: 1.5px solid var(--line-2); border-radius: var(--r-1); background: var(--field); color: var(--paper); font: 400 var(--fs-13)/var(--lh-13) var(--mono); padding: 2px 4px; }
.pc-hint { margin: 8px 0 0; color: var(--paper-3); font: 400 var(--fs-12)/var(--lh-12) var(--sans); }
</style>
