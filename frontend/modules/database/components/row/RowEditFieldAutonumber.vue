<template>
  <div class="control__elements">
    {{ value }}
  </div>
</template>

<script>
import rowEditField from '@supertask/modules/database/mixins/rowEditField'

export default {
  mixins: [rowEditField],
}
</script>
