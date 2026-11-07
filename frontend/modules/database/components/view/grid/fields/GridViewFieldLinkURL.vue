<template>
  <div ref="cell" class="grid-view__cell">
    <div class="grid-field-text">
      <a
        v-if="selected && isValid(value)"
        :href="value && value.url"
        target="_blank"
        rel="nofollow noopener noreferrer"
      >
        {{ getLabelOrURL(value) }}
      </a>
      <u v-else-if="isValid(value)">
        {{ getLabelOrURL(value) }}
      </u>
      <span v-else>
        {{ getLabelOrURL(value) }}
      </span>
    </div>
  </div>
</template>

<script>
import gridField from '@supertask/modules/database/mixins/gridField'
import gridFieldInput from '@supertask/modules/database/mixins/gridFieldInput'
import linkURLField from '@supertask/modules/database/mixins/linkURLField'
export default {
  name: 'GridViewFieldLinkURL',
  mixins: [gridField, gridFieldInput, linkURLField],
}
</script>
