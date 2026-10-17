<script setup lang="ts">
withDefaults(
    defineProps<{ icon?: string; tone?: "accent" | "warn" | "muted" }>(),
    { icon: "", tone: "accent" },
);
</script>

<template>
    <div class="hint-bar" :class="`tone-${tone}`">
        <span v-if="icon" class="hint-bar-icon">{{ icon }}</span>
        <span class="hint-bar-text">
            <slot />
        </span>
    </div>
</template>

<style scoped>
.hint-bar {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 9px 13px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    font-size: var(--fs-xs);
    line-height: 1.45;
}
.hint-bar-icon {
    flex: none;
    font-size: var(--fs-xs);
    line-height: 1;
}
.hint-bar-text {
    min-width: 0;
    color: var(--text-3);
}
.hint-bar.tone-accent {
    border-color: color-mix(in srgb, var(--next) 28%, transparent);
    background: color-mix(in srgb, var(--next) 6%, transparent);
}
.hint-bar.tone-accent .hint-bar-icon {
    color: var(--accent);
}
.hint-bar.tone-warn {
    border-color: color-mix(in srgb, var(--warn) 30%, transparent);
    background: color-mix(in srgb, var(--warn) 6%, transparent);
}
.hint-bar.tone-warn .hint-bar-icon {
    color: var(--warn);
}
.hint-bar.tone-muted {
    background: color-mix(in srgb, var(--paper) 3%, transparent);
}
</style>
