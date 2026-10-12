<script setup lang="ts">
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <button
    type="button"
    class="cu-toggle"
    :class="{ on: model }"
    role="checkbox"
    :aria-checked="model"
    @click="model = !model"
  ><i></i><slot /></button>
</template>
