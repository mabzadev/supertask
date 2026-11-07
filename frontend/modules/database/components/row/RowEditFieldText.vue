<template>
  <FormGroup :error="touched && !valid">
    <FormInput
      ref="input"
      v-model="copy"
      size="large"
      :error="touched && !valid"
      :disabled="readOnly"
      @keyup.enter="$refs.input.blur()"
      @focus="select()"
      @blur="unselect()"
    />

    <template #error>
      <span v-show="touched && !valid">
        {{ error }}
      </span>
    </template>
  </FormGroup>
</template>

<script>
import rowEditField from '@supertask/modules/database/mixins/rowEditField'
import rowEditFieldInput from '@supertask/modules/database/mixins/rowEditFieldInput'

export default {
  mixins: [rowEditField, rowEditFieldInput],
}
</script>
