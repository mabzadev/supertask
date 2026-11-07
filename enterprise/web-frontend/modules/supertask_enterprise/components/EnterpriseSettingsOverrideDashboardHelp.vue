<template>
  <DashboardHelp v-if="settings.show_supertask_help_request"></DashboardHelp>
</template>

<script>
import { mapGetters } from 'vuex'
import DashboardHelp from '@supertask/modules/core/components/dashboard/DashboardHelp'

export default {
  name: 'EnterpriseSettingsOverrideDashboardHelp',
  components: { DashboardHelp },
  computed: {
    ...mapGetters({
      settings: 'settings/get',
    }),
  },
}
</script>
