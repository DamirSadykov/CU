<script setup lang="ts">
withDefaults(
    defineProps<{
        id: string;
        title: string;
        count?: number | string;
        kind?: "task" | "spec";
    }>(),
    { kind: "task" },
);

const emit = defineEmits<{ (e: "click", event: MouseEvent): void }>();
</script>

<template>
    <div
        class="focus-row"
        :class="`kind-${kind}`"
        @click="emit('click', $event)"
    >
        <span class="focus-row-id">{{ id }}</span>
        <span class="focus-row-title">{{ title }}</span>
        <span v-if="count !== undefined" class="focus-row-count">
            {{ count }}
        </span>
    </div>
</template>

<style scoped>
.focus-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 4px 6px;
    border-radius: var(--r-ctl);
    cursor: pointer;
}
.focus-row:hover {
    background: color-mix(in srgb, var(--paper) 4%, transparent);
}
.focus-row-id {
    font-family: var(--mono);
    font-size: var(--fs-11);
    font-weight: 600;
    line-height: var(--lh-11);
    color: var(--text-2);
}
.focus-row.kind-spec .focus-row-id {
    color: var(--accent);
}
.focus-row-title {
    min-width: 0;
    font-size: var(--fs-12);
    line-height: var(--lh-12);
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.focus-row-count {
    font-family: var(--mono);
    font-size: var(--fs-12);
    line-height: var(--lh-12);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
}
</style>
