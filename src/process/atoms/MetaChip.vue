<script setup lang="ts">
withDefaults(
    defineProps<{
        text?: string;
        tone?:
            | "muted"
            | "theme"
            | "ok"
            | "warn"
            | "crit"
            | "spec"
            | "file"
            | "run";
        mono?: boolean;
    }>(),
    { text: "", tone: "muted", mono: false },
);
</script>

<template>
    <span class="meta-chip" :class="[`tone-${tone}`, { mono }]">
        <slot>{{ text }}</slot>
    </span>
</template>

<style scoped>
.meta-chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 7px;
    border-radius: var(--r-pill);
    font-size: var(--fs-13);
    line-height: var(--lh-13);
    white-space: nowrap;
}
.meta-chip.mono {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
}
.meta-chip.tone-muted {
    background: color-mix(in srgb, var(--paper) 6%, transparent);
    color: var(--text-3);
}
.meta-chip.tone-theme {
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    color: var(--theme);
}
.meta-chip.tone-ok,
.meta-chip.tone-file {
    background: color-mix(in srgb, var(--ok) 12%, transparent);
    color: var(--ok);
}
.meta-chip.tone-warn {
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    color: var(--warn);
}
.meta-chip.tone-crit {
    background: color-mix(in srgb, var(--crit) 12%, transparent);
    color: var(--crit);
}
.meta-chip.tone-spec {
    background: color-mix(in srgb, var(--next) 12%, transparent);
    color: var(--accent);
}
.meta-chip.tone-run {
    background: color-mix(in srgb, var(--ag-claude) 12%, transparent);
    color: var(--high);
}
</style>
