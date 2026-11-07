<template>
  <FormGroup :error="touched && !valid">
    <FormTextarea
      ref="input"
      v-model="copy"
      :error="touched && !valid"
      :disabled="readOnly"
      :rows="5"
      @focus="select()"
      @blur="unselect()"
    />

    <template #error>
      {{ error }}
    </template>
  </FormGroup>
</template>

<script>
import FormTextarea from '@supertask/modules/core/components/FormTextarea.vue'
import rowEditField from '@supertask/modules/database/mixins/rowEditField'
import rowEditFieldInput from '@supertask/modules/database/mixins/rowEditFieldInput'

export default {
  components: { FormTextarea },
  mixins: [rowEditField, rowEditFieldInput],
}
</script>
