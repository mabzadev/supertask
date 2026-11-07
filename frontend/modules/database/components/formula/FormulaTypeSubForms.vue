<template>
  <FieldNumberSubForm
    v-if="formulaType === 'number'"
    ref="subForm"
    :default-values="defaultValues"
    :table="table"
    :view="view"
    :primary="primary"
    :allow-set-number-negative="false"
    :all-fields-in-table="allFieldsInTable"
    :database="database"
  >
  </FieldNumberSubForm>
  <FieldDateSubForm
    v-else-if="['date', 'last_modified', 'created_on'].includes(formulaType)"
    ref="subForm"
    :default-values="defaultValues"
    :table="table"
    :view="view"
    :all-fields-in-table="allFieldsInTable"
    :database="database"
    :primary="primary"
  >
  </FieldDateSubForm>
  <FieldDurationSubForm
    v-else-if="formulaType === 'duration'"
    ref="subForm"
    :default-values="defaultValues"
    :table="table"
    :view="view"
    :all-fields-in-table="allFieldsInTable"
    :database="database"
    :primary="primary"
  >
  </FieldDurationSubForm>
</template>
<script>
import FieldNumberSubForm from '@supertask/modules/database/components/field/FieldNumberSubForm'
import FieldDateSubForm from '@supertask/modules/database/components/field/FieldDateSubForm'
import FieldDurationSubForm from '@supertask/modules/database/components/field/FieldDurationSubForm'
import form from '@supertask/modules/core/mixins/form'
import fieldSubForm from '@supertask/modules/database/mixins/fieldSubForm'

export default {
  name: 'FormulaTypeSubForms',
  components: {
    FieldNumberSubForm,
    FieldDateSubForm,
    FieldDurationSubForm,
  },
  mixins: [form, fieldSubForm],
  props: {
    table: {
      required: true,
      type: Object,
    },
    formulaType: {
      required: false,
      type: String,
      default: null,
    },
    defaultValues: {
      required: true,
      type: Object,
    },
  },
  data() {
    return {
      allowedValues: [],
      values: {},
    }
  },
  methods: {
    isDirty() {
      return this.$refs.subForm?.isDirty()
    },
  },
}
</script>
