import { DashboardSearchType } from '@supertask/modules/dashboard/searchTypes'
import { searchTypeRegistry } from '@supertask/modules/core/search/types/registry'
import dashboardApplicationStore from '@supertask/modules/dashboard/store/dashboardApplication'
import { DashboardApplicationType } from '@supertask/modules/dashboard/applicationTypes'
import { SummaryWidgetType } from '@supertask/modules/dashboard/widgetTypes'

export default defineNuxtPlugin({
  name: 'dashboard',
  dependsOn: ['core', 'store'],
  async setup(nuxtApp) {
    const { $store, $registry } = nuxtApp
    const context = { app: nuxtApp }

    if (!$store.hasModule('dashboardApplication')) {
      $store.registerModuleNuxtSafe(
        'dashboardApplication',
        dashboardApplicationStore
      )
      $store.registerModuleNuxtSafe(
        'template/dashboardApplication',
        dashboardApplicationStore
      )
    }

    $registry.registerNamespace('dashboardWidget')
    $registry.register('application', new DashboardApplicationType(context))
    $registry.register('dashboardWidget', new SummaryWidgetType(context))

    searchTypeRegistry.register(new DashboardSearchType(context))
  },
})
