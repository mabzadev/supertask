import { defineNuxtPlugin } from '#app'
import { WhiteboardApplicationType } from '@baserow/modules/whiteboards/applicationTypes'
import whiteboardCanvasStore from '@baserow/modules/whiteboards/store/whiteboardCanvas'

export default defineNuxtPlugin({
  name: 'whiteboards',
  dependsOn: ['core', 'store'],
  setup(nuxtApp) {
    const context = { app: nuxtApp }
    nuxtApp.$store.registerModuleNuxtSafe('whiteboardCanvas', whiteboardCanvasStore)
    nuxtApp.$registry.register('application', new WhiteboardApplicationType(context))
  },
})
