<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { formatRef } from "../../scripts/cli/kernel/terms.mjs";

export interface BoardCrumbPath {
  project: string | null;
  change: { number: number | null; title: string } | null;
  task: number | null;
}

const props = defineProps<{ path: BoardCrumbPath }>();
const emit = defineEmits<{ (e: "project"): void; (e: "change"): void; (e: "task"): void }>();
const { t } = useI18n();
</script>

<template>
  <nav class="crumbs" :aria-label="t('todoBreadcrumbs')">
    <button type="button" class="crumb" :class="{ current: !props.path.change && props.path.task === null }" @click="emit('project')">{{ props.path.project || t('todoNoProject') }}</button>
    <template v-if="props.path.change">
      <span class="sep">›</span>
      <button type="button" class="crumb change" :class="{ current: props.path.task === null }" @click="emit('change')">{{ props.path.change.number === null ? "" : formatRef(props.path.change.number) }} {{ props.path.change.title }}</button>
    </template>
    <template v-if="props.path.task !== null">
      <span class="sep">›</span>
      <button type="button" class="crumb current" @click="emit('task')">#{{ props.path.task }}</button>
    </template>
    <slot />
  </nav>
</template>

<style scoped>
.crumbs { align-items: center; border-bottom: 1px solid var(--stroke); display: flex; flex: 0 0 30px; gap: 6px; min-height: 30px; min-width: 0; }
.crumb { background: transparent; border: 0; color: var(--text-3); cursor: pointer; font-family: var(--mono); font-size: var(--fs-11); font-weight: 600; letter-spacing: .06em; line-height: var(--lh-11); overflow: hidden; padding: 3px 0; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.crumb:hover { background: var(--layer); color: var(--text); }
.crumb.change { color: var(--theme); max-width: 45%; }
.crumb.current { color: var(--text); }
.sep { color: var(--text-3); }
</style>
