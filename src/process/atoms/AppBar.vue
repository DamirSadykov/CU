<script setup lang="ts">
defineProps<{ title?: string }>();
</script>

<template>
    <header class="app-bar">
        <h1 v-if="title">{{ title }}</h1>
        <slot name="modes" />
        <slot name="center" />
        <span class="app-bar-spacer" />
        <slot name="right" />
    </header>
</template>

<style scoped>
.app-bar {
    flex: none;
    height: 50px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    border-bottom: 1px solid var(--stroke);
}
.app-bar h1 {
    margin: 0;
    font-size: var(--fs-16);
    line-height: var(--lh-16);
    font-weight: 600;
}
.app-bar-spacer {
    flex: 1;
}
</style>
