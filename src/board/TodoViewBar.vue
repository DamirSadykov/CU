<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { TODO_FACETS, TODO_VIEWS, clearFacets, facetSelection, toggleFacet, type TodoFacet, type TodoFilters, type TodoView } from "./todoFilter";
import { facetLabels, optionLabel, viewLabels } from "./todoLabels";

const props = defineProps<{ modelValue: TodoFilters; counts: Record<TodoView, number> }>();
const emit = defineEmits<{ "update:modelValue": [TodoFilters] }>();
const { t } = useI18n();
const views = computed(() => viewLabels(t));
const facets = computed(() => facetLabels(t));
const applied = computed(() => TODO_FACETS.flatMap((facet) => facetSelection(props.modelValue, facet).map((option) => ({ facet, option }))));
const setView = (view: TodoView) => emit("update:modelValue", { ...props.modelValue, view });
const drop = (facet: TodoFacet, option: string) => emit("update:modelValue", toggleFacet(props.modelValue, facet, option));
const reset = () => emit("update:modelValue", clearFacets(props.modelValue));
function scrollSideways(event: WheelEvent) {
  const strip = event.currentTarget as HTMLElement;
  if (strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  event.preventDefault();
  strip.scrollLeft += event.deltaY;
}
</script>

<template>
  <div class="tv-views" role="tablist" @wheel="scrollSideways">
    <button v-for="view in TODO_VIEWS" :key="view" class="tv-view" :class="{ on: view === modelValue.view, attention: view === 'attention' }" role="tab" :aria-selected="view === modelValue.view" :title="view === 'attention' ? t('todoAttentionHint') : undefined" type="button" @click="setView(view)">{{ views[view] }}<em>{{ counts[view] }}</em></button>
  </div>
  <div v-if="applied.length" class="tv-applied">
    <button v-for="item in applied" :key="`${item.facet}:${item.option}`" class="tv-chip" type="button" @click="drop(item.facet, item.option)"><s>{{ facets[item.facet] }}:</s>{{ optionLabel(t, item.facet, item.option) }} ✕</button>
    <button class="tv-reset" type="button" @click="reset">{{ t('todoFiltersReset') }}</button>
  </div>
</template>

<style scoped>
.tv-views { display: flex; gap: 2px; padding: 8px 10px 0; border-bottom: 1px solid var(--stroke); overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
.tv-view { position: relative; display: flex; flex: none; white-space: nowrap; align-items: baseline; gap: 6px; padding: 7px 10px 9px; border: 0; background: transparent; color: var(--text-3); font: 500 var(--fs-xs)/1 var(--segoe); cursor: pointer; }
.tv-view:hover, .tv-view.on { color: var(--text); }
.tv-view.on::after { content: ""; position: absolute; left: 6px; right: 6px; bottom: -1px; height: 3px; border-radius: 2px; background: var(--accent); }
.tv-view em { color: var(--text-4); font: var(--fs-xs)/1 var(--mono); font-style: normal; }
.tv-view.attention em { color: var(--warn); }
.tv-applied { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--stroke); }
.tv-chip { display: inline-flex; gap: 4px; padding: 4px 8px; border: 1px solid var(--accent); border-radius: var(--r-ctl); background: var(--accent-soft); color: var(--accent); font: var(--fs-xs)/1.2 var(--segoe); cursor: pointer; }
.tv-chip s { color: var(--text-3); text-decoration: none; }
.tv-reset { margin-left: auto; padding: 0; border: 0; background: transparent; color: var(--text-3); font: var(--fs-xs)/1.2 var(--segoe); cursor: pointer; }
.tv-reset:hover { color: var(--text); }
</style>
