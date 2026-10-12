<script setup lang="ts" generic="T extends string">
import type { CuSegOption } from "./types";

defineProps<{ options: CuSegOption<T>[]; hemp?: boolean }>();
const model = defineModel<T>({ required: true });

function pick(option: CuSegOption<T>) {
  if (!option.disabled) model.value = option.value;
}
</script>

<template>
  <div class="cu-seg" :class="{ hemp }" role="radiogroup">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="radio"
      :aria-checked="model === o.value"
      :class="{ on: model === o.value }"
      :disabled="o.disabled"
      :title="o.title"
      @click="pick(o)"
    >{{ o.label }}</button>
  </div>
</template>
