<template>
  <div class="context__form-container">
    <FieldSelectThroughFieldSubForm
      :fields="allFieldsInTable"
      :database="database"
      :default-values="defaultValues"
      @input="selectedThroughField = $event"
    ></FieldSelectThroughFieldSubForm>
    <FieldSelectTargetFieldSubForm
      :database="database"
      :table="table"
      :through-field="selectedThroughField"
      :default-values="defaultValues"
      :label="$t('fieldLookupSubForm.selectTargetFieldLabel')"
      @input="selectedTargetField = $event"
    ></FieldSelectTargetFieldSubForm>
    <template v-if="selectedTargetField">
      <FormulaTypeSubForms
        ref="subForm"
        :default-values="subFormDefaultValues"
        :formula-type="targetFieldFormulaType"
        :table="table"
        :view="view"
        :all-fields-in-table="allFieldsInTable"
        :database="database"
      >
      </FormulaTypeSubForms>
    </template>
  </div>
</template>

<script>
import form from '@supertask/modules/core/mixins/form'
import fieldSubForm from '@supertask/modules/database/mixins/fieldSubForm'
import lookupFieldSubForm from '@supertask/modules/database/mixins/lookupFieldSubForm'
import FormulaTypeSubForms from '@supertask/modules/database/components/formula/FormulaTypeSubForms'
import FieldSelectThroughFieldSubForm from '@supertask/modules/database/components/field/FieldSelectThroughFieldSubForm'
import FieldSelectTargetFieldSubForm from '@supertask/modules/database/components/field/FieldSelectTargetFieldSubForm'

export default {
  name: 'FieldLookupSubForm',
  components: {
    FieldSelectThroughFieldSubForm,
    FieldSelectTargetFieldSubForm,
    FormulaTypeSubForms,
  },
  mixins: [form, fieldSubForm, lookupFieldSubForm],
}
</script>
