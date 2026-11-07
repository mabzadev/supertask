import pkg from '../../../package.json'

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.provide('supertaskVersion', pkg.version)
})
