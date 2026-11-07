<template>
  <div>
    <RowEditFieldMultipleSelect
      :read-only="true"
      :field="field"
      :value="value"
      :workspace-id="workspaceId"
    >
    </RowEditFieldMultipleSelect>
  </div>
</template>

<script>
import RowEditFieldMultipleSelect from '@supertask/modules/database/components/row/RowEditFieldMultipleSelect'
import baseField from '@supertask/modules/database/mixins/baseField'

export default {
  name: 'RowEditFieldMultipleSelectReadOnly',
  components: { RowEditFieldMultipleSelect },
  mixins: [baseField],
}
</script>
