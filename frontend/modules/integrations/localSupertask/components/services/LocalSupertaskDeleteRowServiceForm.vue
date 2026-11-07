<template>
  <LocalSupertaskServiceForm
    ref="form"
    enable-row-id
    v-bind="$attrs"
    :enable-view-picker="false"
  />
</template>

<script>
import LocalSupertaskServiceForm from '@supertask/modules/integrations/localSupertask/components/services/LocalSupertaskServiceForm'

export default {
  name: 'LocalSupertaskDeleteRowServiceForm',
  components: {
    LocalSupertaskServiceForm,
  },
  methods: {
    isFormValid() {
      return this.$refs.form.isFormValid()
    },
  },
}
</script>
