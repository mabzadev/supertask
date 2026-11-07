import { defineNuxtPlugin } from '#app'
import { DocumentApplicationType } from '@supertask/modules/documents/applicationTypes'
import documentPageStore from '@supertask/modules/documents/store/documentPage'

export default defineNuxtPlugin({
    name: 'documents',
    dependsOn: ['core', 'store'],
    setup(nuxtApp) {
        const { $registry, $store } = nuxtApp
        const context = { app: nuxtApp }

        $store.registerModuleNuxtSafe('documentPage', documentPageStore)
        $registry.register('application', new DocumentApplicationType(context))
    },
})
