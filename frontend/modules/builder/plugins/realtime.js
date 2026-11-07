import { registerRealtimeEvents } from '@supertask/modules/builder/realtime'

export default defineNuxtPlugin({
  name: 'builder-realtime',
  dependsOn: ['realtime'],
  async setup(nuxtApp) {
    registerRealtimeEvents(nuxtApp.$realtime)
  },
})
