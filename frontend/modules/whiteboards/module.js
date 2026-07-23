import { defineNuxtModule, addPlugin, createResolver, extendPages, addRouteMiddleware } from 'nuxt/kit'
import { locales } from '../../config/locales.js'

export default defineNuxtModule({
  meta: { name: 'whiteboards' },
  setup(options, nuxt) {
    const { resolve } = createResolver(import.meta.url)
    addPlugin(resolve('./plugin.js'))
    addRouteMiddleware({ name: 'selectWorkspaceWhiteboard', path: resolve('./middleware/selectWorkspaceWhiteboard.js') })
    extendPages((pages) => pages.push({
      name: 'whiteboard-canvas',
      path: '/whiteboard/:whiteboardId/canvas/:canvasId',
      file: resolve('./pages/canvas.vue'),
      meta: { layout: 'app', middleware: ['settings', 'authenticated', 'workspacesAndApplications', 'selectWorkspaceWhiteboard', 'pendingJobs'] },
    }))
    nuxt.hook('i18n:registerModule', (register) => register({ langDir: resolve('./locales'), locales }))
  },
})
