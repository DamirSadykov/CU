<script setup lang="ts">
withDefaults(
    defineProps<{
        slug: string;
        title?: string;
        badge?: string;
        badgeTone?: "muted" | "spec" | "theme" | "ok" | "warn";
        count?: number | string;
        active?: boolean;
        marked?: boolean;
    }>(),
    {
        title: "",
        badge: "",
        badgeTone: "muted",
        active: false,
        marked: false,
    },
);

const emit = defineEmits<{ (e: "click", event: MouseEvent): void }>();
</script>

<template>
    <button
        type="button"
        class="spec-tree-item"
        :class="{ active }"
        @click="emit('click', $event)"
    >
        <span class="spec-tree-head">
            <i v-if="marked" class="spec-tree-dot" />
            <span class="spec-tree-slug">{{ slug }}</span>
            <span class="spec-tree-gap" />
            <span
                v-if="badge"
                class="spec-tree-badge"
                :class="`tone-${badgeTone}`"
                >{{ badge }}</span
            >
            <span v-if="count !== undefined" class="spec-tree-count">{{
                count
            }}</span>
        </span>
        <span v-if="title" class="spec-tree-title">{{ title }}</span>
    </button>
</template>

<style scoped>
.spec-tree-item {
    display: block;
    width: 100%;
    padding: 6px 10px 7px;
    border: 0;
    border-left: 2px solid transparent;
    border-radius: 0 var(--r-ctl) var(--r-ctl) 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
}
.spec-tree-item:hover {
    background: color-mix(in srgb, var(--paper) 4%, transparent);
}
.spec-tree-item.active {
    background: var(--accent-soft);
    border-left-color: var(--accent);
}
.spec-tree-head {
    display: flex;
    align-items: center;
    gap: 6px;
}
.spec-tree-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--theme);
}
.spec-tree-slug {
    min-width: 0;
    font-family: var(--mono);
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.spec-tree-gap {
    flex: 1;
}
.spec-tree-badge {
    flex: none;
    padding: 1px 7px;
    border-radius: var(--r-pill);
    font-size: var(--fs-xs);
    line-height: 1.4;
    white-space: nowrap;
}
.spec-tree-badge.tone-muted {
    background: color-mix(in srgb, var(--paper) 6%, transparent);
    color: var(--text-3);
}
.spec-tree-badge.tone-spec {
    background: color-mix(in srgb, var(--next) 12%, transparent);
    color: var(--accent);
}
.spec-tree-badge.tone-theme {
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    color: var(--theme);
}
.spec-tree-badge.tone-ok {
    background: color-mix(in srgb, var(--ok) 12%, transparent);
    color: var(--ok);
}
.spec-tree-badge.tone-warn {
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    color: var(--warn);
}
.spec-tree-count {
    flex: none;
    min-width: 18px;
    padding: 1px 5px;
    border-radius: var(--r-pill);
    background: color-mix(in srgb, var(--paper) 7%, transparent);
    color: var(--text-3);
    font-family: var(--mono);
    font-size: var(--fs-xs);
    text-align: center;
}
.spec-tree-item.active .spec-tree-count {
    background: color-mix(in srgb, var(--next) 18%, transparent);
    color: var(--accent);
}
.spec-tree-title {
    display: block;
    margin-top: 2px;
    font-size: var(--fs-xs);
    line-height: 1.35;
    color: var(--text-4);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
</style>
