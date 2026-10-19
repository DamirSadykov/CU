<script setup lang="ts">
withDefaults(
    defineProps<{ tone?: "muted" | "theme" | "accent" }>(),
    { tone: "muted" },
);
</script>

<template>
    <span class="kicker" :class="`tone-${tone}`">
        <slot />
    </span>
</template>

<style scoped>
.kicker {
    font-family: var(--mono);
    font-size: var(--fs-11);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    line-height: var(--lh-11);
}
.kicker.tone-muted {
    color: var(--text-3);
}
.kicker.tone-theme {
    color: var(--theme);
}
.kicker.tone-accent {
    color: var(--accent);
}
</style>
