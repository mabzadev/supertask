<template>
  <span class="ab-text">{{ value }}</span>
</template>

<script>
import collectionField from '@supertask/modules/builder/mixins/collectionField'

export default {
  name: 'TextField',
  mixins: [collectionField],
  props: {
    value: {
      type: String,
      required: true,
    },
  },
}
</script>
