import { ApplicationType } from '@supertask/modules/core/applicationTypes'
import ApplicationContext from '@supertask/modules/dashboard/components/application/ApplicationContext'
import DashboardForm from '@supertask/modules/dashboard/components/form/DashboardForm'
import SidebarComponentDashboard from '@supertask/modules/dashboard/components/sidebar/SidebarComponentDashboard'
import DashboardTemplateSidebar from '@supertask/modules/dashboard/components/sidebar/DashboardTemplateSidebar'
import DashboardTemplate from '@supertask/modules/dashboard/components/DashboardTemplate'
import { DEVELOPMENT_STAGES } from '@supertask/modules/core/constants'
import { pageFinished } from '@supertask/modules/core/utils/routing'
import { nextTick } from '#imports'

export class DashboardApplicationType extends ApplicationType {
  static getType() {
    return 'dashboard'
  }

  getIconClass() {
    return 'supertask-icon-dashboard'
  }

  getName() {
    const { $i18n: i18n } = this.app
    return i18n.t('applicationType.dashboard')
  }

  getNamePlural() {
    const { $i18n: i18n } = this.app
    return i18n.t('applicationType.dashboards')
  }

  getDescription() {
    const { $i18n: i18n } = this.app
    return i18n.t('applicationType.dashboardDesc')
  }

  getDefaultName() {
    const { $i18n: i18n } = this.app
    return i18n.t('applicationType.dashboardDefaultName')
  }

  supportsTrash() {
    return false
  }

  getApplicationContextComponent() {
    return ApplicationContext
  }

  getApplicationFormComponent() {
    return DashboardForm
  }

  getSidebarComponent() {
    return SidebarComponentDashboard
  }

  getTemplateSidebarComponent() {
    return DashboardTemplateSidebar
  }

  getTemplatesPageComponent() {
    return DashboardTemplate
  }

  getTemplatePage(application) {
    return {
      dashboard: application,
    }
  }

  delete(application, { $router }) {
    $router.push({ name: 'dashboard' })
  }

  async select(application, { $router }) {
    try {
      await $router.push({
        name: 'dashboard-application',
        params: {
          dashboardId: application.id,
        },
      })
      await pageFinished()
      await nextTick()
    } catch (error) {
      if (error.name !== 'NavigationDuplicated') {
        throw error
      }
    }
  }

  get developmentStage() {
    return DEVELOPMENT_STAGES.BETA
  }

  getOrder() {
    return 80
  }
}
