<script setup lang="ts">
withDefaults(
    defineProps<{
        title: string;
        note?: string;
        size?: number;
    }>(),
    { size: 96 },
);

const emit = defineEmits<{ (e: "click", event: MouseEvent): void }>();
</script>

<template>
    <div
        class="cluster-bubble"
        :style="{ width: `${size}px`, height: `${size}px` }"
        @click="emit('click', $event)"
    >
        <span class="cluster-title">{{ title }}</span>
        <span v-if="note" class="cluster-note">{{ note }}</span>
    </div>
</template>

<style scoped>
.cluster-bubble {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 10px;
    border: 1px dashed color-mix(in srgb, var(--paper) 9%, transparent);
    border-radius: 50%;
    background: color-mix(in srgb, var(--paper) 2%, transparent);
    text-align: center;
    cursor: pointer;
}
.cluster-title {
    font-family: var(--mono);
    font-size: var(--fs-11);
    font-weight: 600;
    line-height: var(--lh-11);
    color: var(--text-3);
}
.cluster-note {
    font-size: var(--fs-12);
    line-height: var(--lh-12);
    color: var(--text-3);
}
</style>
