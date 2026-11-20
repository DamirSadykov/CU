<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
    defineProps<{
        label: string;
        note: string;
        width?: number;
    }>(),
    { width: 206 },
);

const emit = defineEmits<{ (e: "click"): void }>();

const style = computed(() => ({ width: `${props.width}px` }));
</script>

<template>
    <button
        type="button"
        class="collapsed-card"
        :style="style"
        @click="emit('click')"
    >
        <b><span class="collapsed-caret">▸</span> {{ label }}</b>
        <span class="collapsed-note">{{ note }}</span>
    </button>
</template>

<style scoped>
.collapsed-card {
    box-sizing: border-box;
    display: block;
    padding: 12px;
    border: 1px dashed var(--stroke-strong);
    border-radius: 9px;
    background: color-mix(in srgb, var(--paper) 1.2%, transparent);
    color: var(--text-3);
    font-family: var(--sans);
    font-size: var(--fs-12);
    font-weight: 400;
    line-height: var(--lh-12);
    text-align: left;
    cursor: pointer;
}
.collapsed-card:hover {
    background: color-mix(in srgb, var(--paper) 3%, transparent);
}
.collapsed-card b {
    display: block;
    margin-bottom: 4px;
    color: var(--text-3);
    font-weight: 600;
    font-size: var(--fs-16);
    line-height: var(--lh-16);
}
.collapsed-caret {
    color: var(--text-3);
}
.collapsed-note {
    display: block;
}
</style>
