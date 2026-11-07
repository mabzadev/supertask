import { registerRealtimeEvents } from '@supertask/modules/dashboard/realtime'

export default defineNuxtPlugin({
  name: 'dashboard-realtime',
  dependsOn: ['realtime'],
  async setup(nuxtApp) {
    registerRealtimeEvents(nuxtApp.$realtime)
  },
})
