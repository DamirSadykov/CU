<script setup lang="ts">
withDefaults(
    defineProps<{
        active?: boolean;
        variant?: "default" | "pri" | "cost" | "warn" | "ghost" | "icon";
    }>(),
    { active: false, variant: "default" },
);

const emit = defineEmits<{ (e: "click", event: MouseEvent): void }>();
</script>

<template>
    <button
        type="button"
        class="tool-button"
        :class="[variant !== 'default' ? variant : '', { active }]"
        @click="emit('click', $event)"
    >
        <slot />
    </button>
</template>

<style scoped>
.tool-button {
    height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 11px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-ctl);
    background: var(--layer);
    color: var(--text-2);
    font-family: var(--sans);
    font-size: var(--fs-13);
    font-weight: 400;
    line-height: var(--lh-13);
    white-space: nowrap;
    cursor: pointer;
}
.tool-button:hover {
    background: var(--layer-hover);
}
.tool-button.active {
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--next) 45%, transparent);
    color: var(--accent);
}
.tool-button.pri {
    background: var(--accent);
    border-color: transparent;
    color: var(--on-accent);
    font-weight: 600;
}
.tool-button.pri:hover {
    background: var(--accent-2);
}
.tool-button.ghost {
    background: transparent;
}
.tool-button.ghost:hover {
    background: var(--layer-hover);
}
.tool-button.cost {
    color: var(--high);
    border-color: color-mix(in srgb, var(--ag-claude) 40%, transparent);
    background: color-mix(in srgb, var(--ag-claude) 10%, transparent);
    font-weight: 600;
}
.tool-button.warn {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 35%, transparent);
    background: color-mix(in srgb, var(--warn) 8%, transparent);
}
.tool-button.icon {
    padding: 0 9px;
}
</style>
