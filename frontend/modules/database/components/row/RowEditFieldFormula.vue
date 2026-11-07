<template>
  <component :is="getComponent(field)" v-bind="$props" read-only></component>
</template>

<script>
import rowEditField from '@supertask/modules/database/mixins/rowEditField'
import RowEditFieldDateReadOnly from '@supertask/modules/database/components/row/RowEditFieldDateReadOnly'
import RowEditFieldLongText from '@supertask/modules/database/components/row/RowEditFieldLongText'
import RowEditFieldText from '@supertask/modules/database/components/row/RowEditFieldText'
import RowEditFieldBoolean from '@supertask/modules/database/components/row/RowEditFieldBoolean'
import RowEditFieldNumber from '@supertask/modules/database/components/row/RowEditFieldNumber'
import RowEditFieldSingleSelectReadOnly from '@supertask/modules/database/components/row/RowEditFieldSingleSelectReadOnly'
import RowEditFieldBlank from '@supertask/modules/database/components/row/RowEditFieldBlank'
import RowEditFieldArray from '@supertask/modules/database/components/row/RowEditFieldArray'

export default {
  name: 'RowEditFieldFormula',
  components: {
    RowEditFieldDateReadOnly,
    RowEditFieldText,
    RowEditFieldLongText,
    RowEditFieldBoolean,
    RowEditFieldNumber,
    RowEditFieldBlank,
    RowEditFieldArray,
    RowEditFieldSingleSelectReadOnly,
  },
  mixins: [rowEditField],
  methods: {
    getComponent(field) {
      const formulaType = this.$registry.get('formula_type', field.formula_type)
      return formulaType.getRowEditFieldComponent(field)
    },
  },
}
</script>
