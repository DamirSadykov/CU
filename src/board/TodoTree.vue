<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { visibleBoardTreeRows, type BoardFeedGroup, type BoardTreeNode } from "./boardTree";
import { isFresh, relativeTime, type TodoDisplay, type TodoSort } from "./taskSort";
import { bucketLabel, relativeLabel, sortLabels } from "./todoLabels";
import { formatRef } from "../../scripts/cli/kernel/terms.mjs";

export type TodoTreeDepth = "plans" | "tasks";

const props = withDefaults(defineProps<{
  tree: readonly BoardTreeNode[];
  feed?: readonly BoardFeedGroup[];
  display?: TodoDisplay;
  depth?: TodoTreeDepth;
  sort?: TodoSort;
  summary: { count: number; cost: number };
  selectedId?: string | null;
  searching?: boolean;
  now?: number;
}>(), { feed: () => [], display: "tree", depth: "tasks", sort: "updated", selectedId: null, searching: false, now: () => Date.now() });

const emit = defineEmits<{
  select: [node: BoardTreeNode];
  "update:selectedId": [id: string | null];
  "update:depth": [value: TodoTreeDepth];
  open: [node: BoardTreeNode];
  reset: [];
}>();

interface ListRow {
  node: BoardTreeNode;
  depth: number;
  bucket?: string;
}

const COLLAPSED_KEY = "todo-tree:collapsed";
const SELECTED_KEY = "todo-tree:selected";
const collapsed = ref<Set<string>>(new Set());
const manuallyExpanded = new Set<string>();
const completedChanges = ref<Set<string>>(new Set());
const localSelectedId = ref<string | null>(readSelected());
const root = ref<HTMLElement | null>(null);
const initialized = ref(false);
const selectedId = computed(() => props.selectedId ?? localSelectedId.value);
const shownCollapsed = computed(() => props.searching ? new Set([...collapsed.value].filter((id) => !completedChanges.value.has(id))) : collapsed.value);
const { t, locale } = useI18n();
const rows = computed<readonly ListRow[]>(() => {
  if (props.display === "feed") {
    return props.feed.flatMap((group) => group.nodes.map((node, index) => ({
      node, depth: 0, bucket: index === 0 && group.bucket ? bucketLabel(t, group.bucket) : undefined,
    })));
  }
  return visibleBoardTreeRows(props.tree, shownCollapsed.value, { plansOnly: props.depth === "plans" });
});
const meta = computed(() => t("todoTreeMeta", {
  count: props.summary.count, cost: cost(props.summary.cost), sort: sortLabels(t)[props.sort].label.toLocaleLowerCase(),
}));

function readCollapsed(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(saved) && saved.every((id) => typeof id === "string") ? new Set(saved) : new Set();
  } catch {
    return new Set();
  }
}

function readSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function persistCollapsed(value: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...value]));
  } catch {}
}

function select(node: BoardTreeNode): void {
  localSelectedId.value = node.id;
  try {
    localStorage.setItem(SELECTED_KEY, node.id);
  } catch {}
  emit("update:selectedId", node.id);
  emit("select", node);
}

const expandable = (node: BoardTreeNode) => node.children.length > 0 && !(props.depth === "plans" && node.kind !== "group") && props.display === "tree";

function activate(node: BoardTreeNode): void {
  if (node.kind === "task") select(node);
  else toggle(node);
}

function toggle(node: BoardTreeNode): void {
  if (!expandable(node)) return;
  const next = new Set(collapsed.value);
  if (next.has(node.id)) {
    next.delete(node.id);
    if (node.kind === "change" || node.kind === "legacy") manuallyExpanded.add(node.id);
  }
  else next.add(node.id);
  collapsed.value = next;
  persistCollapsed(next);
}

function toggleFromCaret(event: MouseEvent, node: BoardTreeNode): void {
  if (!expandable(node)) return;
  event.stopPropagation();
  toggle(node);
}

function open(node: BoardTreeNode): void {
  if (node.kind === "task" || node.kind === "change" || node.kind === "legacy" || node.kind === "group") emit("open", node);
}

function onKeydown(event: KeyboardEvent): void {
  const index = rows.value.findIndex(({ node }) => node.id === selectedId.value);
  const current = index < 0 ? 0 : index;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = index < 0
      ? rows.value[event.key === "ArrowDown" ? 0 : rows.value.length - 1]
      : rows.value[current + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) select(next.node);
    return;
  }
  const row = rows.value[current];
  if (!row) return;
  if (event.key === "ArrowRight") {
    event.preventDefault();
    if (expandable(row.node) && collapsed.value.has(row.node.id)) toggle(row.node);
    else if (expandable(row.node)) select(row.node.children[0]);
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (expandable(row.node) && !collapsed.value.has(row.node.id)) toggle(row.node);
    else {
      for (let candidate = current - 1; candidate >= 0; candidate--) {
        if (rows.value[candidate].depth < row.depth) {
          select(rows.value[candidate].node);
          break;
        }
      }
    }
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    open(row.node);
  }
}

function statusClass(status: string | null): string {
  return status ? `status-${status}` : "";
}

function cost(value: number): string {
  return "$" + (value >= 100 ? Math.round(value) : value.toFixed(2));
}

function timeLabel(node: BoardTreeNode): string {
  return node.time ? relativeLabel(t, relativeTime(node.time, props.now), locale.value) : "";
}

function expandSelectedAncestors(tree: readonly BoardTreeNode[], id: string | null, value: ReadonlySet<string>): Set<string> {
  if (!id) return new Set(value);
  const next = new Set(value);
  const visit = (node: BoardTreeNode): boolean => {
    if (node.id === id) return true;
    for (const child of node.children) {
      if (visit(child)) {
        next.delete(node.id);
        return true;
      }
    }
    return false;
  };
  for (const node of tree) visit(node);
  return next;
}

watch(() => props.tree, (tree) => {
  if (!tree.length) return;
  const complete = new Set<string>();
  const visit = (node: BoardTreeNode) => {
    if ((node.kind === "change" || node.kind === "legacy") && node.children.length && node.closed) complete.add(node.id);
    node.children.forEach(visit);
  };
  tree.forEach(visit);
  if (!initialized.value) {
    const saved = readCollapsed();
    collapsed.value = expandSelectedAncestors(tree, selectedId.value, new Set([...complete, ...saved]));
    initialized.value = true;
  } else {
    const next = new Set(collapsed.value);
    for (const id of complete) {
      if (!completedChanges.value.has(id) && !manuallyExpanded.has(id)) next.add(id);
    }
    const visibleSelection = expandSelectedAncestors(tree, selectedId.value, next);
    if (visibleSelection.size !== collapsed.value.size || [...visibleSelection].some((id) => !collapsed.value.has(id))) {
      collapsed.value = visibleSelection;
      persistCollapsed(visibleSelection);
    }
  }
  completedChanges.value = complete;
}, { immediate: true });

watch([() => props.tree, selectedId], ([tree, id]) => {
  if (!tree.length || !id) return;
  const next = expandSelectedAncestors(tree, id, collapsed.value);
  if (next.size === collapsed.value.size && [...next].every((nodeId) => collapsed.value.has(nodeId))) return;
  collapsed.value = next;
  persistCollapsed(next);
}, { immediate: true });

let scrolledTo: string | null = null;

async function scrollSelected(id: string | null): Promise<void> {
  await nextTick();
  if (!id) return;
  const row = root.value?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "nearest" });
  scrolledTo = id;
}

watch(selectedId, scrollSelected, { flush: "post", immediate: true });
watch(rows, () => {
  if (selectedId.value !== scrolledTo) void scrollSelected(selectedId.value);
}, { flush: "post" });
</script>

<template>
  <nav ref="root" class="todo-tree" tabindex="0" @keydown="onKeydown">
    <slot name="head" />
    <div class="todo-tree-head">
      <span class="todo-tree-meta">{{ meta }}</span>
      <span v-if="display === 'tree'" class="todo-tree-depth" role="group">
        <button type="button" :class="{ on: depth === 'plans' }" @click="emit('update:depth', 'plans')">{{ t('todoDepthPlans') }}</button>
        <button type="button" :class="{ on: depth === 'tasks' }" @click="emit('update:depth', 'tasks')">{{ t('todoDepthTasks') }}</button>
      </span>
    </div>
    <div class="todo-tree-rows">
      <div v-if="!rows.length" class="todo-tree-empty">
        <span>{{ t('todoTreeEmpty') }}</span>
        <button type="button" @click="emit('reset')">{{ t('todoTreeResetFilters') }}</button>
      </div>
      <template v-for="row in rows" :key="row.node.id">
        <div v-if="row.bucket" class="todo-tree-bucket">{{ row.bucket }}</div>
        <button
          class="todo-tree-row"
          :class="{ selected: row.node.id === selectedId, closed: row.node.closed, group: row.node.kind === 'group', ungrouped: row.node.kind === 'ungrouped', change: row.node.kind === 'change', legacy: row.node.kind === 'legacy' }"
          :data-tree-id="row.node.id"
          :style="{ '--tree-depth': row.depth }"
          @click="activate(row.node)"
          @dblclick="open(row.node)"
        >
          <span class="todo-tree-toggle" :class="{ empty: !expandable(row.node), collapsed: shownCollapsed.has(row.node.id) || (depth === 'plans' && row.node.kind !== 'group' && row.node.kind !== 'task') }" @click="toggleFromCaret($event, row.node)"></span>
          <span class="todo-tree-title"><span v-if="row.node.status" class="todo-tree-status" :class="statusClass(row.node.status)"></span><span v-if="row.node.number !== null" class="todo-tree-number">{{ row.node.kind === 'change' || row.node.kind === 'legacy' ? formatRef(row.node.number) : `#${row.node.number}` }}</span><span class="todo-tree-text">{{ row.node.kind === 'ungrouped' ? t('todoTreeWithoutChange') : row.node.title }}</span><small v-if="display === 'feed' && row.node.plan != null" class="todo-tree-plan">{{ formatRef(row.node.plan) }}</small><span v-if="row.node.attention" class="todo-tree-attention" :title="t('todoAttentionHint')"></span></span>
          <span class="todo-tree-time" :class="{ fresh: row.node.time && isFresh(row.node.time, now) }">{{ timeLabel(row.node) }}</span>
          <span v-if="row.node.kind !== 'ungrouped'" class="todo-tree-cost">{{ cost(row.node.cost) }}</span>
          <span v-else></span>
          <span v-if="row.node.kind === 'change' || row.node.kind === 'legacy'" class="todo-tree-bar" aria-hidden="true"><i :style="{ width: `${row.node.progress.total ? row.node.progress.done / row.node.progress.total * 100 : 0}%` }"></i></span>
        </button>
      </template>
    </div>
  </nav>
</template>

<style scoped>
.todo-tree { min-width: 0; overflow: hidden; background: transparent; color: var(--text); display: flex; flex-direction: column; font-family: var(--segoe); outline: none; }
.todo-tree:focus-visible { box-shadow: inset 0 0 0 1px var(--accent); }
.todo-tree-head { align-items: center; border-bottom: 1px solid var(--stroke); display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) auto; padding: 7px 8px 7px 12px; }
.todo-tree-meta { color: var(--text-3); font: var(--fs-xs)/1.2 var(--segoe); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-tree-depth { background: var(--track); border-radius: var(--r-ctl); display: inline-flex; gap: 2px; padding: 2px; }
.todo-tree-depth button { background: transparent; border: 0; border-radius: var(--r-ctl); color: var(--text-3); cursor: pointer; font: var(--fs-xs)/1.2 var(--segoe); padding: 2px 8px; }
.todo-tree-depth button.on { background: var(--layer); box-shadow: 0 1px 2px rgba(0, 0, 0, .12); color: var(--text); }
.todo-tree-rows { flex: 1; min-height: 0; overflow: auto; padding: 4px 0; }
.todo-tree-empty { align-items: center; color: var(--text-3); display: flex; flex-direction: column; font: var(--fs-xs)/1.4 var(--segoe); gap: 10px; padding: 40px 20px; text-align: center; }
.todo-tree-empty button { background: transparent; border: 1px solid var(--stroke-strong); border-radius: var(--r-ctl); color: var(--text-2); cursor: pointer; font: var(--fs-xs)/1.2 var(--segoe); padding: 5px 10px; }
.todo-tree-bucket { border-bottom: 1px solid var(--stroke); color: var(--text-4); font: 600 var(--fs-xs)/1 var(--mono); letter-spacing: .08em; padding: 12px 12px 5px; text-transform: uppercase; }
.todo-tree-row { --tree-indent: calc(var(--tree-depth) * 16px); align-items: center; background: transparent; border: 0; color: inherit; cursor: pointer; display: grid; font-family: var(--segoe); font-size: var(--fs-xs); gap: 8px; grid-template-columns: 14px minmax(0, 1fr) 52px 56px; height: 30px; padding: 0 14px 0 calc(10px + var(--tree-indent)); position: relative; text-align: left; width: 100%; }
.todo-tree-row:hover { background: var(--card-bg-hover); }
.todo-tree-row.selected { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
.todo-tree-row.closed:not(.selected) { color: var(--text-3); }
.todo-tree-row.change.closed, .todo-tree-row.legacy.closed { opacity: .55; }
.todo-tree-toggle { color: var(--text-3); flex: 0 0 10px; font-size: var(--fs-xs); text-align: center; }
.todo-tree-toggle::before { content: "\25be"; }
.todo-tree-toggle.collapsed::before { content: "\25b8"; }
.todo-tree-toggle.empty { color: var(--text-4); }
.todo-tree-toggle.empty:not(.collapsed)::before { content: ""; }
.todo-tree-status { border-radius: 50%; box-sizing: border-box; display: inline-block; flex: none; height: 8px; margin-right: 7px; width: 8px; }
.todo-tree-status.status-queue { border: 1.5px solid var(--text-3); }
.todo-tree-status.status-in_progress { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.todo-tree-status.status-review { background: var(--tree-review); }
.todo-tree-status.status-done { background: var(--success); }
.todo-tree-status.status-backlog { border: 1.5px dashed var(--text-4); }
.todo-tree-title { align-items: center; display: flex; gap: 0; min-width: 0; overflow: hidden; white-space: nowrap; }
.todo-tree-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.todo-tree-plan { color: var(--text-4); flex: none; font: 400 var(--fs-xs) var(--mono); margin-left: 7px; }
.todo-tree-attention { background: var(--warn); border-radius: 50%; flex: none; height: 6px; margin-left: 7px; width: 6px; }
.todo-tree-number { color: var(--text-3); flex: none; font-family: var(--mono); margin-right: 5px; }
.todo-tree-row.selected .todo-tree-number { color: var(--accent); }
.todo-tree-time, .todo-tree-cost { color: var(--text-4); font-family: var(--mono); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.todo-tree-time.fresh { color: var(--text-2); }
.todo-tree-cost { color: var(--tree-cost); }
.todo-tree-row.group .todo-tree-title { color: var(--text); font-family: var(--mono); font-size: var(--fs-xs); font-weight: 600; }
.todo-tree-row.ungrouped .todo-tree-title { color: var(--text-4); font-family: var(--segoe); font-size: var(--fs-xs); font-weight: 600; letter-spacing: .09em; text-transform: uppercase; }
.todo-tree-row.change .todo-tree-title, .todo-tree-row.legacy .todo-tree-title { font-weight: 500; }
.todo-tree-row.change .todo-tree-number, .todo-tree-row.legacy .todo-tree-number { color: var(--theme); }
.todo-tree-bar { background: var(--track); bottom: 3px; height: 2px; left: calc(40px + var(--tree-indent)); overflow: hidden; position: absolute; right: 14px; }
.todo-tree-bar i { background: var(--theme); display: block; height: 100%; opacity: .7; }
</style>
