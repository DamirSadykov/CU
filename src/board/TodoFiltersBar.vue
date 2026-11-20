<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  CREATED_WINDOWS, TODO_FACETS, TODO_PRIORITIES, TODO_STATUSES, activeFacetCount, clearFacets, facetSelection, toggleFacet,
  type FacetCounts, type TodoFacet, type TodoFilters,
} from "./todoFilter";
import { TODO_DISPLAYS, TODO_SORTS, type TodoDisplay, type TodoSort } from "./taskSort";
import { displayLabels, facetLabels, optionLabel, sortLabels, viewLabels } from "./todoLabels";

const props = defineProps<{ modelValue: TodoFilters; sort: TodoSort; display: TodoDisplay; projects: string[]; facetCounts: FacetCounts }>();
const emit = defineEmits<{ "update:modelValue": [TodoFilters]; "update:sort": [TodoSort]; "update:display": [TodoDisplay] }>();
const { t } = useI18n();
const queryInput = ref(props.modelValue.query);
const open = ref<"" | "filters" | "sort">("");
const alignRight = ref(false);
const root = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const filtersPop = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

const value = computed({ get: () => props.modelValue, set: (next) => emit("update:modelValue", next) });
const badge = computed(() => activeFacetCount(value.value));
const options = computed<Record<TodoFacet, readonly string[]>>(() => ({
  status: TODO_STATUSES, project: props.projects, priority: TODO_PRIORITIES, created: CREATED_WINDOWS,
}));
const sorts = computed(() => sortLabels(t));
const displays = computed(() => displayLabels(t));
const facets = computed(() => facetLabels(t));
const views = computed(() => viewLabels(t));

function toggle(next: "filters" | "sort") {
  open.value = open.value === next ? "" : next;
  if (open.value !== "filters") return;
  alignRight.value = false;
  void nextTick(() => {
    const rect = filtersPop.value?.getBoundingClientRect();
    alignRight.value = !!rect && rect.right > window.innerWidth - 12;
  });
}
const pick = (facet: TodoFacet, option: string) => { value.value = toggleFacet(value.value, facet, option); };
const isOn = (facet: TodoFacet, option: string) => facetSelection(value.value, facet).includes(option);
const resetAll = () => { queryInput.value = ""; clearTimeout(timer); value.value = clearFacets(value.value); };
const pickSort = (next: TodoSort) => { emit("update:sort", next); open.value = ""; };
const pickDisplay = (next: TodoDisplay) => { emit("update:display", next); open.value = ""; };

watch(() => props.modelValue.query, (q) => { if (q !== queryInput.value) queryInput.value = q; });
watch(queryInput, (q) => { clearTimeout(timer); timer = setTimeout(() => { value.value = { ...value.value, query: q }; }, 200); });
function clearQuery() { queryInput.value = ""; clearTimeout(timer); value.value = { ...value.value, query: "" }; searchEl.value?.focus(); }

function onDocumentClick(event: MouseEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = "";
}
function onDocumentKey(event: KeyboardEvent) {
  if (event.key === "Escape" && open.value) { open.value = ""; return; }
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
  if (event.key === "/" && !typing) { event.preventDefault(); searchEl.value?.focus(); }
}
onMounted(() => { document.addEventListener("click", onDocumentClick); document.addEventListener("keydown", onDocumentKey); });
onBeforeUnmount(() => { document.removeEventListener("click", onDocumentClick); document.removeEventListener("keydown", onDocumentKey); });

defineExpose({
  focusSearch: () => searchEl.value?.focus(),
  focusProject: () => { if (open.value !== "filters") toggle("filters"); },
});
</script>

<template>
  <div ref="root" class="tw-filters">
    <div class="tw-search"><input ref="searchEl" v-model="queryInput" class="tw-search-input" :placeholder="t('todoSearchHint')" @keydown.esc="clearQuery" /><button v-if="queryInput" class="tw-search-clear" type="button" :title="t('todoSearchClear')" @click="clearQuery">×</button><kbd v-else class="tw-search-kbd">/</kbd></div>
    <div class="tw-filter-menu">
      <button class="tw-filter-chip" :class="{ active: open === 'filters' || badge > 0 }" type="button" @click="toggle('filters')">{{ t('todoFilters') }}<span v-if="badge" class="tw-filter-badge">{{ badge }}</span><span class="tw-filter-caret">▾</span></button>
      <div v-if="open === 'filters'" ref="filtersPop" class="tw-pop tw-filter-pop" :class="{ right: alignRight }">
        <div v-for="facet in TODO_FACETS" :key="facet" class="tw-facet">
          <span class="tw-facet-label">{{ facets[facet] }}</span>
          <div class="tw-facet-options">
            <button v-for="option in options[facet]" :key="option" class="tw-facet-option" :class="{ on: isOn(facet, option) }" type="button" @click="pick(facet, option)">{{ optionLabel(t, facet, option) }}<em>{{ facetCounts[facet][option] ?? 0 }}</em></button>
          </div>
        </div>
        <div class="tw-pop-foot"><span>{{ t('todoFiltersSummary', { view: views[value.view], count: badge }) }}</span><button class="tw-pop-reset" type="button" @click="resetAll">{{ t('todoFiltersResetAll') }}</button></div>
      </div>
    </div>
    <div class="tw-filter-menu">
      <button class="tw-filter-chip" :class="{ active: open === 'sort' }" type="button" @click="toggle('sort')">{{ sorts[sort].short }}<span class="tw-filter-caret">▾</span></button>
      <div v-if="open === 'sort'" class="tw-pop tw-sort-pop">
        <div class="tw-pop-head">{{ t('todoSortHeading') }}</div>
        <button v-for="key in TODO_SORTS" :key="key" class="tw-sort-option" :class="{ on: key === sort }" type="button" @click="pickSort(key)"><i>{{ key === sort ? '✓' : '' }}</i><span>{{ sorts[key].label }}<small>{{ sorts[key].hint }}</small></span></button>
        <hr />
        <div class="tw-pop-head">{{ t('todoDisplayHeading') }}</div>
        <button v-for="key in TODO_DISPLAYS" :key="key" class="tw-sort-option" :class="{ on: key === display }" type="button" @click="pickDisplay(key)"><i>{{ key === display ? '✓' : '' }}</i><span>{{ displays[key].label }}<small>{{ displays[key].hint }}</small></span></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tw-filters { --pa-control-height: var(--tw-toolbar-control-height); --pa-control-radius: var(--r-ctl); --pa-control-font-size: var(--fs-13); display: flex; align-items: center; gap: 6px; min-width: 0; }
.tw-filter-menu { position: relative; }
.tw-search { box-sizing: border-box; height: var(--tw-toolbar-control-height); border-radius: var(--r-ctl); }
.tw-search-input { box-sizing: border-box; height: 100%; font: 400 var(--fs-13)/var(--lh-13) var(--segoe); }
.tw-search-kbd { padding: 0 5px; border: 1px solid var(--stroke); border-radius: 3px; color: var(--text-3); font: 600 var(--fs-11)/var(--lh-11) var(--mono); letter-spacing: .06em; text-transform: uppercase; }
.tw-filter-chip { box-sizing: border-box; display: inline-flex; align-items: center; height: var(--tw-toolbar-control-height); gap: 6px; white-space: nowrap; padding: 4px 10px; border: 1px solid var(--stroke-strong); border-radius: var(--r-ctl); background: transparent; color: var(--text-2); font: 400 var(--fs-13)/var(--lh-13) var(--segoe); cursor: pointer; }
.tw-filter-chip:hover { background: var(--layer-hover); color: var(--text); }
.tw-filter-chip.active { border-color: var(--accent); color: var(--text); }
.tw-filter-badge { min-width: 18px; padding: 0 5px; border-radius: 9px; background: var(--accent); color: var(--on-accent, #fff); font: 600 var(--fs-11)/var(--lh-11) var(--mono); letter-spacing: .06em; text-align: center; text-transform: uppercase; }
.tw-filter-caret { color: var(--text-3); font-size: var(--fs-13); }
.tw-search-clear { padding: 0 2px; border: 0; background: transparent; color: var(--text-3); font-size: var(--fs-13); line-height: 1; cursor: pointer; }
.tw-search-clear:hover { color: var(--text); }
.tw-pop { position: absolute; z-index: 20; top: calc(100% + 6px); border: 1px solid var(--stroke-strong); border-radius: var(--r-card); background: var(--layer); box-shadow: 0 12px 32px rgba(0, 0, 0, .18), 0 2px 6px rgba(0, 0, 0, .08); }
.tw-filter-pop { left: 0; width: 460px; max-width: calc(100vw - 40px); padding: 6px 0; }
.tw-filter-pop.right { left: auto; right: 0; }
.tw-facet { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 10px; align-items: start; padding: 9px 14px; }
.tw-facet + .tw-facet { border-top: 1px solid var(--stroke); }
.tw-facet-label { padding-top: 5px; color: var(--text-3); font: 400 var(--fs-13)/var(--lh-13) var(--segoe); }
.tw-facet-options { display: flex; flex-wrap: wrap; gap: 5px; }
.tw-facet-option { display: inline-flex; align-items: baseline; gap: 6px; padding: 5px 9px; border: 1px solid var(--stroke-strong); border-radius: var(--r-ctl); background: transparent; color: var(--text-2); font: 400 var(--fs-13)/var(--lh-13) var(--segoe); cursor: pointer; }
.tw-facet-option:hover { background: var(--layer-hover); color: var(--text); }
.tw-facet-option.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.tw-facet-option em { font-style: normal; font-family: var(--mono); color: var(--text-3); }
.tw-facet-option.on em { color: inherit; opacity: .75; }
.tw-pop-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px 6px; border-top: 1px solid var(--stroke); color: var(--text-3); font: 400 var(--fs-13)/var(--lh-13) var(--segoe); }
.tw-pop-reset { padding: 4px 8px; border: 0; border-radius: var(--r-ctl); background: transparent; color: var(--text-2); font: 400 var(--fs-13)/var(--lh-13) var(--segoe); cursor: pointer; }
.tw-pop-reset:hover { background: var(--layer-hover); color: var(--text); }
.tw-sort-pop { right: 0; width: 300px; padding: 6px; }
.tw-pop-head { padding: 8px 8px 4px; color: var(--text-3); font: 600 var(--fs-11)/var(--lh-11) var(--mono); letter-spacing: .06em; text-transform: uppercase; }
.tw-sort-option { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 8px; width: 100%; padding: 7px 8px; border: 0; border-radius: var(--r-ctl); background: transparent; color: var(--text-2); font: 400 var(--fs-13)/var(--lh-13) var(--segoe); text-align: left; cursor: pointer; }
.tw-sort-option:hover { background: var(--layer-hover); }
.tw-sort-option.on { color: var(--text); }
.tw-sort-option i { color: var(--accent); font-style: normal; font-weight: 600; }
.tw-sort-option small { display: block; margin-top: 2px; color: var(--text-3); font-size: var(--fs-12); line-height: var(--lh-12); }
.tw-sort-pop hr { margin: 6px 0; border: 0; border-top: 1px solid var(--stroke); }
</style>
