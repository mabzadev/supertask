export default defineNuxtPlugin((nuxtApp) => {
  const hasFeature = () => true

  nuxtApp.provide('hasFeature', hasFeature)
})
