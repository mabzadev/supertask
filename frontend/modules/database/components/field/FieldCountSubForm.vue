<template>
  <div>
    <FieldSelectThroughFieldSubForm
      :fields="allFieldsInTable"
      :database="database"
      :default-values="defaultValues"
    ></FieldSelectThroughFieldSubForm>
  </div>
</template>

<script>
import form from '@supertask/modules/core/mixins/form'
import fieldSubForm from '@supertask/modules/database/mixins/fieldSubForm'
import FieldSelectThroughFieldSubForm from '@supertask/modules/database/components/field/FieldSelectThroughFieldSubForm'

export default {
  name: 'FieldCountSubForm',
  components: { FieldSelectThroughFieldSubForm },
  mixins: [form, fieldSubForm],
  data() {
    return {
      allowedValues: [],
      values: {},
    }
  },
}
</script>
