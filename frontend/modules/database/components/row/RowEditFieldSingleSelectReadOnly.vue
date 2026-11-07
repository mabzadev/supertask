<template>
  <RowEditFieldSingleSelect
    :read-only="true"
    :field="field"
    :value="value"
    :workspace-id="workspaceId"
  >
  </RowEditFieldSingleSelect>
</template>

<script>
import RowEditFieldSingleSelect from '@supertask/modules/database/components/row/RowEditFieldSingleSelect'
import baseField from '@supertask/modules/database/mixins/baseField'

export default {
  name: 'RowEditFieldSingleSelectReadOnly',
  components: { RowEditFieldSingleSelect },
  mixins: [baseField],
}
</script>
