import { ApplicationType } from '@supertask/modules/core/applicationTypes'
import Sidebar from '@supertask/modules/whiteboards/components/Sidebar.vue'
import ApplicationContext from '@supertask/modules/whiteboards/components/ApplicationContext.vue'

export class WhiteboardApplicationType extends ApplicationType {
  static getType() { return 'whiteboard' }
  getIconClass() { return 'iconoir-whiteboard' }
  getName() { return this.app.$i18n.t('applicationType.whiteboard') }
  getNamePlural() { return this.app.$i18n.t('applicationType.whiteboards') }
  getDescription() { return this.app.$i18n.t('applicationType.whiteboardDesc') }
  getDefaultName() { return this.app.$i18n.t('applicationType.whiteboardDefaultName') }
  getSidebarComponent() { return Sidebar }
  getApplicationContextComponent() { return ApplicationContext }
  getTemplateSidebarComponent() { return null }
  getTemplatesPageComponent() { return null }
  getOrder() { return 35 }
  async select(application, { $router, $store }) {
    const canvases = await $store.dispatch('whiteboardCanvas/fetchAll', application.id)
    const canvas = canvases[0] || await $store.dispatch('whiteboardCanvas/create', {
      whiteboardId: application.id, values: { name: 'Premier canevas', template: 'blank' },
    })
    await $router.push({ name: 'whiteboard-canvas', params: { whiteboardId: application.id, canvasId: canvas.id } })
    return true
  }
}
