<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
    cost: string;
    share?: number;
    note?: string;
}>();

const fill = computed(() => {
    const value = props.share ?? 0;
    return `${Math.max(0, Math.min(1, value)) * 100}%`;
});
</script>

<template>
    <div class="cost-footer">
        <span class="cost-value">{{ cost }}</span>
        <span v-if="note" class="cost-note">{{ note }}</span>
        <span v-if="share !== undefined" class="cost-bar">
            <i :style="{ width: fill }" />
        </span>
    </div>
</template>

<style scoped>
.cost-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: color-mix(in srgb, var(--hard) 28%, transparent);
    border-radius: 0 0 8px 8px;
    font-family: var(--sans);
    font-size: var(--fs-13);
    line-height: var(--lh-13);
    font-variant-numeric: tabular-nums;
    color: var(--high);
}
.cost-value {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
}
.cost-note {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-3);
    font-size: var(--fs-12);
    line-height: var(--lh-12);
}
.cost-bar {
    flex: none;
    margin-left: auto;
    width: 44px;
    height: 4px;
    border-radius: 2px;
    background: var(--track);
    overflow: hidden;
}
.cost-bar i {
    display: block;
    height: 100%;
    background: var(--high);
}
</style>
