<template>
  <div class="control__elements">
    <div v-show="field.error" class="error">
      {{ field.error }}
    </div>
  </div>
</template>

<script>
import rowEditField from '@supertask/modules/database/mixins/rowEditField'
import rowEditFieldInput from '@supertask/modules/database/mixins/rowEditFieldInput'

export default {
  mixins: [rowEditField, rowEditFieldInput],
}
</script>
