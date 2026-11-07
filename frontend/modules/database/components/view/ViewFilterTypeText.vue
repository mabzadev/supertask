<template>
  <FormInput
    ref="input"
    v-model="copy"
    :error="v$.copy.$error"
    :disabled="disabled"
    :placeholder="placeholder"
    @input="delayedUpdate($event)"
    @keydown.enter="delayedUpdate($event.target.value, true)"
  >
  </FormInput>
</template>

<script>
import filterTypeInput from '@supertask/modules/database/mixins/filterTypeInput'

export default {
  name: 'ViewFilterTypeText',
  mixins: [filterTypeInput],
  setup: filterTypeInput.setup,
  methods: {
    focus() {
      this.$refs.input.focus()
    },
  },
}
</script>
