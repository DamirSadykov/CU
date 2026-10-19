<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { WorkMode } from "../kernel/workMode";

type FlowStage = "human" | "session" | "architect" | "runner" | "worker" | "reviewer";

const props = defineProps<{
  mode: WorkMode;
}>();

const { t } = useI18n();

const stages: FlowStage[] = ["human", "session", "architect", "runner", "worker", "reviewer"];
const modeRoutes: Record<WorkMode, FlowStage[]> = {
  tracking: ["human"],
  tasks: ["human", "session"],
  plan: ["human", "architect", "session"],
  runner: ["human", "session", "architect", "runner", "worker", "reviewer"],
};

const activeRoute = computed(() => modeRoutes[props.mode]);
const activeStages = computed(() => new Set(activeRoute.value));
const orderedStages = computed(() => [
  ...activeRoute.value,
  ...stages.filter((stage) => !activeStages.value.has(stage)),
]);
</script>

<template>
  <section class="work-mode-flow" :aria-label="t('workModeFlowTitle')">
    <div class="work-mode-flow-head">
      <strong>{{ t('workModeFlowTitle') }}</strong>
      <span>{{ t(`workModeFlowHint_${mode}`) }}</span>
    </div>
    <div class="work-mode-flow-track">
      <template v-for="(stage, index) in orderedStages" :key="stage">
        <div
          class="work-mode-flow-node"
          :class="{ active: activeStages.has(stage), human: stage === 'human' }"
          :aria-current="activeStages.has(stage) ? 'step' : undefined"
        >
          <span class="work-mode-flow-icon" aria-hidden="true">{{ stage === 'human' ? '●' : '◆' }}</span>
          <span>{{ t(`workModeFlow_${stage}`) }}</span>
        </div>
        <span
          v-if="index < orderedStages.length - 1"
          class="work-mode-flow-arrow"
          :class="{ active: index < activeRoute.length - 1 }"
          aria-hidden="true"
        >→</span>
      </template>
    </div>
    <div class="work-mode-flow-legend">
      <span><i class="legend-human" />{{ t('workModeFlowLegendHuman') }}</span>
      <span><i class="legend-agent" />{{ t('workModeFlowLegendAgent') }}</span>
    </div>
  </section>
</template>

<style scoped>
.work-mode-flow {
  margin-top: 10px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--stroke-strong));
  border-radius: var(--r-ctl);
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}

.work-mode-flow-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  font-size: var(--fs-13);
}

.work-mode-flow-head span {
  color: var(--text-2);
  font-size: var(--fs-12);
  text-align: right;
}

.work-mode-flow-track {
  display: flex;
  align-items: center;
  overflow-x: auto;
  padding-bottom: 3px;
}

.work-mode-flow-node {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  min-width: 74px;
  color: var(--text-2);
  font-size: var(--fs-13);
  opacity: 0.55;
}

.work-mode-flow-node.active {
  color: var(--accent);
  opacity: 1;
  font-weight: 600;
}

.work-mode-flow-node.active.human {
  color: var(--text);
}

.work-mode-flow-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid currentColor;
  border-radius: 50%;
}

.work-mode-flow-arrow {
  flex: 1 0 18px;
  color: var(--stroke-strong);
  text-align: center;
  font-size: var(--fs-13);
}

.work-mode-flow-arrow.active {
  color: var(--accent);
  font-weight: 600;
}

.work-mode-flow-legend {
  display: flex;
  gap: 16px;
  margin-top: 10px;
  color: var(--text-2);
  font-size: var(--fs-12);
}

.work-mode-flow-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.work-mode-flow-legend i {
  width: 9px;
  height: 9px;
  border: 1px solid currentColor;
  transform: rotate(45deg);
}

.work-mode-flow-legend .legend-human {
  border-radius: 50%;
  transform: none;
}

@media (max-width: 760px) {
  .work-mode-flow-head {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }

  .work-mode-flow-head span {
    text-align: left;
  }
}
</style>
