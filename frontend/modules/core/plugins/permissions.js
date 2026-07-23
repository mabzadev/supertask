export default defineNuxtPlugin({
  name: 'permissions',
  dependsOn: ['i18n', 'store'],
  async setup(nuxtApp) {
    // OpenTabl personal edition: all product features are enabled in the UI.
    // Server-side endpoints still enforce workspace membership and object access.
    nuxtApp.provide('hasPermission', () => true)
  },
})
