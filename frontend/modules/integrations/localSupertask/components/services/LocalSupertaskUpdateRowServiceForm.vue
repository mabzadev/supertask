<template>
  <UpsertRowWorkflowActionForm enable-row-id v-bind="$attrs" />
</template>

<script>
import UpsertRowWorkflowActionForm from '@supertask/modules/integrations/localSupertask/components/services/LocalSupertaskUpsertRowServiceForm'

export default {
  name: 'LocalSupertaskUpdateRowServiceForm',
  components: { UpsertRowWorkflowActionForm },
}
</script>
