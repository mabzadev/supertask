import { defineNuxtPlugin } from '#app'
import { WhiteboardApplicationType } from '@supertask/modules/whiteboards/applicationTypes'
import whiteboardCanvasStore from '@supertask/modules/whiteboards/store/whiteboardCanvas'

export default defineNuxtPlugin({
  name: 'whiteboards',
  dependsOn: ['core', 'store'],
  setup(nuxtApp) {
    const context = { app: nuxtApp }
    nuxtApp.$store.registerModuleNuxtSafe('whiteboardCanvas', whiteboardCanvasStore)
    nuxtApp.$registry.register('application', new WhiteboardApplicationType(context))
  },
})
