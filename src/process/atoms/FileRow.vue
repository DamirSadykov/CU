<script setup lang="ts">
withDefaults(
    defineProps<{
        path: string;
        anchor?: string;
        exists?: boolean;
        note?: string;
    }>(),
    { exists: true },
);
</script>

<template>
    <div class="file-row" :class="{ missing: !exists }">
        <span class="file-row-mark">{{ exists ? "✓" : "✕" }}</span>
        <span class="file-row-path">{{ path }}</span>
        <span v-if="anchor" class="file-row-anchor">{{ anchor }}</span>
        <span v-if="anchor && note" class="file-row-sep">·</span>
        <span v-if="note" class="file-row-note">{{ note }}</span>
    </div>
</template>

<style scoped>
.file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-ctl);
    background: var(--node-bg);
}
.file-row-mark {
    flex: none;
    font-size: var(--fs-13);
    line-height: 1;
    color: var(--ok);
}
.file-row-path {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: var(--fs-11);
    font-weight: 600;
    line-height: var(--lh-11);
    color: var(--ok);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.file-row-anchor {
    flex: none;
    font-family: var(--mono);
    font-size: var(--fs-11);
    font-weight: 600;
    line-height: var(--lh-11);
    color: var(--text-3);
}
.file-row-sep {
    flex: none;
    font-size: var(--fs-12);
    line-height: var(--lh-12);
    color: var(--text-3);
}
.file-row-note {
    flex: none;
    font-size: var(--fs-12);
    line-height: var(--lh-12);
    color: var(--crit);
}
.file-row.missing {
    border-color: color-mix(in srgb, var(--crit) 35%, transparent);
    background: color-mix(in srgb, var(--crit) 6%, transparent);
}
.file-row.missing .file-row-mark,
.file-row.missing .file-row-path {
    color: var(--crit);
}
</style>
