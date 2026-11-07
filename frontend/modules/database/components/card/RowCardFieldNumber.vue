<template>
  <div class="card-text">
    {{ formatValue(field, value) }}
  </div>
</template>

<script>
import numberField from '@supertask/modules/database/mixins/numberField'
import { formatDecimalNumber } from '@supertask/modules/database/utils/number'

export default {
  name: 'RowCardFieldNumber',
  height: 16,
  mixins: [numberField],
  props: {
    field: {
      type: Object,
      required: true,
    },
    value: {
      type: null,
      default: null,
    },
  },
  methods: {
    formatValue(field, value) {
      return formatDecimalNumber(field, value)
    },
  },
}
</script>
