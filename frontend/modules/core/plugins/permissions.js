export default defineNuxtPlugin({
  name: 'permissions',
  dependsOn: ['i18n', 'store'],
  async setup(nuxtApp) {
    // Supertask personal edition: all product features are enabled in the UI.
    // Server-side endpoints still enforce workspace membership and object access.
    nuxtApp.provide('hasPermission', () => true)
  },
})
