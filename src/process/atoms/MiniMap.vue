<script setup lang="ts">
withDefaults(
    defineProps<{
        title: string;
        count?: string;
        points?: { x: number; y: number }[];
        viewport?: { x: number; y: number; w: number; h: number };
    }>(),
    { points: () => [] },
);
</script>

<template>
    <div class="mini-map">
        <div class="mini-map-head">
            <span class="mini-map-title">{{ title }}</span>
            <template v-if="count">
                <span class="mini-map-sep">·</span>
                <span class="mini-map-count">{{ count }}</span>
            </template>
        </div>
        <div class="mini-map-body">
            <i
                v-for="(p, i) in points"
                :key="i"
                class="mini-map-point"
                :style="{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }"
            />
            <div
                v-if="viewport"
                class="mini-map-viewport"
                :style="{
                    left: `${viewport.x * 100}%`,
                    top: `${viewport.y * 100}%`,
                    width: `${viewport.w * 100}%`,
                    height: `${viewport.h * 100}%`,
                }"
            />
        </div>
    </div>
</template>

<style scoped>
.mini-map {
    display: inline-block;
    padding: 8px 10px 10px;
    border: 1px solid var(--stroke-strong);
    border-radius: var(--r-card);
    background: color-mix(in srgb, var(--ink-1) 92%, transparent);
}
.mini-map-head {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-bottom: 7px;
    font-family: var(--mono);
    font-size: var(--fs-11);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    line-height: var(--lh-11);
    color: var(--text-3);
}
.mini-map-count {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
}
.mini-map-sep {
    opacity: 0.6;
}
.mini-map-body {
    position: relative;
    width: 215px;
    height: 96px;
}
.mini-map-point {
    position: absolute;
    width: 2px;
    height: 2px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--paper) 35%, transparent);
    transform: translate(-50%, -50%);
}
.mini-map-viewport {
    position: absolute;
    border: 1px solid var(--accent);
    background: var(--accent-soft);
}
</style>
