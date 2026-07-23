import { defineNuxtModule, addPlugin, createResolver, extendPages, addRouteMiddleware } from 'nuxt/kit'
import { routeDefinitions } from './routes'
import { locales } from '../../config/locales.js'

export default defineNuxtModule({
    meta: {
        name: 'documents',
    },
    setup(options, nuxt) {
        const { resolve } = createResolver(import.meta.url)

        addPlugin({
            src: resolve('./plugin.js'),
        })

        addRouteMiddleware({
            name: 'selectWorkspaceDocument',
            path: resolve('./middleware/selectWorkspaceDocument'),
        })

        extendPages((pages) => {
            routeDefinitions.forEach((route) => {
                pages.push({
                    name: route.name,
                    path: route.path,
                    file: resolve(route.componentFile),
                    meta: {
                        layout: 'app',
                        middleware: [
                            'settings',
                            'authenticated',
                            'workspacesAndApplications',
                            'selectWorkspaceDocument',
                            'pendingJobs',
                        ],
                    },
                })
            })
        })

        nuxt.hook('i18n:registerModule', (register) => {
            register({
                langDir: resolve('./locales'),
                locales,
            })
        })
    },
})
